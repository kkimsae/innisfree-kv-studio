import { aspectRatio, croppedPixelSize, sizeForHeight } from "./aspect.js";
import { boxFacePixels, boxSpriteSize } from "./box.js";
import { normalizedToPixel } from "./coords.js";
import type { AssetRecord, BoxTemplate, ProductSet, Project, Role } from "./types.js";

export type PlanInput = {
  project: Project;
  assets: Map<string, AssetRecord>;
  templates: Map<string, BoxTemplate>;
};

export type BoxFacePlan = {
  front: { width: number; height: number };
  side: { width: number; height: number };
  top: { width: number; height: number };
  widthMm: number;
  heightMm: number;
  depthMm: number;
  spriteWidth: number;
  spriteHeight: number;
  frontWidth: number;
  frontHeight: number;
  screenSide: number;
  screenTop: number;
  lift: number;
};

export type PlacedItem = {
  id: string;
  setId: string;
  role: Role;
  name: string;
  assetId: string | null;
  boxTemplateId: string | null;
  layer: number;
  left: number;
  top: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  sourceWidth: number;
  sourceHeight: number;
  displayWidth: number;
  displayHeight: number;
  aspect: number;
  bottomAnchor: number;
  shadow: Project["items"][number]["shadow"];
  visible: boolean;
  boxFaces?: BoxFacePlan;
  missingAsset: boolean;
  unresolved: string[];
};

export type RenderPlan = {
  width: number;
  height: number;
  pxPerMm: number | null;
  items: PlacedItem[];
  unresolved: string[];
};

export function buildRenderPlan(input: PlanInput): RenderPlan {
  const { project } = input;
  const unresolved: string[] = [];
  const px = resolvePxPerMm(input, unresolved);
  const rowInfo = new Map<string, { setId: string; role: Role; name: string; assetId: string | null }>();
  for (const set of project.sets) {
    for (const row of set.rows) {
      rowInfo.set(row.id, { setId: set.id, role: row.role, name: row.productName, assetId: row.assetId });
    }
  }

  const items: PlacedItem[] = [];
  for (const item of project.items) {
    const row = rowInfo.get(item.assortmentRowId);
    const anchorX = normalizedToPixel(item.x, project.outputWidth);
    const anchorY = normalizedToPixel(item.y, project.outputHeight);
    if (!row) {
      unresolved.push("구색에 없는 장면 객체가 있습니다.");
      continue;
    }
    if (row.role === "box") {
      items.push(placeBox(item, row, anchorX, anchorY, px.pxPerMm, input, unresolved, project));
    } else {
      items.push(placeProduct(item, row, anchorX, anchorY, px.pxPerMm, input, unresolved, project));
    }
  }

  return {
    width: project.outputWidth,
    height: project.outputHeight,
    pxPerMm: px.pxPerMm,
    items,
    unresolved,
  };
}

function resolvePxPerMm(input: PlanInput, unresolved: string[]) {
  const heights: number[] = [];
  for (const set of input.project.sets) {
    const template = set.boxTemplateId ? input.templates.get(set.boxTemplateId) : undefined;
    if (template && template.heightMm > 0) heights.push(template.heightMm);
    for (const row of set.rows) {
      if (!row.assetId) continue;
      const asset = input.assets.get(row.assetId);
      if (asset?.physicalHeightMm && asset.physicalHeightMm > 0) heights.push(asset.physicalHeightMm);
    }
  }
  if (!heights.length) {
    unresolved.push("실측 높이가 없습니다. 용량으로 크기를 추정하지 않았고, 제품 키는 화면 높이의 임시 비율입니다.");
    return { pxPerMm: null as number | null };
  }
  return { pxPerMm: (input.project.outputHeight * 0.56) / Math.max(...heights) };
}

function placeBox(
  item: Project["items"][number],
  row: { setId: string; role: Role; name: string; assetId: string | null },
  anchorX: number,
  anchorY: number,
  pxPerMm: number | null,
  input: PlanInput,
  unresolved: string[],
  project: Project,
): PlacedItem {
  const template = item.boxTemplateId ? input.templates.get(item.boxTemplateId) : undefined;
  const notes: string[] = [];
  if (!template || !(template.widthMm > 0) || !(template.heightMm > 0) || !(template.depthMm > 0)) {
    notes.push(`${row.name}: 확정된 박스 치수가 없습니다.`);
    unresolved.push(notes[0]);
    const width = project.outputWidth * 0.12 * item.scale;
    const height = project.outputHeight * 0.28 * item.scale;
    return baseItem(item, row, anchorX, anchorY, width, height, width, height, 1, 1, true, notes);
  }
  const localPx = pxPerMm ?? (project.outputHeight * 0.42) / template.heightMm;
  if (!pxPerMm) notes.push(`${row.name}: 제품 실측이 없어 박스와 제품의 상대 크기는 확정이 아닙니다.`);
  const faces = boxFacePixels(template, localPx, item.scale);
  const sprite = boxSpriteSize(faces);
  const left = anchorX - sprite.frontWidth / 2;
  const top = anchorY - sprite.height;
  const placed = baseItem(item, row, anchorX, anchorY, sprite.width, sprite.height, faces.front.width, faces.front.height, 1, 1, false, notes);
  placed.left = left;
  placed.top = top;
  placed.boxFaces = {
    ...faces,
    widthMm: template.widthMm,
    heightMm: template.heightMm,
    depthMm: template.depthMm,
    spriteWidth: sprite.width,
    spriteHeight: sprite.height,
    frontWidth: sprite.frontWidth,
    frontHeight: sprite.frontHeight,
    screenSide: sprite.screenSide,
    screenTop: sprite.screenTop,
    lift: sprite.lift,
  };
  placed.aspect = faces.front.width / faces.front.height;
  if (!template.panels.some((panel) => panel.panel === "side" && (panel.imagePath || panel.replacementAssetId))) {
    notes.push(`${row.name}: 옆면 아트워크가 없습니다. 보이지 않는 면을 만들지 않습니다.`);
  }
  if (!template.panels.some((panel) => panel.panel === "top" && (panel.imagePath || panel.replacementAssetId))) {
    notes.push(`${row.name}: 윗면 아트워크가 없습니다.`);
  }
  placed.unresolved = notes;
  for (const note of notes) unresolved.push(note);
  return placed;
}

function placeProduct(
  item: Project["items"][number],
  row: { setId: string; role: Role; name: string; assetId: string | null },
  anchorX: number,
  anchorY: number,
  pxPerMm: number | null,
  input: PlanInput,
  unresolved: string[],
  project: Project,
): PlacedItem {
  const notes: string[] = [];
  const asset = item.assetId ? input.assets.get(item.assetId) : undefined;
  if (!asset || !(asset.pixelWidth && asset.pixelHeight)) {
    const message = `${row.name}: 원본 제품 이미지가 없습니다.`;
    notes.push(message);
    unresolved.push(message);
    const width = project.outputWidth * 0.08 * item.scale;
    const height = project.outputHeight * 0.2 * item.scale;
    return baseItem(item, row, anchorX, anchorY, width, height, width, height, 1, 1, true, notes);
  }
  const cropped = croppedPixelSize(asset.pixelWidth, asset.pixelHeight, asset.crop);
  let targetHeight: number;
  if (asset.physicalHeightMm && asset.physicalHeightMm > 0 && pxPerMm) {
    targetHeight = asset.physicalHeightMm * pxPerMm * item.scale;
  } else {
    targetHeight = project.outputHeight * 0.26 * item.scale;
    const message = `${row.name}: 실측 높이가 없어 임시 크기입니다. 용량으로 추정하지 않았습니다.`;
    notes.push(message);
    unresolved.push(message);
  }
  const sized = sizeForHeight(cropped.width, cropped.height, targetHeight);
  const bottomAnchor = asset.crop.bottomAnchor;
  const left = anchorX - sized.width / 2;
  const top = anchorY - sized.height * bottomAnchor;
  const placed = baseItem(
    item,
    row,
    anchorX,
    anchorY,
    sized.width,
    sized.height,
    cropped.width,
    cropped.height,
    bottomAnchor,
    aspectRatio(cropped.width, cropped.height),
    false,
    notes,
  );
  placed.left = left;
  placed.top = top;
  placed.displayWidth = sized.width;
  placed.displayHeight = sized.height;
  placed.aspect = sized.width / sized.height;
  return placed;
}

function baseItem(
  item: Project["items"][number],
  row: { setId: string; role: Role; name: string },
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  bottomAnchor: number,
  aspect: number,
  missingAsset: boolean,
  unresolved: string[],
): PlacedItem {
  return {
    id: item.id,
    setId: row.setId,
    role: row.role,
    name: row.name,
    assetId: item.assetId,
    boxTemplateId: item.boxTemplateId,
    layer: item.layer,
    left: anchorX - width / 2,
    top: anchorY - height * bottomAnchor,
    width,
    height,
    anchorX,
    anchorY,
    sourceWidth,
    sourceHeight,
    displayWidth: width,
    displayHeight: height,
    aspect,
    bottomAnchor,
    shadow: item.shadow,
    visible: item.visible,
    missingAsset,
    unresolved,
  };
}

export function setsById(sets: ProductSet[]) {
  return new Map(sets.map((set) => [set.id, set]));
}
