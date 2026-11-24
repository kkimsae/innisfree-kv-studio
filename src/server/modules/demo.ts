import fs from "node:fs";
import path from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";

GlobalFonts.registerFromPath(fileURLToPath(new URL("../../../fonts/NotoSansKR-Regular.otf", import.meta.url)), "NotoSansKR");
import sharp from "sharp";
import type { Store } from "../store.js";
import { sha256 } from "../files.js";
import { extractRegion, renderPdfPage } from "./pdf.js";

export const DEMO_LABEL = "데모 예시입니다. 승인된 이니스프리 아트워크가 아닙니다.";

export async function createDemoProject(store: Store) {
  const projectId = crypto.randomUUID();
  store.createProject({
    id: projectId,
    name: "데모 월간 히어로",
    campaignMonth: "2099-01",
    outputWidth: 1280,
    outputHeight: 720,
    brief: DEMO_LABEL,
    constraints: "합성 도형과 색면만 사용합니다. 제품명과 수량은 예시입니다.",
    demo: true,
  });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([720, 640]);
  page.drawRectangle({ x: 36, y: 180, width: 180, height: 280, color: rgb(0.72, 0.22, 0.2) });
  page.drawRectangle({ x: 230, y: 180, width: 80, height: 280, color: rgb(0.18, 0.28, 0.62) });
  page.drawRectangle({ x: 36, y: 470, width: 180, height: 80, color: rgb(0.22, 0.5, 0.32) });
  page.drawRectangle({ x: 400, y: 40, width: 280, height: 40, color: rgb(0.15, 0.15, 0.15) });
  const pdfBytes = Buffer.from(await pdf.save());
  const pdfAsset = await saveBuffer(store, pdfBytes, "demo-dieline.pdf", "pdf", true);
  const rendered = await renderPdfPage(store.absolute(pdfAsset.sourcePath), 1, 2);
  const pageRelative = `cache/pdf/${pdfAsset.id}/page-1.png`;
  const pageAbsolute = store.absolute(pageRelative);
  fs.mkdirSync(path.dirname(pageAbsolute), { recursive: true });
  fs.writeFileSync(pageAbsolute, rendered.png);
  const pageWidth = 720;
  const pageHeight = 640;
  const regions = {
    front: norm(36, 180, 180, 280, pageWidth, pageHeight),
    side: norm(230, 180, 80, 280, pageWidth, pageHeight),
    top: norm(36, 470, 180, 80, pageWidth, pageHeight),
  };
  const templateId = crypto.randomUUID();
  const panels = [];
  for (const [panel, region] of Object.entries(regions) as Array<[keyof typeof regions, typeof regions.front]>) {
    const image = await extractRegion(rendered.png, region, 0, { left: 0, top: 0, right: 0, bottom: 0 });
    const relative = `assets/${templateId}/panels/${panel}.png`;
    const absolute = store.absolute(relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, image);
    panels.push({
      panel,
      page: 1,
      ...region,
      rotation: 0 as const,
      inset: { left: 0, top: 0, right: 0, bottom: 0 },
      guidesEmbedded: false,
      replacementAssetId: null,
      imagePath: relative.split(path.sep).join("/"),
    });
  }
  const timestamp = new Date().toISOString();
  store.insertTemplate({
    id: templateId,
    name: "데모 박스 — 승인 아트 아님",
    widthMm: 70,
    heightMm: 120,
    depthMm: 35,
    sourceAssetId: pdfAsset.id,
    sourcePage: 1,
    panels,
    revision: 1,
    notes: DEMO_LABEL,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const green = await productPng("#2f6b4f", "DEMO\n본품");
  const sample = await productPng("#7ea48a", "DEMO\n샘플");
  const greenAsset = await saveBuffer(store, green, "demo-full.png", "product", true, 140);
  const sampleAsset = await saveBuffer(store, sample, "demo-sample.png", "product", true, 45);
  const greenSet = crypto.randomUUID();
  const blackSet = crypto.randomUUID();
  store.createSet({ id: greenSet, projectId, displayName: "그린티", boxTemplateId: templateId });
  store.createSet({ id: blackSet, projectId, displayName: "블랙티", boxTemplateId: templateId });
  store.createRow({ id: crypto.randomUUID(), setId: greenSet, productName: "데모 그린티 박스", role: "box", requiredQuantity: 1, capacity: "" });
  store.createRow({ id: crypto.randomUUID(), setId: greenSet, productName: "데모 그린티 본품", role: "full-size", requiredQuantity: 1, assetId: greenAsset.id, capacity: "예시 용량" });
  store.createRow({ id: crypto.randomUUID(), setId: greenSet, productName: "데모 그린티 샘플", role: "sample", requiredQuantity: 3, assetId: sampleAsset.id, capacity: "예시 용량" });
  store.createRow({ id: crypto.randomUUID(), setId: blackSet, productName: "데모 블랙티 박스", role: "box", requiredQuantity: 1, capacity: "" });
  store.createRow({ id: crypto.randomUUID(), setId: blackSet, productName: "데모 블랙티 본품", role: "full-size", requiredQuantity: 1, assetId: greenAsset.id, capacity: "예시 용량" });
  store.createRow({ id: crypto.randomUUID(), setId: blackSet, productName: "데모 블랙티 샘플", role: "sample", requiredQuantity: 2, assetId: sampleAsset.id, capacity: "예시 용량" });
  return projectId;
}

function norm(x: number, y: number, width: number, height: number, pageWidth: number, pageHeight: number) {
  return {
    x: x / pageWidth,
    y: (pageHeight - (y + height)) / pageHeight,
    width: width / pageWidth,
    height: height / pageHeight,
  };
}

async function productPng(color: string, label: string) {
  const canvas = createCanvas(280, 640);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 280, 640);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(70, 40, 140, 520, 70);
  ctx.fill();
  ctx.fillStyle = "#f7f4ee";
  ctx.fillRect(92, 150, 96, 180);
  ctx.fillStyle = "#1c1c1c";
  ctx.font = "28px NotoSansKR";
  ctx.textAlign = "center";
  label.split("\n").forEach((line, index) => ctx.fillText(line, 140, 220 + index * 36));
  const png = await canvas.encode("png");
  return sharp(png).png().toBuffer();
}

async function saveBuffer(
  store: Store,
  bytes: Buffer,
  filename: string,
  mediaType: "pdf" | "product",
  demo: boolean,
  physicalHeightMm: number | null = null,
) {
  const id = crypto.randomUUID();
  const ext = path.extname(filename) || ".bin";
  const relative = `assets/${id}/source${ext}`;
  const absolute = store.absolute(relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  let pixelWidth: number | null = null;
  let pixelHeight: number | null = null;
  let hasTransparency: boolean | null = null;
  if (mediaType !== "pdf") {
    const meta = await sharp(bytes).metadata();
    pixelWidth = meta.width ?? null;
    pixelHeight = meta.height ?? null;
    hasTransparency = Boolean(meta.hasAlpha);
  }
  return store.insertAsset({
    id,
    originalFilename: filename,
    sourcePath: relative,
    thumbnailPath: null,
    mediaType,
    packagingVersion: "demo",
    hasTransparency,
    pixelWidth,
    pixelHeight,
    physicalWidthMm: null,
    physicalHeightMm,
    physicalDepthMm: null,
    viewingAngle: "front",
    lightingNotes: DEMO_LABEL,
    crop: { left: 0, top: 0, right: 0, bottom: 0, bottomAnchor: 1 },
    sourceSha256: sha256(bytes),
    demoFixture: demo,
    createdAt: new Date().toISOString(),
  });
}
