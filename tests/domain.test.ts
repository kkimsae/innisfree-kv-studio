import { describe, expect, it } from "vitest";
import { reconcileAssortment, countByRow } from "../src/domain/assortment.js";
import { assertUniformScale, ratiosMatch, sizeForHeight } from "../src/domain/aspect.js";
import { boxFacePixels, uprightPixelSize } from "../src/domain/box.js";
import { normalizedToPixel, sameRelativePoint } from "../src/domain/coords.js";
import { layoutScene } from "../src/domain/layout.js";
import { buildRenderPlan } from "../src/domain/plan.js";
import { applyOperations, countSignature, parseKoreanRevision, rowMap } from "../src/domain/revisions.js";
import { validateProject } from "../src/domain/validation.js";
import { DEFAULT_LIGHTING } from "../src/domain/defaults.js";
import { asset, item, project, row, template } from "./helpers.js";

const sets = [
  {
    id: "green",
    projectId: "p",
    displayName: "그린티",
    boxTemplateId: "box",
    visualEmphasis: "normal" as const,
    sortOrder: 0,
    rows: [
      row("g-box", "green", "box", 1, null, "그린티 박스"),
      row("g-full", "green", "full-size", 1, "full", "그린티 본품"),
      row("g-sample", "green", "sample", 3, "sample", "그린티 샘플"),
    ],
  },
  {
    id: "black",
    projectId: "p",
    displayName: "블랙티",
    boxTemplateId: "box",
    visualEmphasis: "normal" as const,
    sortOrder: 1,
    rows: [
      row("b-box", "black", "box", 1, null, "블랙티 박스"),
      row("b-full", "black", "full-size", 1, "full", "블랙티 본품"),
      row("b-sample", "black", "sample", 3, "sample", "블랙티 샘플"),
    ],
  },
];

function scene() {
  return [
    item({ id: "1", assortmentRowId: "g-box", boxTemplateId: "box", x: 0.32, layer: 10, surface: "pedestal:green" }),
    item({ id: "2", assortmentRowId: "g-full", assetId: "full", x: 0.32, layer: 20, surface: "pedestal:green" }),
    item({ id: "3", assortmentRowId: "g-sample", assetId: "sample", x: 0.26, layer: 30, surface: "pedestal:green" }),
    item({ id: "4", assortmentRowId: "g-sample", assetId: "sample", x: 0.32, layer: 31, surface: "pedestal:green" }),
    item({ id: "5", assortmentRowId: "g-sample", assetId: "sample", x: 0.38, layer: 32, surface: "pedestal:green" }),
    item({ id: "6", assortmentRowId: "b-box", boxTemplateId: "box", x: 0.7, layer: 10, surface: "pedestal:black" }),
    item({ id: "7", assortmentRowId: "b-full", assetId: "full", x: 0.7, layer: 20, surface: "pedestal:black" }),
    item({ id: "8", assortmentRowId: "b-sample", assetId: "sample", x: 0.64, layer: 30, surface: "pedestal:black" }),
    item({ id: "9", assortmentRowId: "b-sample", assetId: "sample", x: 0.7, layer: 31, surface: "pedestal:black" }),
    item({ id: "10", assortmentRowId: "b-sample", assetId: "sample", x: 0.76, layer: 32, surface: "pedestal:black" }),
  ];
}

describe("구색과 장면 인스턴스", () => {
  it("요구 수량과 같은 수의 인스턴스만 만들고 여분은 버립니다", () => {
    const first = reconcileAssortment({
      projectId: "p",
      sets,
      existing: [],
      lighting: DEFAULT_LIGHTING,
      createId: sequence(),
    });
    expect(first).toHaveLength(10);
    expect(countByRow(first).get("g-sample")).toBe(3);
    const withExtra = [...first, item({ id: "extra", assortmentRowId: "missing" })];
    const second = reconcileAssortment({
      projectId: "p",
      sets,
      existing: withExtra,
      lighting: DEFAULT_LIGHTING,
      createId: sequence(),
    });
    expect(second).toHaveLength(10);
    expect(second.some((entry) => entry.id === "extra")).toBe(false);
    expect(second.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));
    const reduced = structuredClone(sets);
    reduced[0].rows[2].requiredQuantity = 2;
    const third = reconcileAssortment({
      projectId: "p",
      sets: reduced,
      existing: second,
      lighting: DEFAULT_LIGHTING,
      createId: sequence(),
    });
    expect(third.filter((entry) => entry.assortmentRowId === "g-sample")).toHaveLength(2);
  });

  it("배치도 구색 수량을 넘기지 않습니다", () => {
    const current = project(sets, []);
    const laid = layoutScene({ project: current, reflow: true, createId: sequence() });
    expect(laid.filter((entry) => entry.assortmentRowId === "g-sample")).toHaveLength(3);
    expect(laid.filter((entry) => entry.assortmentRowId === "b-sample")).toHaveLength(3);
    expect(new Set(laid.map((entry) => entry.assortmentRowId)).size).toBe(6);
  });
});

describe("검증", () => {
  it("알 수 없거나 초과한 제품 인스턴스를 거절합니다", () => {
    const assets = new Map([["full", asset({ id: "full" })], ["sample", asset({ id: "sample", pixelWidth: 40, pixelHeight: 40, physicalHeightMm: 40 })]]);
    const templates = new Map([["box", template({ id: "box" })]]);
    const extra = validateProject({
      project: project(sets, [...scene(), item({ id: "rogue", assortmentRowId: "nope", assetId: "full" })]),
      assets,
      templates,
    });
    expect(extra.errors.some((issue) => issue.code === "unknown-instance")).toBe(true);
    const tooMany = scene();
    tooMany.push(item({ id: "11", assortmentRowId: "g-sample", assetId: "sample", x: 0.44 }));
    const overflow = validateProject({ project: project(sets, tooMany), assets, templates });
    expect(overflow.errors.some((issue) => issue.code === "quantity")).toBe(true);
    expect(overflow.publicationGuarantee).toBe(false);
  });

  it("제품 비율과 박스 치수를 유지합니다", () => {
    const sized = sizeForHeight(40, 80, 100);
    expect(sized.width / sized.height).toBeCloseTo(0.5, 6);
    expect(assertUniformScale(1.2)).toBe(1.2);
    expect(() => assertUniformScale({ x: 1, y: 2 })).toThrow(/하나의 숫자/);
    const faces = boxFacePixels({ widthMm: 80, heightMm: 120, depthMm: 40 }, 2, 1);
    expect(ratiosMatch(faces.front.width / faces.front.height, 80 / 120)).toBe(true);
    expect(ratiosMatch(faces.side.width / faces.side.height, 40 / 120)).toBe(true);
    expect(ratiosMatch(faces.top.width / faces.top.height, 80 / 40)).toBe(true);
    const assets = new Map([["full", asset({ id: "full" })], ["sample", asset({ id: "sample", physicalHeightMm: 40 })]]);
    const templates = new Map([["box", template({ id: "box" })]]);
    const plan = buildRenderPlan({ project: project(sets, scene()), assets, templates });
    expect(plan.width).toBe(1280);
    expect(plan.height).toBe(720);
    const product = plan.items.find((entry) => entry.id === "2");
    expect(product && ratiosMatch(product.displayWidth / product.displayHeight, 40 / 80)).toBe(true);
    const box = plan.items.find((entry) => entry.id === "1");
    expect(box?.boxFaces && ratiosMatch(box.boxFaces.front.width / box.boxFaces.front.height, 80 / 120)).toBe(true);
    const anchor = plan.items.find((entry) => entry.id === "2");
    expect(anchor && Math.abs(anchor.anchorX - normalizedToPixel(0.32, 1280)) < 0.001).toBe(true);
  });
});

describe("좌표", () => {
  it("출력 크기가 달라도 상대 위치는 같습니다", () => {
    expect(normalizedToPixel(0.25, 1920)).toBe(480);
    expect(normalizedToPixel(0.25, 1280)).toBe(320);
    expect(sameRelativePoint(0.25, 1920, 1280)).toBe(true);
  });
});

describe("수정 범위", () => {
  const rows = rowMap(sets);
  const base = () => ({
    items: scene(),
    lighting: structuredClone(DEFAULT_LIGHTING),
    pedestal: { shape: "plank" as const, arrangement: "per-set" as const, height: 0.07, color: "#e4ddd2" },
    camera: { topMargin: 0.06 },
    backgroundAssetId: "bg",
    backgroundLocked: true,
    backgroundGenerated: false,
    selectedConceptId: null,
  });

  it("다섯 가지 예시 문장은 요청한 속성만 바꿉니다", () => {
    const brightness = parseKoreanRevision("제품 배치는 유지하고 배경만 조금 밝게 해줘.", sets.map(brief));
    const bright = applyOperations(base(), brightness.operations, rows);
    expect(bright.state.items).toEqual(base().items);
    expect(bright.state.lighting.backgroundBrightness).toBeGreaterThan(1);
    expect(bright.state.backgroundAssetId).toBe("bg");

    const move = parseKoreanRevision("그린티 세트를 중앙으로 옮겨줘.", sets.map(brief));
    const moved = applyOperations(base(), move.operations, rows);
    const green = moved.state.items.filter((entry) => entry.assortmentRowId.startsWith("g-"));
    const black = moved.state.items.filter((entry) => entry.assortmentRowId.startsWith("b-"));
    expect(average(green.map((entry) => entry.x))).toBeCloseTo(0.5, 5);
    expect(black.map((entry) => entry.x)).toEqual(base().items.filter((entry) => entry.assortmentRowId.startsWith("b-")).map((entry) => entry.x));
    expect(moved.state.items.map((entry) => entry.scale)).toEqual(base().items.map((entry) => entry.scale));
    expect(countSignature(moved.state.items)).toEqual(countSignature(base().items));

    const spacing = parseKoreanRevision("블랙티 샘플 3개가 전부 보이도록 간격을 넓혀줘.", sets.map(brief));
    const spaced = applyOperations(base(), spacing.operations, rows);
    const beforeGap = gap(base().items.filter((entry) => entry.assortmentRowId === "b-sample"));
    const afterGap = gap(spaced.state.items.filter((entry) => entry.assortmentRowId === "b-sample"));
    expect(afterGap).toBeGreaterThan(beforeGap);
    expect(spaced.state.items.filter((entry) => entry.assortmentRowId !== "b-sample").map((entry) => entry.x)).toEqual(
      base().items.filter((entry) => entry.assortmentRowId !== "b-sample").map((entry) => entry.x),
    );
    expect(countSignature(spaced.state.items)).toEqual(countSignature(base().items));

    const framing = parseKoreanRevision("단상을 낮추고 상단 여백을 늘려줘.", sets.map(brief));
    const framed = applyOperations(base(), framing.operations, rows);
    expect(framed.state.pedestal.height).toBeLessThan(base().pedestal.height);
    expect(framed.state.camera.topMargin).toBeGreaterThan(base().camera.topMargin);
    expect(framed.state.items.every((entry, index) => entry.y > base().items[index].y)).toBe(true);
    expect(framed.state.items.map((entry) => entry.x)).toEqual(base().items.map((entry) => entry.x));
    expect(framed.state.items.map((entry) => entry.scale)).toEqual(base().items.map((entry) => entry.scale));
    expect(framed.state.backgroundAssetId).toBe("bg");

    const keep = parseKoreanRevision("박스와 본품 비율은 유지해줘.", sets.map(brief));
    const kept = applyOperations(base(), keep.operations, rows);
    expect(kept.state).toEqual(base());
  });
});

function brief(set: { id: string; displayName: string }) {
  return { id: set.id, displayName: set.displayName };
}

function sequence() {
  let n = 0;
  return () => `id-${n++}`;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gap(items: { x: number }[]) {
  const xs = items.map((entry) => entry.x).sort((a, b) => a - b);
  return xs[xs.length - 1] - xs[0];
}
