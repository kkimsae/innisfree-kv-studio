import fs from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Store } from "../store.js";
import { sha256 } from "../files.js";
import { HttpError } from "../errors.js";

const PACKAGE_FORMAT = "innisfree-kv-studio-package";

export function buildPackage(store: Store, projectId: string) {
  const bundle = store.bundle(projectId);
  const files: Record<string, Uint8Array> = {};
  const assets = bundle.assets.filter((asset) => usedAsset(bundle, asset.id) || asset.mediaType === "panel");
  const templates = bundle.templates.filter((template) => bundle.project.sets.some((set) => set.boxTemplateId === template.id));
  const manifest = {
    format: PACKAGE_FORMAT,
    version: 1,
    project: bundle.project,
    assets: assets.map((asset) => ({ ...asset, file: `assets/${asset.id}${path.extname(asset.sourcePath)}` })),
    templates,
    concepts: bundle.concepts,
    analysis: bundle.analysis,
    note: "원본 바이트와 장면 데이터입니다. 변환값은 파일에 구워져 있지 않습니다.",
  };
  files["project.json"] = strToU8(JSON.stringify(manifest));
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(store.absolute(asset.sourcePath));
    if (sha256(bytes) !== asset.sourceSha256) {
      throw new HttpError(409, `${asset.originalFilename} 원본이 저장 당시와 다릅니다. 패키지를 만들지 않았습니다.`, "source-changed");
    }
    files[asset.file] = new Uint8Array(bytes);
  }
  for (const template of templates) {
    for (const panel of template.panels) {
      if (!panel.imagePath) continue;
      const name = `panels/${template.id}/${panel.panel}.png`;
      files[name] = new Uint8Array(fs.readFileSync(store.absolute(panel.imagePath)));
    }
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}

function usedAsset(bundle: ReturnType<Store["bundle"]>, assetId: string) {
  if (bundle.project.backgroundAssetId === assetId) return true;
  if (bundle.project.sets.some((set) => set.rows.some((row) => row.assetId === assetId))) return true;
  if (bundle.project.items.some((item) => item.assetId === assetId)) return true;
  if (bundle.templates.some((template) => template.sourceAssetId === assetId || template.panels.some((panel) => panel.replacementAssetId === assetId))) return true;
  return false;
}

export async function restorePackage(store: Store, bytes: Buffer, createId: () => string) {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new HttpError(400, "프로젝트 패키지를 열지 못했습니다.");
  }
  const raw = entries["project.json"];
  if (!raw) throw new HttpError(400, "패키지에 project.json이 없습니다.");
  const manifest = JSON.parse(strFromU8(raw)) as {
    format?: string;
    project?: { name: string; campaignMonth: string; outputWidth: number; outputHeight: number; brief: string; constraints: string; demo?: boolean };
    assets?: Array<{ id: string; file: string; sourceSha256: string; originalFilename: string; mediaType: string; packagingVersion?: string; viewingAngle?: string; lightingNotes?: string; physicalWidthMm?: number | null; physicalHeightMm?: number | null; physicalDepthMm?: number | null; crop?: unknown; demoFixture?: boolean; hasTransparency?: boolean | null; pixelWidth?: number | null; pixelHeight?: number | null }>;
    templates?: Array<{ id: string; name: string; widthMm: number; heightMm: number; depthMm: number; sourcePage: number | null; panels: Array<{ panel: string; page: number; x: number; y: number; width: number; height: number; rotation: 0 | 90 | 180 | 270; inset: { left: number; top: number; right: number; bottom: number }; guidesEmbedded: boolean; replacementAssetId: string | null; imagePath: string | null }>; notes: string; sourceAssetId: string | null }>;
    concepts?: Array<{ source: "ai" | "manual"; name: string; rationale: string; payload: import("../../domain/types.js").ConceptPayload }>;
    analysis?: { observed: import("../../domain/types.js").Analysis["observed"]; artDirection: import("../../domain/types.js").Analysis["artDirection"]; unresolved: string[] } | null;
  };
  if (manifest.format !== PACKAGE_FORMAT || !manifest.project) {
    throw new HttpError(400, "이 앱의 프로젝트 패키지가 아닙니다.");
  }
  const projectId = createId();
  const assetMap = new Map<string, string>();
  store.createProject({
    id: projectId,
    name: `${manifest.project.name} 복원`,
    campaignMonth: manifest.project.campaignMonth,
    outputWidth: manifest.project.outputWidth,
    outputHeight: manifest.project.outputHeight,
    brief: manifest.project.brief,
    constraints: manifest.project.constraints,
    demo: Boolean(manifest.project.demo),
  });
  for (const asset of manifest.assets ?? []) {
    const packed = entries[asset.file];
    if (!packed) throw new HttpError(400, `${asset.originalFilename} 파일이 패키지에 없습니다.`);
    const buffer = Buffer.from(packed);
    if (sha256(buffer) !== asset.sourceSha256) {
      throw new HttpError(400, `${asset.originalFilename} 해시가 패키지 기록과 다릅니다.`);
    }
    const id = createId();
    assetMap.set(asset.id, id);
    const ext = path.extname(asset.file) || ".bin";
    const relative = path.join("assets", id, `source${ext}`);
    const absolute = store.absolute(relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, buffer);
    store.insertAsset({
      id,
      originalFilename: asset.originalFilename,
      sourcePath: relative.split(path.sep).join("/"),
      thumbnailPath: null,
      mediaType: asset.mediaType as "product",
      packagingVersion: asset.packagingVersion ?? "",
      hasTransparency: asset.hasTransparency ?? null,
      pixelWidth: asset.pixelWidth ?? null,
      pixelHeight: asset.pixelHeight ?? null,
      physicalWidthMm: asset.physicalWidthMm ?? null,
      physicalHeightMm: asset.physicalHeightMm ?? null,
      physicalDepthMm: asset.physicalDepthMm ?? null,
      viewingAngle: asset.viewingAngle === "front" || asset.viewingAngle === "three-quarter" ? asset.viewingAngle : "unknown",
      lightingNotes: asset.lightingNotes ?? "",
      crop: { left: 0, top: 0, right: 0, bottom: 0, bottomAnchor: 1, ...(asset.crop as object) },
      sourceSha256: asset.sourceSha256,
      demoFixture: Boolean(asset.demoFixture),
      createdAt: new Date().toISOString(),
    });
  }
  const templateMap = new Map<string, string>();
  for (const template of manifest.templates ?? []) {
    const id = createId();
    templateMap.set(template.id, id);
    const panels: import("../../domain/types.js").PanelMapping[] = template.panels.map((panel) => {
      const packed = entries[`panels/${template.id}/${panel.panel}.png`];
      let imagePath: string | null = null;
      if (packed) {
        imagePath = `assets/${id}/panels/${panel.panel}.png`;
        const absolute = store.absolute(imagePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, Buffer.from(packed));
      }
      return {
        ...panel,
        panel: panel.panel as import("../../domain/types.js").PanelId,
        imagePath,
        replacementAssetId: panel.replacementAssetId ? assetMap.get(panel.replacementAssetId) ?? null : null,
      };
    });
    const timestamp = new Date().toISOString();
    store.insertTemplate({
      id,
      name: template.name,
      widthMm: template.widthMm,
      heightMm: template.heightMm,
      depthMm: template.depthMm,
      sourceAssetId: template.sourceAssetId ? assetMap.get(template.sourceAssetId) ?? null : null,
      sourcePage: template.sourcePage,
      panels,
      revision: 1,
      notes: template.notes,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  const source = manifest.project as unknown as {
    sets: Array<{ id: string; displayName: string; boxTemplateId: string | null; visualEmphasis: "normal" | "hero"; rows: Array<{ id: string; productName: string; capacity: string; role: "box" | "full-size" | "sample" | "other"; requiredQuantity: number; assetId: string | null }> }>;
    items: Array<{ id: string; assortmentRowId: string; assetId: string | null; boxTemplateId: string | null; x: number; y: number; scale: number; layer: number; surface: string; shadow: { opacity: number; blur: number; offsetX: number; offsetY: number }; visible: boolean; rotationDeg: number }>;
    lighting: import("../../domain/types.js").Lighting;
    pedestal: import("../../domain/types.js").Pedestal;
    camera: import("../../domain/types.js").Camera;
    backgroundAssetId: string | null;
    backgroundLocked: boolean;
    backgroundGenerated: boolean;
    selectedConceptId: string | null;
  };
  const setMap = new Map<string, string>();
  const rowMap = new Map<string, string>();
  for (const set of source.sets ?? []) {
    const setId = createId();
    setMap.set(set.id, setId);
    store.createSet({
      id: setId,
      projectId,
      displayName: set.displayName,
      boxTemplateId: set.boxTemplateId ? templateMap.get(set.boxTemplateId) ?? null : null,
      visualEmphasis: set.visualEmphasis,
    });
    for (const row of set.rows) {
      const rowId = createId();
      rowMap.set(row.id, rowId);
      store.createRow({
        id: rowId,
        setId,
        productName: row.productName,
        capacity: row.capacity,
        role: row.role,
        requiredQuantity: row.requiredQuantity,
        assetId: row.assetId ? assetMap.get(row.assetId) ?? null : null,
      });
    }
  }
  store.replaceScene(projectId, (source.items ?? []).map((item) => ({
    ...item,
    id: createId(),
    projectId,
    assortmentRowId: rowMap.get(item.assortmentRowId) ?? item.assortmentRowId,
    assetId: item.assetId ? assetMap.get(item.assetId) ?? null : null,
    boxTemplateId: item.boxTemplateId ? templateMap.get(item.boxTemplateId) ?? null : null,
    surface: item.surface.replace(/pedestal:.*/, (value) => {
      const oldId = value.slice("pedestal:".length);
      return `pedestal:${setMap.get(oldId) ?? oldId}`;
    }),
  })));
  store.updateProject(projectId, {
    lighting: source.lighting,
    pedestal: source.pedestal,
    camera: source.camera,
    backgroundAssetId: source.backgroundAssetId ? assetMap.get(source.backgroundAssetId) ?? null : null,
    backgroundLocked: source.backgroundLocked,
    backgroundGenerated: source.backgroundGenerated,
    brief: manifest.project.brief,
    constraints: manifest.project.constraints,
  });
  if (manifest.analysis) {
    store.insertAnalysis({
      id: createId(),
      projectId,
      observed: manifest.analysis.observed,
      artDirection: manifest.analysis.artDirection,
      unresolved: manifest.analysis.unresolved,
      createdAt: new Date().toISOString(),
    });
  }
  for (const concept of manifest.concepts ?? []) {
    store.insertConcept({
      id: createId(),
      projectId,
      source: concept.source,
      name: concept.name,
      rationale: concept.rationale,
      payload: concept.payload,
      previewPath: null,
      createdAt: new Date().toISOString(),
    });
  }
  return store.bundle(projectId);
}
