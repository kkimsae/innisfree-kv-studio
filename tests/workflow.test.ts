import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { uprightPixelSize } from "../src/domain/box.js";
import { createApp } from "../src/server/app.js";
import { sha256File } from "../src/server/files.js";
import { extractRegion } from "../src/server/modules/pdf.js";
import { Store } from "../src/server/store.js";

const servers: Array<{ close: () => Promise<void>; dir: string }> = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (!server) break;
    await server.close();
    fs.rmSync(server.dir, { recursive: true, force: true });
  }
});

describe("PDF 면 방향", () => {
  it("90도 회전은 가로세로를 바꾸고 픽셀을 시계 방향으로 옮깁니다", async () => {
    expect(uprightPixelSize(60, 20, 90)).toEqual({ width: 20, height: 60 });
    const png = await sharp({
      create: { width: 60, height: 20, channels: 3, background: { r: 180, g: 20, b: 20 } },
    }).png().composite([{
      input: await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer(),
      left: 0,
      top: 0,
    }]).toBuffer();
    const turned = await extractRegion(png, { x: 0, y: 0, width: 1, height: 1 }, 90, { left: 0, top: 0, right: 0, bottom: 0 });
    const meta = await sharp(turned).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(60);
    const { data, info } = await sharp(turned).raw().toBuffer({ resolveWithObject: true });
    const corner = data.subarray((info.width - 1) * info.channels, (info.width - 1) * info.channels + 3);
    expect(corner[0]).toBeGreaterThan(240);
  });
});

describe("데모", () => {
  it("데모는 승인 아트워크로 보이지 않고 AI 결과를 만들지 않습니다", async () => {
    delete process.env.OPENAI_API_KEY;
    const { base } = await listen();
    const demo = await json(base, "/api/demo-project", { method: "POST", body: "{}" });
    expect(demo.bundle.project.demo).toBe(true);
    expect(demo.message).toContain("승인된 이니스프리 아트워크가 아닙니다");
    expect(demo.bundle.analysis).toBeNull();
    expect(demo.bundle.project.items.length).toBeGreaterThan(0);
  });
});

describe("저장과 전체 흐름", () => {
  it("프로젝트를 저장한 뒤 다시 엽니다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kv-store-"));
    const store = new Store(dir);
    const created = store.createProject({ id: "p1", name: "봄", campaignMonth: "2099-03", outputWidth: 1000, outputHeight: 600 });
    store.createSet({ id: "s1", projectId: created.id, displayName: "그린티" });
    store.close();
    const reopened = new Store(dir);
    const project = reopened.requireProject("p1");
    expect(project.name).toBe("봄");
    expect(project.sets[0]?.displayName).toBe("그린티");
    expect(project.outputWidth).toBe(1000);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("PDF를 가져와 박스를 확정하고, 수량대로 장면을 만든 뒤 배경만 바꾸고 다시 엽니다", async () => {
    delete process.env.OPENAI_API_KEY;
    const { base, store } = await listen();
    const created = await json(base, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "테스트 히어로", campaignMonth: "2099-04", outputWidth: 960, outputHeight: 540, brief: "픽스처" }),
    });
    const projectId = created.bundle.project.id as string;
    const pdf = await dielinePdf();
    const pdfAsset = await upload(base, "/api/assets", pdf, "fixture-dieline.pdf", "application/pdf");
    const rendered = await json(base, `/api/assets/${pdfAsset.asset.id}/pdf/render`, { method: "POST", body: "{}" });
    expect(rendered.pageCount).toBe(1);
    const template = await json(base, "/api/box-templates", {
      method: "POST",
      body: JSON.stringify({
        name: "픽스처 박스",
        widthMm: 80,
        heightMm: 120,
        depthMm: 40,
        sourceAssetId: pdfAsset.asset.id,
        sourcePage: 1,
        panels: [
          panel("front", 40, 280, 200, 280, 0),
          panel("side", 260, 280, 90, 280, 90),
          panel("top", 40, 580, 200, 90, 0),
        ],
      }),
    });
    expect(template.template.widthMm).toBe(80);
    expect(template.template.depthMm).toBe(40);
    const side = template.template.panels.find((entry: { panel: string }) => entry.panel === "side");
    const sideMeta = await sharp(store.absolute(side.imagePath)).metadata();
    expect(sideMeta.width).toBeGreaterThan(sideMeta.height ?? 0);

    const full = await productPng(80, 160);
    const sample = await productPng(40, 40);
    const fullAsset = await upload(base, "/api/assets", full, "fixture-full.png", "image/png");
    const sampleAsset = await upload(base, "/api/assets", sample, "fixture-sample.png", "image/png");
    const beforeHash = sha256File(store.absolute(fullAsset.asset.sourcePath));
    await json(base, `/api/assets/${fullAsset.asset.id}`, {
      method: "PATCH",
      body: JSON.stringify({ crop: { left: 0.05, top: 0, right: 0, bottom: 0, bottomAnchor: 1 }, physicalHeightMm: 150 }),
    });
    expect(sha256File(store.absolute(fullAsset.asset.sourcePath))).toBe(beforeHash);
    await json(base, `/api/assets/${sampleAsset.asset.id}`, {
      method: "PATCH",
      body: JSON.stringify({ physicalHeightMm: 40 }),
    });

    const withSet = await json(base, `/api/projects/${projectId}/sets`, {
      method: "POST",
      body: JSON.stringify({ displayName: "그린티" }),
    });
    const setId = withSet.bundle.project.sets[0].id as string;
    await json(base, `/api/sets/${setId}`, { method: "PATCH", body: JSON.stringify({ boxTemplateId: template.template.id }) });
    await json(base, `/api/sets/${setId}/rows`, { method: "POST", body: JSON.stringify({ productName: "픽스처 박스", role: "box", requiredQuantity: 1, capacity: "" }) });
    await json(base, `/api/sets/${setId}/rows`, { method: "POST", body: JSON.stringify({ productName: "픽스처 본품", role: "full-size", requiredQuantity: 1, assetId: fullAsset.asset.id, capacity: "예시" }) });
    await json(base, `/api/sets/${setId}/rows`, { method: "POST", body: JSON.stringify({ productName: "픽스처 샘플", role: "sample", requiredQuantity: 3, assetId: sampleAsset.asset.id, capacity: "예시" }) });
    const laid = await json(base, `/api/projects/${projectId}/scene/layout`, { method: "POST", body: JSON.stringify({ reflow: true }) });
    expect(laid.bundle.project.items).toHaveLength(5);
    expect(laid.bundle.project.items.filter((entry: { assortmentRowId: string }) => entry.assortmentRowId && laid.bundle.project.sets[0].rows.find((row: { id: string; role: string }) => row.id === entry.assortmentRowId && row.role === "sample"))).toHaveLength(3);

    await json(base, `/api/projects/${projectId}/render`, { method: "POST", body: "{}" });
    const subjectsBefore = fs.readFileSync(path.join(store.dataDir, "renders", projectId, "subjects.png"));
    const fullImage = await sharp(path.join(store.dataDir, "renders", projectId, "full.png")).metadata();
    expect(fullImage.width).toBe(960);
    expect(fullImage.height).toBe(540);
    const positions = laid.bundle.project.items.map((entry: { id: string; x: number; y: number; scale: number }) => ({ id: entry.id, x: entry.x, y: entry.y, scale: entry.scale }));

    const background = await sharp({ create: { width: 960, height: 540, channels: 3, background: { r: 20, g: 80, b: 90 } } }).png().toBuffer();
    await upload(base, `/api/projects/${projectId}/background`, background, "studio-backdrop.png", "image/png");
    const revised = await json(base, `/api/projects/${projectId}/revisions`, {
      method: "POST",
      body: JSON.stringify({ prompt: "제품 배치는 유지하고 배경만 조금 밝게 해줘." }),
    });
    expect(revised.bundle.project.items.map((entry: { id: string; x: number; y: number; scale: number }) => ({ id: entry.id, x: entry.x, y: entry.y, scale: entry.scale }))).toEqual(positions);
    expect(revised.bundle.project.lighting.backgroundBrightness).toBeGreaterThan(1);
    await json(base, `/api/projects/${projectId}/render`, { method: "POST", body: "{}" });
    const subjectsAfter = fs.readFileSync(path.join(store.dataDir, "renders", projectId, "subjects.png"));
    expect(Buffer.compare(subjectsBefore, subjectsAfter)).toBe(0);

    const validation = await json(base, `/api/projects/${projectId}/validate`, { method: "POST", body: "{}" });
    expect(validation.report.errors, JSON.stringify(validation.report.errors)).toEqual([]);
    expect(validation.report.publicationGuarantee).toBe(false);

    const exported = await fetch(`${base}/api/projects/${projectId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "png", acknowledgeLimits: true }),
    });
    expect(exported.ok).toBe(true);
    const pngMeta = await sharp(Buffer.from(await exported.arrayBuffer())).metadata();
    expect(pngMeta.width).toBe(960);
    expect(pngMeta.height).toBe(540);

    const packed = await fetch(`${base}/api/projects/${projectId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "package", acknowledgeLimits: true }),
    });
    expect(packed.ok).toBe(true);
    const restored = await upload(base, "/api/restore", Buffer.from(await packed.arrayBuffer()), "project.zip", "application/zip");
    expect(restored.bundle.project.items).toHaveLength(5);
    expect(restored.bundle.project.outputWidth).toBe(960);

    const again = new Store(store.dataDir);
    const reopened = again.requireProject(projectId);
    expect(reopened.items).toHaveLength(5);
    expect(reopened.backgroundAssetId).toBeTruthy();
    again.close();

    const missing = await fetch(`${base}/api/projects/${projectId}/analyze`, { method: "POST" });
    expect(missing.status).toBe(503);
    const body = await missing.json();
    expect(body.error).toBe("ai_not_configured");
    expect(body.details.requiredEnv).toContain("OPENAI_API_KEY");
  });
});

function panel(name: string, x: number, y: number, width: number, height: number, rotation: number) {
  const pageWidth = 600;
  const pageHeight = 800;
  return {
    panel: name,
    page: 1,
    x: x / pageWidth,
    y: (pageHeight - (y + height)) / pageHeight,
    width: width / pageWidth,
    height: height / pageHeight,
    rotation,
    inset: { left: 0, top: 0, right: 0, bottom: 0 },
    guidesEmbedded: false,
  };
}

async function dielinePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  page.drawRectangle({ x: 40, y: 280, width: 200, height: 280, color: rgb(0.75, 0.2, 0.18) });
  page.drawRectangle({ x: 260, y: 280, width: 90, height: 280, color: rgb(0.15, 0.25, 0.7) });
  page.drawRectangle({ x: 40, y: 580, width: 200, height: 90, color: rgb(0.2, 0.55, 0.3) });
  return Buffer.from(await pdf.save());
}

async function productPng(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 40, g: 90, b: 60, alpha: 1 } },
  }).png().toBuffer();
}

async function listen() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kv-app-"));
  const { app, store } = createApp(dir);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  servers.push({
    dir,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        store.close();
        if (error) reject(error);
        else resolve();
      });
    }),
  });
  return { base: `http://127.0.0.1:${address.port}`, store };
}

async function json(base: string, url: string, init: RequestInit) {
  const response = await fetch(`${base}${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${url} ${JSON.stringify(body)}`);
  return body;
}

async function upload(base: string, url: string, bytes: Buffer, filename: string, type: string) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type }), filename);
  const response = await fetch(`${base}${url}`, { method: "POST", body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${url} ${JSON.stringify(body)}`);
  return body;
}
