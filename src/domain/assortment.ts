import { defaultShadow } from "./defaults.js";
import type { AssortmentRow, Lighting, ProductSet, SceneItem } from "./types.js";

export function allRows(sets: ProductSet[]) {
  return sets.flatMap((set) => set.rows);
}

export function reconcileAssortment(input: {
  projectId: string;
  sets: ProductSet[];
  existing: SceneItem[];
  lighting: Lighting;
  createId: () => string;
}): SceneItem[] {
  const grouped = new Map<string, SceneItem[]>();
  for (const item of input.existing) {
    const list = grouped.get(item.assortmentRowId) ?? [];
    list.push(item);
    grouped.set(item.assortmentRowId, list);
  }

  const next: SceneItem[] = [];
  for (const set of input.sets) {
    for (const row of set.rows) {
      const current = grouped.get(row.id) ?? [];
      for (let index = 0; index < row.requiredQuantity; index += 1) {
        const kept = current[index];
        if (kept) {
          next.push({
            ...kept,
            projectId: input.projectId,
            assetId: row.role === "box" ? null : row.assetId,
            boxTemplateId: row.role === "box" ? set.boxTemplateId : null,
            rotationDeg: 0,
          });
        } else {
          next.push(blankItem(input.projectId, set, row, index, input.lighting, input.createId));
        }
      }
    }
  }
  return next;
}

function blankItem(
  projectId: string,
  set: ProductSet,
  row: AssortmentRow,
  index: number,
  lighting: Lighting,
  createId: () => string,
): SceneItem {
  const layer = row.role === "box" ? 10 : row.role === "full-size" ? 20 : row.role === "sample" ? 30 : 25;
  return {
    id: createId(),
    projectId,
    assortmentRowId: row.id,
    assetId: row.role === "box" ? null : row.assetId,
    boxTemplateId: row.role === "box" ? set.boxTemplateId : null,
    x: 0.5,
    y: 0.72,
    scale: 1,
    layer: layer + index,
    surface: `pedestal:${set.id}`,
    shadow: defaultShadow(lighting),
    visible: true,
    rotationDeg: 0,
  };
}

export function countByRow(items: SceneItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.assortmentRowId, (counts.get(item.assortmentRowId) ?? 0) + 1);
  }
  return counts;
}
