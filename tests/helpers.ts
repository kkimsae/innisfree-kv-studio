import { DEFAULT_CAMERA, DEFAULT_LIGHTING, DEFAULT_PEDESTAL, defaultShadow } from "../src/domain/defaults.js";
import type { AssetRecord, BoxTemplate, ProductSet, Project, Role, SceneItem } from "../src/domain/types.js";

export function item(partial: Partial<SceneItem> & Pick<SceneItem, "id" | "assortmentRowId">): SceneItem {
  return {
    projectId: "p",
    assetId: null,
    boxTemplateId: null,
    x: 0.5,
    y: 0.75,
    scale: 1,
    layer: 10,
    surface: "pedestal:set",
    shadow: defaultShadow(),
    visible: true,
    rotationDeg: 0,
    ...partial,
  };
}

export function row(id: string, setId: string, role: Role, quantity: number, assetId: string | null = null, name = id) {
  return { id, setId, assetId, productName: name, capacity: role === "box" ? "" : "50 ml", role, requiredQuantity: quantity };
}

export function project(sets: ProductSet[], items: SceneItem[], patch: Partial<Project> = {}): Project {
  return {
    id: "p",
    name: "테스트",
    campaignMonth: "2099-01",
    outputWidth: 1280,
    outputHeight: 720,
    brief: "",
    constraints: "",
    selectedConceptId: null,
    backgroundAssetId: null,
    backgroundLocked: false,
    backgroundGenerated: false,
    lighting: DEFAULT_LIGHTING,
    pedestal: DEFAULT_PEDESTAL,
    camera: DEFAULT_CAMERA,
    demo: false,
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    sets,
    items,
    ...patch,
  };
}

export function asset(partial: Partial<AssetRecord> & Pick<AssetRecord, "id">): AssetRecord {
  return {
    originalFilename: "product.png",
    sourcePath: "assets/x/source.png",
    thumbnailPath: null,
    mediaType: "product",
    packagingVersion: "",
    hasTransparency: true,
    pixelWidth: 40,
    pixelHeight: 80,
    physicalWidthMm: null,
    physicalHeightMm: 140,
    physicalDepthMm: null,
    viewingAngle: "front",
    lightingNotes: "",
    crop: { left: 0, top: 0, right: 0, bottom: 0, bottomAnchor: 1 },
    sourceSha256: "abc",
    demoFixture: true,
    createdAt: "2099-01-01T00:00:00.000Z",
    ...partial,
  };
}

export function template(partial: Partial<BoxTemplate> & Pick<BoxTemplate, "id">): BoxTemplate {
  return {
    name: "박스",
    widthMm: 80,
    heightMm: 120,
    depthMm: 40,
    sourceAssetId: null,
    sourcePage: 1,
    panels: [
      { panel: "front", page: 1, x: 0, y: 0, width: 0.2, height: 0.4, rotation: 0, inset: { left: 0, top: 0, right: 0, bottom: 0 }, guidesEmbedded: false, replacementAssetId: null, imagePath: "panels/front.png" },
      { panel: "side", page: 1, x: 0.3, y: 0, width: 0.1, height: 0.4, rotation: 0, inset: { left: 0, top: 0, right: 0, bottom: 0 }, guidesEmbedded: false, replacementAssetId: null, imagePath: "panels/side.png" },
      { panel: "top", page: 1, x: 0, y: 0.5, width: 0.2, height: 0.1, rotation: 0, inset: { left: 0, top: 0, right: 0, bottom: 0 }, guidesEmbedded: false, replacementAssetId: null, imagePath: "panels/top.png" },
    ],
    revision: 1,
    notes: "",
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    ...partial,
  };
}
