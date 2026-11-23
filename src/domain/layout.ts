import { reconcileAssortment } from "./assortment.js";
import { defaultShadow } from "./defaults.js";
import type { Lighting, ProductSet, Project, SceneItem } from "./types.js";

export type LayoutOptions = {
  spacing: "compact" | "comfortable" | "wide";
  sampleArrangement: "row" | "stack";
  hierarchy: "equal" | "center-emphasis";
  setOrder?: string[];
};

const GROUP_GAP = { compact: 0.02, comfortable: 0.0, wide: -0.02 } as const;
const SAMPLE_GAP = { compact: 0.045, comfortable: 0.064, wide: 0.09 } as const;

export function orderSets(sets: ProductSet[], order?: string[]) {
  const sorted = [...sets].sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName, "ko"));
  if (!order?.length) return sorted;
  const byId = new Map(sorted.map((set) => [set.id, set]));
  const used = new Set<string>();
  const next: ProductSet[] = [];
  for (const id of order) {
    const set = byId.get(id);
    if (!set || used.has(set.id)) continue;
    next.push(set);
    used.add(set.id);
  }
  for (const set of sorted) {
    if (!used.has(set.id)) next.push(set);
  }
  return next;
}

export function layoutScene(input: {
  project: Project;
  reflow: boolean;
  options?: Partial<LayoutOptions>;
  createId: () => string;
}): SceneItem[] {
  const options: LayoutOptions = {
    spacing: input.options?.spacing ?? "comfortable",
    sampleArrangement: input.options?.sampleArrangement ?? "row",
    hierarchy: input.options?.hierarchy ?? "equal",
    setOrder: input.options?.setOrder,
  };
  const reconciled = reconcileAssortment({
    projectId: input.project.id,
    sets: input.project.sets,
    existing: input.project.items,
    lighting: input.project.lighting,
    createId: input.createId,
  });
  const slots = placementSlots(input.project, options);
  return reconciled.map((item) => {
    const slot = slots.get(slotKey(item.assortmentRowId, indexInRow(reconciled, item)));
    if (!slot) return item;
    if (!input.reflow && input.project.items.some((existing) => existing.id === item.id)) {
      return item;
    }
    return {
      ...item,
      x: slot.x,
      y: slot.y,
      scale: slot.scale,
      layer: slot.layer,
      surface: slot.surface,
      shadow: defaultShadow(input.project.lighting),
      visible: true,
      rotationDeg: 0,
    };
  });
}

function indexInRow(items: SceneItem[], item: SceneItem) {
  return items.filter((candidate) => candidate.assortmentRowId === item.assortmentRowId).indexOf(item);
}

function slotKey(rowId: string, index: number) {
  return `${rowId}:${index}`;
}

function placementSlots(project: Project, options: LayoutOptions) {
  const sets = orderSets(project.sets, options.setOrder);
  const slots = new Map<string, { x: number; y: number; scale: number; layer: number; surface: string }>();
  const count = Math.max(sets.length, 1);
  const margin = 0.2 + GROUP_GAP[options.spacing];
  const baseline = Math.min(0.9, Math.max(0.45, 0.84 - project.pedestal.height - project.camera.topMargin));
  const emphasisIndex = Math.floor((count - 1) / 2);

  sets.forEach((set, setIndex) => {
    const center = count === 1 ? 0.5 : margin + ((1 - margin * 2) * setIndex) / (count - 1);
    const scale = options.hierarchy === "center-emphasis" && count > 1
      ? setIndex === emphasisIndex ? 1.06 : 0.94
      : 1;
    const surface = `pedestal:${set.id}`;
    const boxes = set.rows.filter((row) => row.role === "box");
    const full = set.rows.filter((row) => row.role === "full-size");
    const samples = set.rows.filter((row) => row.role === "sample");
    const others = set.rows.filter((row) => row.role === "other");

    placeRow(slots, boxes, {
      center,
      y: baseline - 0.035,
      scale,
      layer: 10,
      surface,
      gap: 0.02,
      stack: false,
    });
    placeRow(slots, full, {
      center,
      y: baseline,
      scale,
      layer: 20,
      surface,
      gap: SAMPLE_GAP[options.spacing] * 0.85,
      stack: false,
    });
    placeRow(slots, samples, {
      center,
      y: baseline + 0.045,
      scale,
      layer: 30,
      surface,
      gap: SAMPLE_GAP[options.spacing],
      stack: options.sampleArrangement === "stack",
    });
    placeRow(slots, others, {
      center: center + 0.04,
      y: baseline + 0.02,
      scale,
      layer: 24,
      surface,
      gap: 0.04,
      stack: false,
    });
  });
  return slots;
}

function placeRow(
  slots: Map<string, { x: number; y: number; scale: number; layer: number; surface: string }>,
  rows: { id: string; requiredQuantity: number }[],
  spec: { center: number; y: number; scale: number; layer: number; surface: string; gap: number; stack: boolean },
) {
  const instances = rows.flatMap((row) =>
    Array.from({ length: row.requiredQuantity }, (_, index) => ({ rowId: row.id, index })),
  );
  const total = instances.length;
  instances.forEach((instance, position) => {
    const x = spec.stack || total <= 1
      ? spec.center
      : spec.center + (position - (total - 1) / 2) * spec.gap;
    const y = spec.stack ? spec.y - position * 0.028 : spec.y;
    slots.set(slotKey(instance.rowId, instance.index), {
      x,
      y,
      scale: spec.scale,
      layer: spec.layer + position,
      surface: spec.surface,
    });
  });
}

export function visualSignature(items: SceneItem[]) {
  return items
    .map((item) => `${item.id}:${item.assortmentRowId}:${item.assetId ?? ""}:${item.x}:${item.y}:${item.scale}:${item.visible}`)
    .join("|");
}

export function lightingOf(project: { lighting: Lighting }) {
  return project.lighting;
}
