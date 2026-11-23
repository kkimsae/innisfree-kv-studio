import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import type { PanelRotation } from "../../domain/types.js";

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));

type RenderedPage = { png: Buffer; width: number; height: number; pageCount: number };

export async function renderPdfPage(pdfPath: string, pageNumber: number, scale = 2): Promise<RenderedPage> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    cMapUrl: path.join(pdfjsRoot, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfjsRoot, "standard_fonts") + path.sep,
    wasmUrl: path.join(pdfjsRoot, "wasm") + path.sep,
  } as Parameters<typeof getDocument>[0]);
  const document = await loadingTask.promise;
  const closable = document as typeof document & { destroy?: () => Promise<void> };
  if (pageNumber < 1 || pageNumber > document.numPages) {
    await closable.destroy?.();
    throw new Error("PDF 페이지가 없습니다.");
  }
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvasFactory = (document as typeof document & {
    canvasFactory: {
      create: (width: number, height: number) => {
        canvas: { toBuffer: (type: string) => Buffer };
        context: CanvasRenderingContext2D;
      };
    };
  }).canvasFactory;
  const canvasAndContext = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const renderTask = page.render({
    canvasContext: canvasAndContext.context,
    viewport,
    canvas: canvasAndContext.canvas,
  } as unknown as Parameters<typeof page.render>[0]);
  await renderTask.promise;
  const png = canvasAndContext.canvas.toBuffer("image/png");
  page.cleanup();
  const pageCount = document.numPages;
  await closable.destroy?.();
  const meta = await sharp(png).metadata();
  return { png, width: meta.width ?? Math.ceil(viewport.width), height: meta.height ?? Math.ceil(viewport.height), pageCount };
}

export async function extractRegion(
  png: Buffer,
  region: { x: number; y: number; width: number; height: number },
  rotation: PanelRotation,
  inset: { left: number; top: number; right: number; bottom: number },
) {
  const meta = await sharp(png).metadata();
  const pageWidth = meta.width ?? 1;
  const pageHeight = meta.height ?? 1;
  const left = clampInt(region.x * pageWidth, 0, pageWidth - 1);
  const top = clampInt(region.y * pageHeight, 0, pageHeight - 1);
  const width = clampInt(region.width * pageWidth, 1, pageWidth - left);
  const height = clampInt(region.height * pageHeight, 1, pageHeight - top);
  let pipeline = sharp(png).extract({ left, top, width, height });
  if (rotation !== 0) pipeline = pipeline.rotate(rotation);
  const upright = await pipeline.png().toBuffer();
  const uprightMeta = await sharp(upright).metadata();
  const uprightWidth = uprightMeta.width ?? 1;
  const uprightHeight = uprightMeta.height ?? 1;
  const insetLeft = clampInt(inset.left * uprightWidth, 0, Math.max(0, uprightWidth - 1));
  const insetTop = clampInt(inset.top * uprightHeight, 0, Math.max(0, uprightHeight - 1));
  const insetWidth = clampInt(uprightWidth - insetLeft - inset.right * uprightWidth, 1, uprightWidth - insetLeft);
  const insetHeight = clampInt(uprightHeight - insetTop - inset.bottom * uprightHeight, 1, uprightHeight - insetTop);
  if (insetLeft === 0 && insetTop === 0 && insetWidth === uprightWidth && insetHeight === uprightHeight) return upright;
  return sharp(upright).extract({ left: insetLeft, top: insetTop, width: insetWidth, height: insetHeight }).png().toBuffer();
}

function clampInt(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}
