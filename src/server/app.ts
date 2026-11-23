import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { assertNoUnsupportedRotation, assertUniformScale } from "../domain/aspect.js";
import { isPanelRotation } from "../domain/box.js";
import { DEFAULT_CROP } from "../domain/defaults.js";
import { projectFilename } from "../domain/filenames.js";
import { layoutScene } from "../domain/layout.js";
import { applyOperations, parseKoreanRevision, rowMap } from "../domain/revisions.js";
import type { ConceptPayload, PanelId, PanelMapping, Role, ShadowSettings } from "../domain/types.js";
import { exportQualityWarnings, validateProject } from "../domain/validation.js";
import { HttpError } from "./errors.js";
import { extensionFor, isAiFilename, sha256, sha256File } from "./files.js";
import { createDemoProject } from "./modules/demo.js";
import { buildPackage, restorePackage } from "./modules/export.js";
import { extractRegion, renderPdfPage } from "./modules/pdf.js";
import { buildRenderPlan } from "../domain/plan.js";
import { planInput, renderLayers } from "./modules/render.js";
import { aiStatus, analyzePackaging, assertAiConfigured, generateBackgroundImage, interpretRevision, proposeConcepts, reviewComposite } from "./modules/ai.js";
import { backgroundPrompt, snapImageSize } from "./modules/background.js";
import { Store, previewFile } from "./store.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
const aborts = new Map<string, AbortController>();

export function createApp(dataDir: string) {
  const store = new Store(dataDir);
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/api/status", (_req, res) => {
    res.json(aiStatus());
  });

  app.get("/api/projects", (_req, res) => {
    res.json({ projects: store.listProjects() });
  });

  app.post("/api/projects", asyncRoute(async (req, res) => {
    const name = text(req.body?.name, "프로젝트 이름");
    const campaignMonth = text(req.body?.campaignMonth, "캠페인 월");
    const outputWidth = dimension(req.body?.outputWidth, 1920);
    const outputHeight = dimension(req.body?.outputHeight, 1080);
    const project = store.createProject({
      id: crypto.randomUUID(),
      name,
      campaignMonth,
      outputWidth,
      outputHeight,
      brief: stringOrEmpty(req.body?.brief),
      constraints: stringOrEmpty(req.body?.constraints),
    });
    res.status(201).json({ bundle: store.bundle(project.id) });
  }));

  app.post("/api/demo-project", asyncRoute(async (_req, res) => {
    const projectId = await createDemoProject(store);
    const project = reflow(store, projectId, true);
    await writePreview(store, project.id);
    res.status(201).json({ bundle: store.bundle(project.id), message: "데모 예시입니다. 승인된 이니스프리 아트워크가 아닙니다." });
  }));

  app.post("/api/restore", upload.single("file"), asyncRoute(async (req, res) => {
    const file = uploaded(req);
    const bundle = await restorePackage(store, file.buffer, () => crypto.randomUUID());
    res.status(201).json({ bundle });
  }));

  app.get("/api/projects/:id", asyncRoute(async (req, res) => {
    res.json({ bundle: store.bundle(param(req)) });
  }));

  app.patch("/api/projects/:id", asyncRoute(async (req, res) => {
    const id = param(req);
    store.requireProject(id);
    const patch: Parameters<Store["updateProject"]>[1] = {};
    if (req.body?.name !== undefined) patch.name = text(req.body.name, "프로젝트 이름");
    if (req.body?.campaignMonth !== undefined) patch.campaignMonth = text(req.body.campaignMonth, "캠페인 월");
    if (req.body?.outputWidth !== undefined) patch.outputWidth = dimension(req.body.outputWidth);
    if (req.body?.outputHeight !== undefined) patch.outputHeight = dimension(req.body.outputHeight);
    if (req.body?.brief !== undefined) patch.brief = stringOrEmpty(req.body.brief);
    if (req.body?.constraints !== undefined) patch.constraints = stringOrEmpty(req.body.constraints);
    if (Object.keys(patch).length) store.updateProject(id, patch);
    if (req.body?.camera || req.body?.pedestal || req.body?.lighting) {
      const visual = store.readVisual(store.requireProject(id));
      if (req.body.camera && typeof req.body.camera === "object") {
        const topMargin = Number(req.body.camera.topMargin);
        if (Number.isFinite(topMargin)) visual.camera = { topMargin: Math.min(0.3, Math.max(0, topMargin)) };
      }
      if (req.body.pedestal && typeof req.body.pedestal === "object") {
        const height = Number(req.body.pedestal.height);
        const shape = req.body.pedestal.shape;
        const arrangement = req.body.pedestal.arrangement;
        visual.pedestal = {
          ...visual.pedestal,
          ...(shape === "rect" || shape === "oval" || shape === "plank" ? { shape } : {}),
          ...(arrangement === "per-set" || arrangement === "shared" ? { arrangement } : {}),
          ...(Number.isFinite(height) ? { height: Math.min(0.2, Math.max(0.02, height)) } : {}),
          ...(typeof req.body.pedestal.color === "string" && /^#[0-9a-fA-F]{6}$/.test(req.body.pedestal.color) ? { color: req.body.pedestal.color } : {}),
        };
      }
      if (req.body.lighting && typeof req.body.lighting === "object") {
        const brightness = Number(req.body.lighting.backgroundBrightness);
        const softness = Number(req.body.lighting.softness);
        const direction = req.body.lighting.direction;
        visual.lighting = {
          ...visual.lighting,
          ...(direction === "left" || direction === "right" || direction === "front" ? { direction } : {}),
          ...(Number.isFinite(softness) ? { softness: Math.min(1, Math.max(0, softness)) } : {}),
          ...(Number.isFinite(brightness) ? { backgroundBrightness: Math.min(1.7, Math.max(0.45, brightness)) } : {}),
        };
      }
      store.commitVisual(id, "장면 수치", [], visual);
      await writePreview(store, id);
    }
    res.json({ bundle: store.bundle(id) });
  }));

  app.delete("/api/projects/:id", asyncRoute(async (req, res) => {
    const id = param(req);
    store.requireProject(id);
    store.deleteProject(id);
    res.json({ ok: true });
  }));

  app.post("/api/projects/:id/sets", asyncRoute(async (req, res) => {
    const projectId = param(req);
    store.requireProject(projectId);
    store.createSet({ id: crypto.randomUUID(), projectId, displayName: text(req.body?.displayName, "세트 이름") });
    res.status(201).json({ bundle: store.bundle(projectId) });
  }));

  app.patch("/api/sets/:id", asyncRoute(async (req, res) => {
    const id = param(req);
    const existing = findSet(store, id);
    store.updateSet(id, {
      displayName: req.body?.displayName === undefined ? undefined : text(req.body.displayName, "세트 이름"),
      boxTemplateId: req.body?.boxTemplateId === undefined ? undefined : (req.body.boxTemplateId ? String(req.body.boxTemplateId) : null),
      visualEmphasis: req.body?.visualEmphasis === "hero" ? "hero" : req.body?.visualEmphasis === "normal" ? "normal" : undefined,
    });
    if (req.body?.boxTemplateId !== undefined) reflow(store, existing.projectId, false);
    res.json({ bundle: store.bundle(existing.projectId) });
  }));

  app.delete("/api/sets/:id", asyncRoute(async (req, res) => {
    const existing = findSet(store, param(req));
    store.deleteSet(existing.id);
    res.json({ bundle: store.bundle(existing.projectId) });
  }));

  app.post("/api/sets/:id/rows", asyncRoute(async (req, res) => {
    const set = findSet(store, param(req));
    const role = roleOf(req.body?.role);
    store.createRow({
      id: crypto.randomUUID(),
      setId: set.id,
      productName: text(req.body?.productName, "제품 이름"),
      capacity: stringOrEmpty(req.body?.capacity),
      role,
      requiredQuantity: quantityOf(req.body?.requiredQuantity),
      assetId: req.body?.assetId ? String(req.body.assetId) : null,
    });
    reflow(store, set.projectId, false);
    res.status(201).json({ bundle: store.bundle(set.projectId) });
  }));

  app.patch("/api/rows/:id", asyncRoute(async (req, res) => {
    const projectId = projectIdOfRow(store, param(req));
    store.updateRow(param(req), {
      productName: req.body?.productName === undefined ? undefined : text(req.body.productName, "제품 이름"),
      capacity: req.body?.capacity === undefined ? undefined : stringOrEmpty(req.body.capacity),
      role: req.body?.role === undefined ? undefined : roleOf(req.body.role),
      requiredQuantity: req.body?.requiredQuantity === undefined ? undefined : quantityOf(req.body.requiredQuantity),
      assetId: req.body?.assetId === undefined ? undefined : (req.body.assetId ? String(req.body.assetId) : null),
    });
    reflow(store, projectId, false);
    res.json({ bundle: store.bundle(projectId) });
  }));

  app.delete("/api/rows/:id", asyncRoute(async (req, res) => {
    const projectId = projectIdOfRow(store, param(req));
    store.deleteRow(param(req));
    reflow(store, projectId, false);
    res.json({ bundle: store.bundle(projectId) });
  }));

  app.get("/api/assets", (_req, res) => {
    res.json({ assets: store.listAssets() });
  });

  app.post("/api/assets", upload.single("file"), asyncRoute(async (req, res) => {
    const file = uploaded(req);
    if (isAiFilename(file.originalname)) {
      throw new HttpError(400, "일러스트레이터에서 PDF로 내보낸 뒤 올려 주세요. .ai 파일은 해석하지 않습니다.");
    }
    const ext = extensionFor(file.originalname, file.mimetype);
    if (ext === ".bin") throw new HttpError(400, "PNG, JPG, WEBP, PDF만 올릴 수 있습니다.");
    const id = crypto.randomUUID();
    const relative = `assets/${id}/source${ext}`;
    const absolute = store.absolute(relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.buffer);
    const isPdf = ext === ".pdf";
    let pixelWidth: number | null = null;
    let pixelHeight: number | null = null;
    let hasTransparency: boolean | null = null;
    let thumbnailPath: string | null = null;
    if (!isPdf) {
      const meta = await sharp(file.buffer).metadata();
      pixelWidth = meta.width ?? null;
      pixelHeight = meta.height ?? null;
      hasTransparency = Boolean(meta.hasAlpha);
      thumbnailPath = `assets/${id}/thumb.png`;
      await sharp(file.buffer).resize({ height: 240, fit: "inside" }).png().toFile(store.absolute(thumbnailPath));
    }
    const asset = store.insertAsset({
      id,
      originalFilename: file.originalname,
      sourcePath: relative,
      thumbnailPath,
      mediaType: isPdf ? "pdf" : "product",
      packagingVersion: stringOrEmpty(req.body?.packagingVersion),
      hasTransparency,
      pixelWidth,
      pixelHeight,
      physicalWidthMm: optionalMm(req.body?.physicalWidthMm),
      physicalHeightMm: optionalMm(req.body?.physicalHeightMm),
      physicalDepthMm: optionalMm(req.body?.physicalDepthMm),
      viewingAngle: angleOf(req.body?.viewingAngle),
      lightingNotes: stringOrEmpty(req.body?.lightingNotes),
      crop: DEFAULT_CROP,
      sourceSha256: sha256(file.buffer),
      demoFixture: false,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({ asset });
  }));

  app.patch("/api/assets/:id", asyncRoute(async (req, res) => {
    const asset = store.requireAsset(param(req));
    const before = sha256File(store.absolute(asset.sourcePath));
    const crop = req.body?.crop ? normalizeCrop(req.body.crop) : undefined;
    const updated = store.updateAsset(asset.id, {
      packagingVersion: req.body?.packagingVersion === undefined ? undefined : stringOrEmpty(req.body.packagingVersion),
      physicalWidthMm: req.body?.physicalWidthMm === undefined ? undefined : optionalMm(req.body.physicalWidthMm),
      physicalHeightMm: req.body?.physicalHeightMm === undefined ? undefined : optionalMm(req.body.physicalHeightMm),
      physicalDepthMm: req.body?.physicalDepthMm === undefined ? undefined : optionalMm(req.body.physicalDepthMm),
      viewingAngle: req.body?.viewingAngle === undefined ? undefined : angleOf(req.body.viewingAngle),
      lightingNotes: req.body?.lightingNotes === undefined ? undefined : stringOrEmpty(req.body.lightingNotes),
      crop,
    });
    const after = sha256File(store.absolute(updated.sourcePath));
    if (before !== after) throw new HttpError(500, "원본 파일이 바뀌었습니다. 저장을 중단했습니다.");
    res.json({ asset: updated });
  }));

  app.get("/api/assets/:id/file", asyncRoute(async (req, res) => {
    const asset = store.requireAsset(param(req));
    res.sendFile(store.absolute(asset.sourcePath));
  }));

  app.get("/api/assets/:id/preview.png", asyncRoute(async (req, res) => {
    const asset = store.requireAsset(param(req));
    if (asset.mediaType === "pdf") throw new HttpError(400, "PDF는 페이지 미리보기로 확인하세요.");
    let pipeline = sharp(store.absolute(asset.sourcePath));
    if (asset.pixelWidth && asset.pixelHeight) {
      const left = Math.round(asset.crop.left * asset.pixelWidth);
      const top = Math.round(asset.crop.top * asset.pixelHeight);
      const width = Math.max(1, Math.round(asset.pixelWidth * (1 - asset.crop.left - asset.crop.right)));
      const height = Math.max(1, Math.round(asset.pixelHeight * (1 - asset.crop.top - asset.crop.bottom)));
      pipeline = pipeline.extract({ left, top, width: Math.min(width, asset.pixelWidth - left), height: Math.min(height, asset.pixelHeight - top) });
    }
    const png = await pipeline.resize({ height: 640, fit: "inside" }).png().toBuffer();
    res.type("png").send(png);
  }));

  app.post("/api/assets/:id/pdf/render", asyncRoute(async (req, res) => {
    const asset = store.requireAsset(param(req));
    if (asset.mediaType !== "pdf") throw new HttpError(400, "PDF 자산이 아닙니다.");
    const first = await renderPdfPage(store.absolute(asset.sourcePath), 1, 2);
    const pages = [];
    for (let page = 1; page <= first.pageCount; page += 1) {
      const rendered = page === 1 ? first : await renderPdfPage(store.absolute(asset.sourcePath), page, 2);
      const relative = `cache/pdf/${asset.id}/page-${page}.png`;
      const absolute = store.absolute(relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, rendered.png);
      pages.push({ page, width: rendered.width, height: rendered.height, url: `/api/assets/${asset.id}/pdf/pages/${page}.png` });
    }
    res.json({ pageCount: first.pageCount, pages });
  }));

  app.get("/api/assets/:id/pdf/pages/:page.png", asyncRoute(async (req, res) => {
    const asset = store.requireAsset(param(req));
    const page = Number(String(req.params.page).replace(/\.png$/, ""));
    const relative = `cache/pdf/${asset.id}/page-${page}.png`;
    const absolute = store.absolute(relative);
    if (!fs.existsSync(absolute)) throw new HttpError(404, "페이지를 먼저 렌더하세요.");
    res.sendFile(absolute);
  }));

  app.post("/api/box-templates", asyncRoute(async (req, res) => {
    const template = await saveTemplate(store, null, req.body);
    res.status(201).json({ template });
  }));

  app.patch("/api/box-templates/:id", asyncRoute(async (req, res) => {
    const template = await saveTemplate(store, param(req), req.body);
    res.json({ template });
  }));

  app.get("/api/box-templates", (_req, res) => {
    res.json({ templates: store.listTemplates() });
  });

  app.get("/api/box-templates/:id/panels/:panel.png", asyncRoute(async (req, res) => {
    const template = store.requireTemplate(param(req));
    const panelId = String(req.params.panel).replace(/\.png$/, "") as PanelId;
    const panel = template.panels.find((candidate) => candidate.panel === panelId);
    if (!panel?.imagePath) throw new HttpError(404, "면 이미지가 없습니다. 보이지 않는 면을 만들지 않습니다.");
    res.sendFile(store.absolute(panel.imagePath));
  }));

  app.post("/api/box-templates/:id/panels/:panel/replacement", upload.single("file"), asyncRoute(async (req, res) => {
    const template = store.requireTemplate(param(req));
    const panelId = String(req.params.panel) as PanelId;
    const file = uploaded(req);
    if (extensionFor(file.originalname, file.mimetype) === ".pdf" || isAiFilename(file.originalname)) {
      throw new HttpError(400, "깨끗한 면 이미지는 PNG 또는 JPG로 올려 주세요. 글자를 메우지 않습니다.");
    }
    const id = crypto.randomUUID();
    const relative = `assets/${id}/source.png`;
    const png = await sharp(file.buffer).png().toBuffer();
    fs.mkdirSync(path.dirname(store.absolute(relative)), { recursive: true });
    fs.writeFileSync(store.absolute(relative), png);
    const meta = await sharp(png).metadata();
    store.insertAsset({
      id,
      originalFilename: file.originalname,
      sourcePath: relative,
      thumbnailPath: null,
      mediaType: "panel",
      packagingVersion: template.name,
      hasTransparency: Boolean(meta.hasAlpha),
      pixelWidth: meta.width ?? null,
      pixelHeight: meta.height ?? null,
      physicalWidthMm: null,
      physicalHeightMm: null,
      physicalDepthMm: null,
      viewingAngle: "front",
      lightingNotes: "사용자가 올린 깨끗한 면 이미지",
      crop: DEFAULT_CROP,
      sourceSha256: sha256(png),
      demoFixture: false,
      createdAt: new Date().toISOString(),
    });
    const panels = template.panels.map((panel) => panel.panel === panelId ? { ...panel, replacementAssetId: id, imagePath: relative } : panel);
    const updated = store.updateTemplate(template.id, { panels });
    res.json({ template: updated });
  }));

  app.post("/api/projects/:id/scene/layout", asyncRoute(async (req, res) => {
    const id = param(req);
    const project = store.requireProject(id);
    const items = layoutScene({
      project,
      reflow: req.body?.reflow !== false,
      options: layoutOptions(req.body?.options),
      createId: () => crypto.randomUUID(),
    });
    const visual = store.readVisual(project);
    visual.items = items;
    store.commitVisual(id, "구색 기준으로 배치", [], visual);
    await writePreview(store, id);
    res.json({ bundle: store.bundle(id) });
  }));

  app.patch("/api/scene-items/:id", asyncRoute(async (req, res) => {
    const current = findItem(store, param(req));
    if (req.body?.rotationDeg !== undefined) assertNoUnsupportedRotation(Number(req.body.rotationDeg));
    const scale = req.body?.scale === undefined ? current.scale : assertUniformScale(req.body.scale);
    const project = store.requireProject(current.projectId);
    const visual = store.readVisual(project);
    visual.items = visual.items.map((item) => item.id === current.id ? {
      ...item,
      x: req.body?.x === undefined ? item.x : finite(req.body.x, "x"),
      y: req.body?.y === undefined ? item.y : finite(req.body.y, "y"),
      scale,
      layer: req.body?.layer === undefined ? item.layer : Math.round(finite(req.body.layer, "layer")),
      shadow: req.body?.shadow ? normalizeShadow(req.body.shadow) : item.shadow,
      rotationDeg: 0,
    } : item);
    store.commitVisual(project.id, "직접 수정", [], visual);
    await writePreview(store, project.id);
    res.json({ bundle: store.bundle(project.id) });
  }));

  app.get("/api/projects/:id/plan", asyncRoute(async (req, res) => {
    const bundle = store.bundle(param(req));
    const plan = buildRenderPlan(planInput(bundle.project, bundle.assets, bundle.templates));
    res.json({ plan });
  }));

  app.post("/api/projects/:id/render", asyncRoute(async (req, res) => {
    const files = await writePreview(store, param(req));
    res.json({ files, bundle: store.bundle(param(req)) });
  }));

  app.get("/api/projects/:id/preview.png", asyncRoute(async (req, res) => {
    const layer = typeof req.query.layer === "string" ? req.query.layer : "full";
    const allowed = new Set(["full", "background", "subjects", "shadow"]);
    if (!allowed.has(layer)) throw new HttpError(400, "미리보기 종류가 올바르지 않습니다.");
    const file = previewFile(store.dataDir, param(req), layer);
    if (!fs.existsSync(file)) throw new HttpError(404, "아직 미리보기가 없습니다.");
    res.sendFile(file);
  }));

  app.post("/api/projects/:id/validate", asyncRoute(async (req, res) => {
    const bundle = store.bundle(param(req));
    const report = validateProject(planInput(bundle.project, bundle.assets, bundle.templates), (asset) => sha256File(store.absolute(asset.sourcePath)));
    store.saveValidation(bundle.project.id, report);
    res.json({ report });
  }));

  app.post("/api/projects/:id/revisions", asyncRoute(async (req, res) => {
    const id = param(req);
    const project = store.requireProject(id);
    const prompt = text(req.body?.prompt, "수정 문장");
    const sets = project.sets.map((set) => ({ id: set.id, displayName: set.displayName }));
    let parsed = parseKoreanRevision(prompt, sets);
    if (!parsed.matched) {
      const interpreted = await interpretRevision({ prompt, sets });
      parsed = { matched: true, operations: interpreted.operations, notes: interpreted.unresolved };
    }
    if (!parsed.operations.length) {
      throw new HttpError(422, parsed.notes.join(" ") || "적용할 수정이 없습니다. 장면은 바꾸지 않았습니다.", "unresolved", { notes: parsed.notes });
    }
    const fresh = store.requireProject(id);
    const visual = store.readVisual(fresh);
    if (parsed.operations.some((operation) => operation.op === "regenerateBackground")) {
      const asset = await generateBackgroundAsset(store, fresh.id);
      visual.backgroundAssetId = asset.id;
      visual.backgroundLocked = true;
      visual.backgroundGenerated = true;
    }
    const applied = applyOperations(visual, parsed.operations.filter((operation) => operation.op !== "regenerateBackground"), rowMap(fresh.sets));
    store.commitVisual(id, prompt, parsed.operations, applied.state);
    await writePreview(store, id);
    res.json({ bundle: store.bundle(id), notes: [...parsed.notes, ...applied.notes] });
  }));

  app.post("/api/projects/:id/undo", asyncRoute(async (req, res) => {
    const id = param(req);
    store.undo(id);
    await writePreview(store, id);
    res.json({ bundle: store.bundle(id) });
  }));

  app.post("/api/projects/:id/redo", asyncRoute(async (req, res) => {
    const id = param(req);
    store.redo(id);
    await writePreview(store, id);
    res.json({ bundle: store.bundle(id) });
  }));

  app.post("/api/projects/:id/background", upload.single("file"), asyncRoute(async (req, res) => {
    const id = param(req);
    const project = store.requireProject(id);
    const file = uploaded(req);
    const ext = extensionFor(file.originalname, file.mimetype);
    if (ext === ".pdf" || ext === ".bin" || isAiFilename(file.originalname)) {
      throw new HttpError(400, "배경은 PNG, JPG, WEBP 이미지로 올려 주세요.");
    }
    const asset = await storeImageAsset(store, file.buffer, file.originalname, "background", "업로드한 배경");
    const visual = store.readVisual(project);
    visual.backgroundAssetId = asset.id;
    visual.backgroundLocked = true;
    visual.backgroundGenerated = false;
    store.commitVisual(id, "배경 업로드", [], visual);
    await writePreview(store, id);
    res.json({ bundle: store.bundle(id), asset });
  }));

  app.post("/api/projects/:id/background/generate", asyncRoute(async (req, res) => {
    assertAiConfigured();
    const id = param(req);
    if (store.countJobs(id, "background", "succeeded") >= 8) {
      throw new HttpError(429, "배경 자동 생성은 프로젝트당 8회까지입니다. 배경을 직접 올리거나 만든 배경을 유지하세요.");
    }
    const job = store.createJob({ id: crypto.randomUUID(), projectId: id, kind: "background" });
    res.status(202).json({ job });
    void runJob(store, job.id, async (signal) => {
      const project = store.requireProject(id);
      const concept = project.selectedConceptId ? store.listConcepts(id).find((item) => item.id === project.selectedConceptId) ?? null : null;
      const size = snapImageSize(project.outputWidth, project.outputHeight);
      const raw = await generateBackgroundImage({ prompt: backgroundPrompt(project, concept ?? null), size, signal });
      const fitted = await sharp(raw).resize(project.outputWidth, project.outputHeight, { fit: "cover", position: "centre" }).png().toBuffer();
      const meta = await sharp(raw).metadata();
      const asset = await storeImageAsset(store, fitted, `generated-background-${size}.png`, "background", `생성 원본 ${meta.width ?? "?"}x${meta.height ?? "?"}를 출력 프레임에 맞췄습니다. 제품은 다시 그리지 않았습니다.`);
      if (signal.aborted) return { cancelled: true };
      const visual = store.readVisual(store.requireProject(id));
      visual.backgroundAssetId = asset.id;
      visual.backgroundLocked = true;
      visual.backgroundGenerated = true;
      store.commitVisual(id, "배경 생성", [{ op: "regenerateBackground" }], visual);
      await writePreview(store, id);
      return { assetId: asset.id };
    });
  }));

  app.post("/api/projects/:id/analyze", asyncRoute(async (req, res) => {
    assertAiConfigured();
    const id = param(req);
    const job = store.createJob({ id: crypto.randomUUID(), projectId: id, kind: "analyze" });
    res.status(202).json({ job });
    void runJob(store, job.id, async (signal) => {
      const bundle = store.bundle(id);
      const images = panelPaths(store, bundle.project);
      const analysis = await analyzePackaging({
        assortmentText: assortmentText(bundle.project),
        imagePaths: images,
        signal,
      });
      if (signal.aborted) return { cancelled: true };
      store.insertAnalysis({ id: crypto.randomUUID(), projectId: id, ...analysis, createdAt: new Date().toISOString() });
      return { analysisId: store.latestAnalysis(id)?.id };
    });
  }));

  app.post("/api/projects/:id/concepts", asyncRoute(async (req, res) => {
    assertAiConfigured();
    const id = param(req);
    if (store.countJobs(id, "concepts", "succeeded") >= 6) {
      throw new HttpError(429, "콘셉트 자동 제안은 프로젝트당 6회까지입니다. 이미 받은 콘셉트를 고치거나 직접 배치하세요.");
    }
    const job = store.createJob({ id: crypto.randomUUID(), projectId: id, kind: "concepts" });
    res.status(202).json({ job });
    void runJob(store, job.id, async (signal) => {
      const bundle = store.bundle(id);
      const analysis = bundle.analysis ?? {
        observed: { colors: [], motifs: [], patternDensity: "", typography: "", seasonalReferences: [], boxRelationships: "", visualBalance: "" },
        artDirection: { summary: bundle.project.brief, palette: [], mood: "", avoid: [] },
        unresolved: ["패키지 분석이 없어 구색과 확정된 면만 전달했습니다."],
      };
      const concepts = await proposeConcepts({
        assortmentText: assortmentText(bundle.project),
        setIds: bundle.project.sets.map((set) => ({ id: set.id, displayName: set.displayName })),
        analysis,
        angles: bundle.assets.filter((asset) => asset.mediaType === "product").map((asset) => `${asset.originalFilename}: ${asset.viewingAngle}`).join(", "),
        signal,
      });
      if (signal.aborted) return { cancelled: true };
      const ids: string[] = [];
      for (const concept of concepts) {
        const conceptId = crypto.randomUUID();
        const { name, rationale, ...payload } = concept;
        store.insertConcept({
          id: conceptId,
          projectId: id,
          source: "ai",
          name,
          rationale,
          payload,
          previewPath: null,
          createdAt: new Date().toISOString(),
        });
        const preview = await renderConceptPreview(store, id, payload);
        store.updateConceptPreview(conceptId, preview);
        ids.push(conceptId);
      }
      return { conceptIds: ids };
    });
  }));

  app.post("/api/projects/:id/concepts/:conceptId/apply", asyncRoute(async (req, res) => {
    const id = param(req);
    const concept = store.requireConcept(param(req, "conceptId"));
    if (concept.projectId !== id) throw new HttpError(404, "콘셉트를 찾지 못했습니다.");
    const project = store.requireProject(id);
    const payload = concept.payload;
    const visual = store.readVisual(project);
    visual.selectedConceptId = concept.id;
    visual.pedestal = {
      ...visual.pedestal,
      shape: payload.pedestalShape,
      arrangement: payload.pedestalArrangement,
    };
    visual.lighting = {
      ...visual.lighting,
      direction: payload.lightingDirection,
      softness: payload.lightingSoftness === "soft" ? 0.8 : payload.lightingSoftness === "hard" ? 0.25 : 0.55,
    };
    visual.camera = { topMargin: payload.copyArea === "top" ? 0.14 : visual.camera.topMargin };
    const draft = store.requireProject(id);
    draft.pedestal = visual.pedestal;
    draft.lighting = visual.lighting;
    draft.camera = visual.camera;
    draft.items = project.items;
    visual.items = layoutScene({
      project: draft,
      reflow: true,
      options: {
        spacing: payload.spacing,
        sampleArrangement: payload.sampleArrangement,
        hierarchy: payload.hierarchy,
        setOrder: payload.setOrder,
      },
      createId: () => crypto.randomUUID(),
    });
    store.commitVisual(id, `콘셉트 적용: ${concept.name}`, [], visual);
    await writePreview(store, id);
    res.json({ bundle: store.bundle(id) });
  }));

  app.post("/api/projects/:id/visual-review", asyncRoute(async (req, res) => {
    assertAiConfigured();
    const id = param(req);
    const file = previewFile(store.dataDir, id, "full");
    if (!fs.existsSync(file)) throw new HttpError(400, "먼저 미리보기를 만든 뒤 시각 메모를 요청하세요.");
    const job = store.createJob({ id: crypto.randomUUID(), projectId: id, kind: "visual-review" });
    res.status(202).json({ job });
    void runJob(store, job.id, async (signal) => reviewComposite({ imagePath: file, signal }));
  }));

  app.post("/api/projects/:id/export", asyncRoute(async (req, res) => {
    const id = param(req);
    const format = String(req.body?.format ?? "png");
    const bundle = store.bundle(id);
    const warnings = exportQualityWarnings(planInput(bundle.project, bundle.assets, bundle.templates));
    if (warnings.length && req.body?.acknowledgeLimits !== true) {
      throw new HttpError(409, "내보내기 전에 해상도 한계를 확인하세요.", "quality-limits", { warnings });
    }
    const layers = await renderLayers(planInput(bundle.project, bundle.assets, bundle.templates), (relative) => store.absolute(relative));
    const exportId = crypto.randomUUID();
    const notes = warnings.map((warning) => warning.message);
    if (format === "package") {
      const zip = buildPackage(store, id);
      const filename = projectFilename(bundle.project, "package", "zip");
      const relative = `exports/${exportId}.zip`;
      fs.writeFileSync(store.absolute(relative), zip);
      store.addExport({ id: exportId, projectId: id, format, filePath: relative, width: null, height: null, notes });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", disposition(filename));
      res.send(zip);
      return;
    }
    const buffer = await exportBuffer(layers, format);
    const ext = format === "jpg" ? "jpg" : "png";
    const kind = format === "png" ? "final" : format;
    const filename = projectFilename(bundle.project, kind, ext);
    const relative = `exports/${exportId}.${ext}`;
    fs.writeFileSync(store.absolute(relative), buffer);
    const meta = await sharp(buffer).metadata();
    store.addExport({ id: exportId, projectId: id, format, filePath: relative, width: meta.width ?? null, height: meta.height ?? null, notes });
    res.setHeader("Content-Type", ext === "jpg" ? "image/jpeg" : "image/png");
    res.setHeader("Content-Disposition", disposition(filename));
    res.send(buffer);
  }));

  app.get("/api/concepts/:id/preview.png", asyncRoute(async (req, res) => {
    const concept = store.requireConcept(param(req));
    if (!concept.previewPath) throw new HttpError(404, "콘셉트 미리보기가 없습니다.");
    res.sendFile(store.absolute(concept.previewPath));
  }));

  app.get("/api/jobs/:id", asyncRoute(async (req, res) => {
    res.json({ job: store.requireJob(param(req)) });
  }));

  app.post("/api/jobs/:id/cancel", asyncRoute(async (req, res) => {
    const job = store.requireJob(param(req));
    aborts.get(job.id)?.abort();
    if (job.status === "queued" || job.status === "running") {
      store.updateJob(job.id, { status: "cancelled", error: "사용자가 작업을 취소했습니다." });
    }
    res.json({ job: store.requireJob(job.id) });
  }));

  const clientDir = path.resolve("dist/client");
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/files")) return next();
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.code, message: error.message, details: error.details ?? null });
      return;
    }
    const multerError = error as { code?: string };
    if (multerError?.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "file-too-large", message: "파일이 40MB를 넘습니다." });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "internal", message: "작업을 끝내지 못했습니다. 다시 시도해 주세요." });
  });

  return { app, store };
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function param(req: Request, name = "id") {
  const value = req.params[name];
  const id = Array.isArray(value) ? value[0] : value;
  if (!id) throw new HttpError(400, "주소가 올바르지 않습니다.");
  return id;
}

function text(value: unknown, label: string) {
  const result = stringOrEmpty(value).trim();
  if (!result) throw new HttpError(400, `${label}이 필요합니다.`);
  return result;
}

function stringOrEmpty(value: unknown) {
  return typeof value === "string" ? value : "";
}

function finite(value: unknown, label: string) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new HttpError(400, `${label} 값이 올바르지 않습니다.`);
  return number;
}

function dimension(value: unknown, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  const number = Math.round(finite(value, "출력 크기"));
  if (number < 64 || number > 8000) throw new HttpError(400, "출력 크기는 64에서 8000 사이여야 합니다.");
  return number;
}

function quantityOf(value: unknown) {
  const number = Math.round(finite(value ?? 1, "수량"));
  if (number < 0 || number > 24) throw new HttpError(400, "한 행의 수량은 0에서 24까지입니다.");
  return number;
}

function roleOf(value: unknown): Role {
  if (value === "box" || value === "full-size" || value === "sample" || value === "other") return value;
  throw new HttpError(400, "역할은 박스, 본품, 샘플, 기타 중 하나여야 합니다.");
}

function angleOf(value: unknown) {
  if (value === "front" || value === "three-quarter") return value;
  return "unknown" as const;
}

function optionalMm(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = finite(value, "치수");
  if (number <= 0) throw new HttpError(400, "치수는 0보다 커야 합니다. 용량으로 크기를 만들지 않습니다.");
  return number;
}

function normalizeCrop(value: unknown) {
  const crop = { ...DEFAULT_CROP, ...(value as object) };
  for (const key of ["left", "top", "right", "bottom"] as const) {
    const number = finite(crop[key], key);
    if (number < 0 || number > 0.45) throw new HttpError(400, "자르기 여백은 0에서 45% 사이입니다.");
    crop[key] = number;
  }
  if (crop.left + crop.right >= 0.9 || crop.top + crop.bottom >= 0.9) {
    throw new HttpError(400, "자르기 영역이 너무 좁습니다.");
  }
  const anchor = finite(crop.bottomAnchor, "bottomAnchor");
  if (anchor < 0 || anchor > 1) throw new HttpError(400, "바닥 기준점은 0에서 1 사이입니다.");
  crop.bottomAnchor = anchor;
  return crop;
}

function normalizeShadow(value: unknown): ShadowSettings {
  const shadow = value as Partial<ShadowSettings>;
  return {
    opacity: Math.min(1, Math.max(0, finite(shadow.opacity, "그림자"))),
    blur: Math.max(0, finite(shadow.blur, "그림자")),
    offsetX: finite(shadow.offsetX, "그림자"),
    offsetY: finite(shadow.offsetY, "그림자"),
  };
}

function uploaded(req: Request) {
  const file = (req as Request & { file?: { buffer: Buffer; originalname: string; mimetype: string } }).file;
  if (!file) throw new HttpError(400, "파일이 없습니다.");
  return file;
}

function reflow(store: Store, projectId: string, full: boolean) {
  const project = store.requireProject(projectId);
  const items = layoutScene({ project, reflow: full, createId: () => crypto.randomUUID() });
  store.replaceScene(projectId, items);
  return store.requireProject(projectId);
}

function findSet(store: Store, setId: string) {
  for (const summary of store.listProjects()) {
    const project = store.requireProject(summary.id);
    const set = project.sets.find((candidate) => candidate.id === setId);
    if (set) return set;
  }
  throw new HttpError(404, "세트를 찾지 못했습니다.");
}

function findItem(store: Store, itemId: string) {
  for (const summary of store.listProjects()) {
    const project = store.requireProject(summary.id);
    const item = project.items.find((candidate) => candidate.id === itemId);
    if (item) return item;
  }
  throw new HttpError(404, "장면 객체를 찾지 못했습니다.");
}

function projectIdOfRow(store: Store, rowId: string) {
  for (const summary of store.listProjects()) {
    const project = store.requireProject(summary.id);
    if (project.sets.some((set) => set.rows.some((row) => row.id === rowId))) return project.id;
  }
  throw new HttpError(404, "구색 행을 찾지 못했습니다.");
}

function layoutOptions(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const options = value as { spacing?: ConceptPayload["spacing"]; sampleArrangement?: ConceptPayload["sampleArrangement"]; hierarchy?: ConceptPayload["hierarchy"]; setOrder?: string[] };
  return options;
}

async function writePreview(store: Store, projectId: string) {
  const bundle = store.bundle(projectId);
  const layers = await renderLayers(planInput(bundle.project, bundle.assets, bundle.templates), (relative) => store.absolute(relative));
  const dir = path.join(store.dataDir, "renders", projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "full.png"), layers.full);
  fs.writeFileSync(path.join(dir, "background.png"), layers.background);
  fs.writeFileSync(path.join(dir, "subjects.png"), layers.subjects);
  fs.writeFileSync(path.join(dir, "shadow.png"), layers.shadow);
  return {
    full: `/api/projects/${projectId}/preview.png?layer=full`,
    background: `/api/projects/${projectId}/preview.png?layer=background`,
    subjects: `/api/projects/${projectId}/preview.png?layer=subjects`,
    shadow: `/api/projects/${projectId}/preview.png?layer=shadow`,
  };
}

async function exportBuffer(layers: Awaited<ReturnType<typeof renderLayers>>, format: string) {
  if (format === "jpg") return sharp(layers.full).flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
  if (format === "background") return layers.background;
  if (format === "subjects") return layers.subjects;
  if (format === "shadow") return layers.shadow;
  if (format === "png") return layers.full;
  throw new HttpError(400, "내보내기 형식은 png, jpg, background, subjects, shadow, package 중 하나여야 합니다.");
}

function disposition(filename: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function saveTemplate(store: Store, existingId: string | null, body: Record<string, unknown>) {
  const widthMm = optionalMm(body?.widthMm);
  const heightMm = optionalMm(body?.heightMm);
  const depthMm = optionalMm(body?.depthMm);
  if (!widthMm || !heightMm || !depthMm) throw new HttpError(400, "가로, 세로, 깊이 mm를 직접 입력하세요.");
  const sourceAssetId = body?.sourceAssetId ? String(body.sourceAssetId) : null;
  const panelsInput = Array.isArray(body?.panels) ? body.panels : [];
  if (!panelsInput.length) throw new HttpError(400, "최소 한 개의 면을 지정하세요. 없는 면은 비워 두세요.");
  const panels: PanelMapping[] = [];
  for (const raw of panelsInput) {
    const panel = raw as PanelMapping;
    if (!["front", "side", "top", "back", "left", "bottom", "other"].includes(panel.panel)) {
      throw new HttpError(400, "면 이름이 올바르지 않습니다.");
    }
    const rotation = Number(panel.rotation ?? 0);
    if (!isPanelRotation(rotation)) throw new HttpError(400, "면 회전은 0, 90, 180, 270도만 됩니다.");
    let imagePath = panel.imagePath ?? null;
    if (sourceAssetId && !panel.replacementAssetId) {
      const asset = store.requireAsset(sourceAssetId);
      if (asset.mediaType !== "pdf") throw new HttpError(400, "다이라인은 PDF여야 합니다.");
      const page = Number(panel.page || body?.sourcePage || 1);
      const cached = store.absolute(`cache/pdf/${asset.id}/page-${page}.png`);
      const rendered = fs.existsSync(cached) ? fs.readFileSync(cached) : (await renderPdfPage(store.absolute(asset.sourcePath), page, 2)).png;
      if (!fs.existsSync(cached)) {
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        fs.writeFileSync(cached, rendered);
      }
      const image = await extractRegion(fs.readFileSync(cached), panel, rotation, panel.inset ?? { left: 0, top: 0, right: 0, bottom: 0 });
      const templateKey = existingId ?? "draft";
      imagePath = `assets/panels/${templateKey}/${panel.panel}-${crypto.randomUUID()}.png`;
      fs.mkdirSync(path.dirname(store.absolute(imagePath)), { recursive: true });
      fs.writeFileSync(store.absolute(imagePath), image);
    }
    panels.push({
      panel: panel.panel,
      page: Number(panel.page || 1),
      x: finite(panel.x, "x"),
      y: finite(panel.y, "y"),
      width: finite(panel.width, "width"),
      height: finite(panel.height, "height"),
      rotation,
      inset: panel.inset ?? { left: 0, top: 0, right: 0, bottom: 0 },
      guidesEmbedded: Boolean(panel.guidesEmbedded),
      replacementAssetId: panel.replacementAssetId ?? null,
      imagePath,
    });
  }
  const notes = [
    stringOrEmpty(body?.notes),
    panels.some((panel) => panel.guidesEmbedded) ? "재단선이나 가이드가 면 이미지에 남아 있습니다. 경계를 조정하거나 깨끗한 면 이미지를 올리세요. 글자는 메우지 않습니다." : "",
  ].filter(Boolean).join(" ");
  const timestamp = new Date().toISOString();
  if (!existingId) {
    return store.insertTemplate({
      id: crypto.randomUUID(),
      name: text(body?.name, "템플릿 이름"),
      widthMm,
      heightMm,
      depthMm,
      sourceAssetId,
      sourcePage: body?.sourcePage ? Number(body.sourcePage) : panels[0]?.page ?? null,
      panels,
      revision: 1,
      notes,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  return store.updateTemplate(existingId, {
    name: body?.name ? text(body.name, "템플릿 이름") : undefined,
    widthMm,
    heightMm,
    depthMm,
    sourceAssetId,
    sourcePage: body?.sourcePage ? Number(body.sourcePage) : panels[0]?.page ?? null,
    panels,
    notes,
  });
}

async function storeImageAsset(store: Store, bytes: Buffer, filename: string, mediaType: "background" | "product", lightingNotes: string) {
  const id = crypto.randomUUID();
  const png = mediaType === "background" ? bytes : await sharp(bytes).png().toBuffer();
  const relative = `assets/${id}/source.png`;
  fs.mkdirSync(path.dirname(store.absolute(relative)), { recursive: true });
  fs.writeFileSync(store.absolute(relative), png);
  const meta = await sharp(png).metadata();
  return store.insertAsset({
    id,
    originalFilename: filename,
    sourcePath: relative,
    thumbnailPath: null,
    mediaType,
    packagingVersion: "",
    hasTransparency: Boolean(meta.hasAlpha),
    pixelWidth: meta.width ?? null,
    pixelHeight: meta.height ?? null,
    physicalWidthMm: null,
    physicalHeightMm: null,
    physicalDepthMm: null,
    viewingAngle: "unknown",
    lightingNotes,
    crop: DEFAULT_CROP,
    sourceSha256: sha256(png),
    demoFixture: false,
    createdAt: new Date().toISOString(),
  });
}

async function generateBackgroundAsset(store: Store, projectId: string) {
  if (!aiStatus().configured) {
    throw new HttpError(503, "배경을 다시 만들려면 OPENAI_API_KEY가 필요합니다. 장면은 바꾸지 않았습니다. 배경 파일을 올릴 수 있습니다.", "ai_not_configured", { requiredEnv: ["OPENAI_API_KEY"] });
  }
  const current = store.requireProject(projectId);
  const size = snapImageSize(current.outputWidth, current.outputHeight);
  const raw = await generateBackgroundImage({ prompt: backgroundPrompt(current, null), size });
  const fitted = await sharp(raw).resize(current.outputWidth, current.outputHeight, { fit: "cover", position: "centre" }).png().toBuffer();
  return storeImageAsset(store, fitted, "generated-background.png", "background", "문장 요청으로 생성한 배경");
}

function assortmentText(project: { sets: { displayName: string; rows: { productName: string; capacity: string; role: string; requiredQuantity: number }[] }[] }) {
  return project.sets.map((set) => `${set.displayName}: ${set.rows.map((row) => `${row.productName} ${row.capacity} ${row.role} x${row.requiredQuantity}`).join(", ")}`).join("\n");
}

function panelPaths(store: Store, project: { sets: { boxTemplateId: string | null }[] }) {
  const paths: string[] = [];
  for (const set of project.sets) {
    if (!set.boxTemplateId) continue;
    const template = store.requireTemplate(set.boxTemplateId);
    for (const panel of template.panels) {
      if (panel.imagePath) paths.push(store.absolute(panel.imagePath));
    }
  }
  return paths;
}

async function renderConceptPreview(store: Store, projectId: string, payload: ConceptPayload) {
  const project = store.requireProject(projectId);
  const draft = structuredClone(project);
  draft.pedestal = { ...draft.pedestal, shape: payload.pedestalShape, arrangement: payload.pedestalArrangement };
  draft.lighting = {
    ...draft.lighting,
    direction: payload.lightingDirection,
    softness: payload.lightingSoftness === "soft" ? 0.8 : payload.lightingSoftness === "hard" ? 0.25 : 0.55,
  };
  draft.camera = { topMargin: payload.copyArea === "top" ? 0.14 : draft.camera.topMargin };
  draft.items = layoutScene({
    project: draft,
    reflow: true,
    options: {
      spacing: payload.spacing,
      sampleArrangement: payload.sampleArrangement,
      hierarchy: payload.hierarchy,
      setOrder: payload.setOrder,
    },
    createId: () => crypto.randomUUID(),
  });
  const bundle = store.bundle(projectId);
  const layers = await renderLayers(planInput(draft, bundle.assets, bundle.templates), (relative) => store.absolute(relative));
  const relative = `renders/concepts/${crypto.randomUUID()}.png`;
  fs.mkdirSync(path.dirname(store.absolute(relative)), { recursive: true });
  fs.writeFileSync(store.absolute(relative), layers.full);
  return relative;
}

function runJob(store: Store, id: string, work: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  aborts.set(id, controller);
  store.updateJob(id, { status: "running" });
  work(controller.signal).then((result) => {
    if (controller.signal.aborted) {
      store.updateJob(id, { status: "cancelled", error: "사용자가 작업을 취소했습니다." });
      return;
    }
    store.updateJob(id, { status: "succeeded", result });
  }).catch((error: unknown) => {
    if (controller.signal.aborted) {
      store.updateJob(id, { status: "cancelled", error: "사용자가 작업을 취소했습니다." });
      return;
    }
    const message = error instanceof HttpError ? error.message : error instanceof Error ? error.message : "작업에 실패했습니다.";
    store.updateJob(id, { status: "failed", error: message });
  }).finally(() => {
    aborts.delete(id);
  });
}

