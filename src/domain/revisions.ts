import { clone } from "./defaults.js";
import type { Operation, ProductSet, Role, SceneItem, VisualState } from "./types.js";

export type RowRef = { setId: string; role: Role; productName: string };

export type ParseResult = {
  matched: boolean;
  operations: Operation[];
  notes: string[];
};

export function parseKoreanRevision(
  text: string,
  sets: { id: string; displayName: string }[],
): ParseResult {
  const raw = text.trim();
  const compact = raw.replace(/\s+/g, "");
  const notes: string[] = [];
  const operations: Operation[] = [];

  const mentionsBackground = compact.includes("배경");
  const mentionsBrightness = /밝|어둡/.test(compact);
  const mentionsMove = /옮겨|중앙|이동/.test(compact);
  const mentionsSpacing = compact.includes("간격");
  const mentionsPedestal = compact.includes("단상");
  const mentionsMargin = compact.includes("여백") || compact.includes("상단");
  const mentionsScale = compact.includes("비율");
  const recognized = mentionsBackground || mentionsMove || mentionsSpacing || mentionsPedestal || mentionsMargin || mentionsScale;
  if (!recognized) return { matched: false, operations: [], notes: [] };

  if (mentionsScale && compact.includes("유지")) operations.push({ op: "preserveScale" });

  if (mentionsBackground && mentionsBrightness) {
    const darker = compact.includes("어둡");
    const amount = compact.includes("많이") ? 0.28 : compact.includes("조금") ? 0.12 : 0.16;
    operations.push({ op: "adjustBackgroundBrightness", delta: darker ? -amount : amount });
  }

  const holdPlacement = (compact.includes("배치") && compact.includes("유지")) || compact.includes("배경만");
  if (holdPlacement || (mentionsBackground && mentionsBrightness && !mentionsMove && !mentionsSpacing && !mentionsPedestal && !mentionsMargin)) {
    operations.push({ op: "preservePlacement" });
  }

  if (compact.includes("중앙") && compact.includes("세트")) {
    const captured = raw.match(/([가-힣A-Za-z0-9]+)\s*세트/)?.[1];
    const set = resolveSet(captured, sets, raw);
    if (set) operations.push({ op: "moveSetToCenter", setId: set.id });
    else notes.push(`"${captured ?? "요청한"}" 세트를 현재 구색에서 찾지 못했습니다. 위치를 바꾸지 않았습니다.`);
  } else if (mentionsMove && !compact.includes("중앙")) {
    notes.push("세트를 중앙으로 모으는 요청만 문장으로 처리합니다. 그 밖의 위치는 미리보기에서 직접 옮기세요.");
  }

  if (mentionsSpacing && compact.includes("샘플") && /넓|벌/.test(compact)) {
    const captured = raw.match(/([가-힣A-Za-z0-9]+)\s*샘플/)?.[1];
    const set = resolveSet(captured, sets, raw);
    if (set) operations.push({ op: "expandSampleSpacing", setId: set.id, factor: 1.55 });
    else notes.push("간격을 넓힐 샘플 세트를 찾지 못했습니다. 수량은 바꾸지 않았습니다.");
  }

  if (mentionsPedestal && /낮|높/.test(compact)) {
    operations.push({ op: "nudgePedestalHeight", delta: compact.includes("낮") ? -0.03 : 0.03 });
  }

  if ((compact.includes("여백") || compact.includes("상단")) && /늘|줄/.test(compact)) {
    operations.push({ op: "nudgeTopMargin", delta: compact.includes("줄") ? -0.04 : 0.05 });
  }

  if (mentionsBackground && /바꿔|교체|다시만들|다시생성|새로만들|생성해/.test(compact)) {
    operations.push({ op: "regenerateBackground" });
  }

  return { matched: true, operations, notes };
}

function resolveSet(
  captured: string | undefined,
  sets: { id: string; displayName: string }[],
  raw: string,
) {
  if (captured) {
    const exact = sets.find((set) => normalize(set.displayName).includes(normalize(captured)) || normalize(captured).includes(normalize(set.displayName)));
    if (exact) return exact;
  }
  const compact = normalize(raw);
  const hits = sets
    .filter((set) => compact.includes(normalize(set.displayName)))
    .sort((a, b) => b.displayName.length - a.displayName.length);
  return hits[0] ?? null;
}

function normalize(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function applyOperations(
  state: VisualState,
  operations: Operation[],
  rows: Map<string, RowRef>,
): { state: VisualState; notes: string[] } {
  const next = clone(state);
  const originalItems = clone(state.items);
  const notes: string[] = [];
  const preserveScale = operations.some((operation) => operation.op === "preserveScale");
  const preservePlacement = operations.some((operation) => operation.op === "preservePlacement");

  for (const operation of operations) {
    if (operation.op === "adjustBackgroundBrightness") {
      next.lighting = {
        ...next.lighting,
        backgroundBrightness: clamp(next.lighting.backgroundBrightness + operation.delta, 0.45, 1.7),
      };
    } else if (operation.op === "moveSetToCenter") {
      const members = next.items.filter((item) => rows.get(item.assortmentRowId)?.setId === operation.setId);
      if (!members.length) {
        notes.push("이동할 세트 인스턴스가 없습니다.");
        continue;
      }
      const centroid = members.reduce((sum, item) => sum + item.x, 0) / members.length;
      const dx = 0.5 - centroid;
      for (const item of members) item.x += dx;
    } else if (operation.op === "expandSampleSpacing") {
      const note = expandSamples(next.items, operation.setId, operation.factor, rows);
      if (note) notes.push(note);
    } else if (operation.op === "nudgePedestalHeight") {
      const before = next.pedestal.height;
      const height = clamp(before + operation.delta, 0.02, 0.2);
      const applied = height - before;
      next.pedestal = { ...next.pedestal, height };
      for (const item of next.items) {
        if (item.surface.startsWith("pedestal")) item.y += -applied;
      }
    } else if (operation.op === "nudgeTopMargin") {
      const before = next.camera.topMargin;
      const topMargin = clamp(before + operation.delta, 0, 0.3);
      const applied = topMargin - before;
      next.camera = { ...next.camera, topMargin };
      for (const item of next.items) item.y += applied;
    }
  }

  if (preserveScale) {
    const scales = new Map(originalItems.map((item) => [item.id, item.scale]));
    for (const item of next.items) {
      const scale = scales.get(item.id);
      if (scale !== undefined) item.scale = scale;
    }
  }
  if (preservePlacement) {
    const places = new Map(originalItems.map((item) => [item.id, { x: item.x, y: item.y }]));
    for (const item of next.items) {
      const place = places.get(item.id);
      if (place) {
        item.x = place.x;
        item.y = place.y;
      }
    }
  }

  return { state: next, notes };
}

function expandSamples(items: SceneItem[], setId: string, factor: number, rows: Map<string, RowRef>) {
  const samples = items
    .filter((item) => {
      const row = rows.get(item.assortmentRowId);
      return row?.setId === setId && row.role === "sample";
    })
    .sort((a, b) => a.x - b.x || a.layer - b.layer);
  if (samples.length < 2) return "샘플이 2개 미만이라 간격을 바꾸지 않았습니다. 수량은 그대로입니다.";
  const centroid = samples.reduce((sum, item) => sum + item.x, 0) / samples.length;
  const gaps: number[] = [];
  for (let index = 1; index < samples.length; index += 1) gaps.push(samples[index].x - samples[index - 1].x);
  const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const gap = Math.min(0.22, Math.max(0.03, (average || 0.04) * factor));
  const start = centroid - ((samples.length - 1) * gap) / 2;
  samples.forEach((item, index) => {
    item.x = start + index * gap;
  });
  return null;
}

export function rowMap(sets: ProductSet[]) {
  const map = new Map<string, RowRef>();
  for (const set of sets) {
    for (const row of set.rows) {
      map.set(row.id, { setId: set.id, role: row.role, productName: row.productName });
    }
  }
  return map;
}

export function countSignature(items: SceneItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.assortmentRowId, (counts.get(item.assortmentRowId) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function itemsExceptPosition(items: SceneItem[]) {
  return items.map((item) => ({
    id: item.id,
    assortmentRowId: item.assortmentRowId,
    assetId: item.assetId,
    scale: item.scale,
    visible: item.visible,
    rotationDeg: item.rotationDeg,
  }));
}
