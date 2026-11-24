import fs from "node:fs";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import type { AssetRecord, BoxTemplate, PanelId, PanelMapping, Project } from "../../domain/types.js";
import { buildRenderPlan, type PlanInput, type PlacedItem, type RenderPlan } from "../../domain/plan.js";

let fontReady = false;

function ensureFont() {
  if (fontReady) return;
  const fontPath = fileURLToPath(new URL("../../../fonts/NotoSansKR-Regular.otf", import.meta.url));
  GlobalFonts.registerFromPath(fontPath, "NotoSansKR");
  fontReady = true;
}

export type RenderLayers = {
  plan: RenderPlan;
  full: Buffer;
  background: Buffer;
  subjects: Buffer;
  shadow: Buffer;
};

export async function renderLayers(input: PlanInput, absolutePath: (relative: string) => string): Promise<RenderLayers> {
  ensureFont();
  const plan = buildRenderPlan(input);
  const background = await renderBackground(input.project, input.assets, absolutePath);
  const subjects = await renderSubjects(plan, input, absolutePath);
  const shadow = await renderShadows(plan);
  const pedestals = await renderPedestals(plan, input.project);
  const reflections = await renderReflections(plan, subjects.sprites);
  const full = await sharp(background)
    .composite([
      { input: pedestals, left: 0, top: 0 },
      { input: reflections, left: 0, top: 0 },
      { input: shadow, left: 0, top: 0 },
      { input: subjects.buffer, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
  return { plan, full, background, subjects: subjects.buffer, shadow };
}

async function renderBackground(project: Project, assets: Map<string, AssetRecord>, absolutePath: (relative: string) => string) {
  const width = project.outputWidth;
  const height = project.outputHeight;
  let base: Buffer;
  const asset = project.backgroundAssetId ? assets.get(project.backgroundAssetId) : undefined;
  if (!asset) {
    base = await sharp({
      create: { width, height, channels: 3, background: { r: 239, g: 234, b: 226 } },
    }).png().toBuffer();
  } else {
    base = await sharp(absolutePath(asset.sourcePath)).resize(width, height, { fit: "cover", position: "centre" }).png().toBuffer();
  }
  if (Math.abs(project.lighting.backgroundBrightness - 1) < 0.01) return base;
  return sharp(base).modulate({ brightness: project.lighting.backgroundBrightness }).png().toBuffer();
}

async function renderSubjects(plan: RenderPlan, input: PlanInput, absolutePath: (relative: string) => string) {
  const sprites: Array<{ item: PlacedItem; buffer: Buffer; left: number; top: number }> = [];
  const ordered = [...plan.items].filter((item) => item.visible).sort((a, b) => a.layer - b.layer);
  for (const item of ordered) {
    const buffer = item.role === "box"
      ? await renderBoxSprite(item, input, absolutePath)
      : await renderProductSprite(item, input, absolutePath);
    sprites.push({
      item,
      buffer,
      left: Math.round(item.left),
      top: Math.round(item.top),
    });
  }
  let base = await blank(plan.width, plan.height);
  if (sprites.length) {
    base = await sharp(base).composite(sprites.map((sprite) => ({ input: sprite.buffer, left: sprite.left, top: sprite.top }))).png().toBuffer();
  }
  return { buffer: base, sprites };
}

async function renderProductSprite(item: PlacedItem, input: PlanInput, absolutePath: (relative: string) => string) {
  const asset = item.assetId ? input.assets.get(item.assetId) : undefined;
  if (!asset || item.missingAsset) return placeholder(item);
  const source = absolutePath(asset.sourcePath);
  if (!fs.existsSync(source) || !asset.pixelWidth || !asset.pixelHeight) return placeholder(item);
  const left = clampInt(asset.crop.left * asset.pixelWidth, 0, asset.pixelWidth - 1);
  const top = clampInt(asset.crop.top * asset.pixelHeight, 0, asset.pixelHeight - 1);
  const width = clampInt(asset.pixelWidth - left - asset.crop.right * asset.pixelWidth, 1, asset.pixelWidth - left);
  const height = clampInt(asset.pixelHeight - top - asset.crop.bottom * asset.pixelHeight, 1, asset.pixelHeight - top);
  const heightPx = Math.max(1, Math.round(item.displayHeight));
  let pipeline = sharp(source);
  if (left !== 0 || top !== 0 || width !== asset.pixelWidth || height !== asset.pixelHeight) {
    pipeline = pipeline.extract({ left, top, width, height });
  }
  return pipeline.resize({ height: heightPx, fit: "inside", withoutEnlargement: false }).png().toBuffer();
}

async function renderBoxSprite(item: PlacedItem, input: PlanInput, absolutePath: (relative: string) => string) {
  if (!item.boxFaces) return placeholder(item);
  const template = item.boxTemplateId ? input.templates.get(item.boxTemplateId) : undefined;
  const front = await faceBuffer(template, "front", item.boxFaces.front.width, item.boxFaces.front.height, input, absolutePath);
  const side = await faceBuffer(template, "side", item.boxFaces.side.width, item.boxFaces.side.height, input, absolutePath);
  const top = await faceBuffer(template, "top", item.boxFaces.top.width, item.boxFaces.top.height, input, absolutePath);
  return drawBox(item, front, side, top);
}

async function faceBuffer(
  template: BoxTemplate | undefined,
  panelId: PanelId,
  width: number,
  height: number,
  input: PlanInput,
  absolutePath: (relative: string) => string,
) {
  const panel = template?.panels.find((candidate) => candidate.panel === panelId);
  const file = panelFile(panel, input, absolutePath);
  const targetWidth = Math.max(1, Math.round(width));
  const targetHeight = Math.max(1, Math.round(height));
  if (!file) return neutralFace(targetWidth, targetHeight, true);
  const resized = await sharp(file).resize({ width: targetWidth, height: targetHeight, fit: "inside" }).png().toBuffer();
  const meta = await sharp(resized).metadata();
  const left = Math.round((targetWidth - (meta.width ?? targetWidth)) / 2);
  const top = Math.round((targetHeight - (meta.height ?? targetHeight)) / 2);
  return sharp({
    create: { width: targetWidth, height: targetHeight, channels: 4, background: { r: 232, g: 226, b: 216, alpha: 1 } },
  }).composite([{ input: resized, left, top }]).png().toBuffer();
}

function panelFile(panel: PanelMapping | undefined, input: PlanInput, absolutePath: (relative: string) => string) {
  if (!panel) return null;
  if (panel.replacementAssetId) {
    const asset = input.assets.get(panel.replacementAssetId);
    if (asset && fs.existsSync(absolutePath(asset.sourcePath))) return absolutePath(asset.sourcePath);
  }
  if (panel.imagePath && fs.existsSync(absolutePath(panel.imagePath))) return absolutePath(panel.imagePath);
  return null;
}

async function neutralFace(width: number, height: number, labeled: boolean) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#d9d3c7";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#b7b0a4";
  ctx.lineWidth = Math.max(2, Math.round(width * 0.02));
  ctx.strokeRect(4, 4, width - 8, height - 8);
  if (labeled) {
    ctx.fillStyle = "#5c564e";
    ctx.font = `${Math.max(14, Math.round(Math.min(width, height) * 0.14))}px NotoSansKR`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("미확인 면", width / 2, height / 2);
  }
  return canvas.encode("png");
}

async function drawBox(item: PlacedItem, front: Buffer, side: Buffer, top: Buffer) {
  const box = item.boxFaces!;
  const width = Math.max(1, Math.ceil(box.spriteWidth));
  const height = Math.max(1, Math.ceil(box.spriteHeight));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const frontImage = await loadImage(front);
  const sideImage = await loadImage(side);
  const topImage = await loadImage(top);
  const screenTop = box.screenTop;
  const frontW = box.frontWidth;
  const frontH = box.frontHeight;
  const screenSide = box.screenSide;
  const lift = box.lift;
  drawImageAffine(ctx, topImage, { x: screenSide, y: screenTop - lift }, { x: frontW + screenSide, y: screenTop - lift }, { x: 0, y: screenTop });
  drawImageAffine(ctx, sideImage, { x: frontW, y: screenTop }, { x: frontW + screenSide, y: screenTop - lift }, { x: frontW, y: screenTop + frontH });
  drawImageAffine(ctx, frontImage, { x: 0, y: screenTop }, { x: frontW, y: screenTop }, { x: 0, y: screenTop + frontH });
  return canvas.encode("png");
}

function drawImageAffine(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  image: Awaited<ReturnType<typeof loadImage>>,
  topLeft: { x: number; y: number },
  topRight: { x: number; y: number },
  bottomLeft: { x: number; y: number },
) {
  const iw = image.width || 1;
  const ih = image.height || 1;
  ctx.save();
  ctx.setTransform(
    (topRight.x - topLeft.x) / iw,
    (topRight.y - topLeft.y) / iw,
    (bottomLeft.x - topLeft.x) / ih,
    (bottomLeft.y - topLeft.y) / ih,
    topLeft.x,
    topLeft.y,
  );
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

async function placeholder(item: PlacedItem) {
  const width = Math.max(24, Math.round(item.width));
  const height = Math.max(24, Math.round(item.height));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(255,255,255,0)";
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#8d8478";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, width - 4, height - 4);
  ctx.fillStyle = "#3f3a34";
  ctx.font = `${Math.max(12, Math.round(height * 0.08))}px NotoSansKR`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(item.name || "자산 없음", width / 2, height / 2);
  return canvas.encode("png");
}

async function renderShadows(plan: RenderPlan) {
  const canvas = createCanvas(plan.width, plan.height);
  const ctx = canvas.getContext("2d");
  for (const item of plan.items) {
    if (!item.visible) continue;
    const cx = item.anchorX + item.shadow.offsetX * plan.width;
    const cy = item.anchorY + item.shadow.offsetY * plan.height;
    const rx = Math.max(12, item.width * 0.34);
    const ry = Math.max(6, plan.height * item.shadow.blur);
    ctx.fillStyle = `rgba(48, 42, 34, ${Math.max(0, Math.min(0.7, item.shadow.opacity))})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.encode("png");
}

async function renderReflections(plan: RenderPlan, sprites: Array<{ item: PlacedItem; buffer: Buffer; left: number; top: number }>) {
  const overlays: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const sprite of sprites) {
    if (sprite.item.role === "box" || sprite.item.missingAsset) continue;
    const meta = await sharp(sprite.buffer).metadata();
    const sourceHeight = meta.height ?? 1;
    const reflectionHeight = Math.max(8, Math.round(sourceHeight * 0.18));
    const flipped = await sharp(sprite.buffer).flip().extract({
      left: 0,
      top: 0,
      width: meta.width ?? 1,
      height: Math.min(sourceHeight, reflectionHeight),
    }).png().toBuffer();
    const faded = await fade(flipped, 0.18);
    overlays.push({
      input: faded,
      left: sprite.left,
      top: Math.round(sprite.item.anchorY),
    });
  }
  const base = await blank(plan.width, plan.height);
  if (!overlays.length) return base;
  return sharp(base).composite(overlays).png().toBuffer();
}

async function fade(buffer: Buffer, alpha: number) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 3; index < data.length; index += 4) data[index] = Math.round(data[index] * alpha);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function renderPedestals(plan: RenderPlan, project: Project) {
  const color = /^#[0-9a-fA-F]{6}$/.test(project.pedestal.color) ? project.pedestal.color : "#e4ddd2";
  const groups = new Map<string, PlacedItem[]>();
  for (const item of plan.items) {
    const list = groups.get(item.setId) ?? [];
    list.push(item);
    groups.set(item.setId, list);
  }
  const clusters = project.pedestal.arrangement === "shared" ? [plan.items] : [...groups.values()];
  const shapes = clusters.filter((items) => items.length).map((items) => pedestalShape(items, project, color));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.width}" height="${plan.height}">${shapes.join("")}</svg>`;
  const raster = await sharp(Buffer.from(svg)).resize(plan.width, plan.height, { fit: "fill" }).png().toBuffer();
  return raster;
}

function pedestalShape(items: PlacedItem[], project: Project, color: string) {
  const left = Math.min(...items.map((item) => item.left));
  const right = Math.max(...items.map((item) => item.left + item.width));
  const anchor = items.reduce((sum, item) => sum + item.anchorY, 0) / items.length;
  const pedH = Math.max(12, project.pedestal.height * project.outputHeight);
  const cx = (left + right) / 2;
  const rx = Math.max(40, (right - left) / 2 + 28);
  const cy = anchor + pedH * 0.25;
  if (project.pedestal.shape === "rect") {
    const x = cx - rx;
    const y = anchor - pedH * 0.2;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(rx * 2).toFixed(1)}" height="${pedH.toFixed(1)}" rx="16" fill="${color}"/>`;
  }
  const ry = project.pedestal.shape === "plank" ? Math.max(8, pedH * 0.28) : Math.max(12, pedH * 0.45);
  return `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${color}"/>`;
}

async function blank(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();
}

function clampInt(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function planInput(project: Project, assets: AssetRecord[], templates: BoxTemplate[]): PlanInput {
  return {
    project,
    assets: new Map(assets.map((asset) => [asset.id, asset])),
    templates: new Map(templates.map((template) => [template.id, template])),
  };
}
