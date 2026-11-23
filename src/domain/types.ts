export type Role = "box" | "full-size" | "sample" | "other";

export type PanelId = "front" | "side" | "top" | "back" | "left" | "bottom" | "other";

export type PanelRotation = 0 | 90 | 180 | 270;

export type ViewingAngle = "front" | "three-quarter" | "unknown";

export type Crop = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  bottomAnchor: number;
};

export type AssetRecord = {
  id: string;
  originalFilename: string;
  sourcePath: string;
  thumbnailPath: string | null;
  mediaType: "product" | "pdf" | "background" | "panel" | "other";
  packagingVersion: string;
  hasTransparency: boolean | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  physicalWidthMm: number | null;
  physicalHeightMm: number | null;
  physicalDepthMm: number | null;
  viewingAngle: ViewingAngle;
  lightingNotes: string;
  crop: Crop;
  sourceSha256: string;
  demoFixture: boolean;
  createdAt: string;
};

export type PanelMapping = {
  panel: PanelId;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: PanelRotation;
  inset: { left: number; top: number; right: number; bottom: number };
  guidesEmbedded: boolean;
  replacementAssetId: string | null;
  imagePath: string | null;
};

export type BoxTemplate = {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  sourceAssetId: string | null;
  sourcePage: number | null;
  panels: PanelMapping[];
  revision: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type AssortmentRow = {
  id: string;
  setId: string;
  assetId: string | null;
  productName: string;
  capacity: string;
  role: Role;
  requiredQuantity: number;
};

export type ProductSet = {
  id: string;
  projectId: string;
  displayName: string;
  boxTemplateId: string | null;
  visualEmphasis: "normal" | "hero";
  sortOrder: number;
  rows: AssortmentRow[];
};

export type ShadowSettings = {
  opacity: number;
  blur: number;
  offsetX: number;
  offsetY: number;
};

export type SceneItem = {
  id: string;
  projectId: string;
  assortmentRowId: string;
  assetId: string | null;
  boxTemplateId: string | null;
  x: number;
  y: number;
  scale: number;
  layer: number;
  surface: string;
  shadow: ShadowSettings;
  visible: boolean;
  rotationDeg: number;
};

export type Lighting = {
  direction: "left" | "right" | "front";
  softness: number;
  backgroundBrightness: number;
};

export type Pedestal = {
  shape: "rect" | "oval" | "plank";
  arrangement: "per-set" | "shared";
  height: number;
  color: string;
};

export type Camera = {
  topMargin: number;
};

export type Project = {
  id: string;
  name: string;
  campaignMonth: string;
  outputWidth: number;
  outputHeight: number;
  brief: string;
  constraints: string;
  selectedConceptId: string | null;
  backgroundAssetId: string | null;
  backgroundLocked: boolean;
  backgroundGenerated: boolean;
  lighting: Lighting;
  pedestal: Pedestal;
  camera: Camera;
  demo: boolean;
  createdAt: string;
  updatedAt: string;
  sets: ProductSet[];
  items: SceneItem[];
};

export type ConceptPayload = {
  backgroundTreatment: string;
  palette: string[];
  pedestalShape: Pedestal["shape"];
  pedestalArrangement: Pedestal["arrangement"];
  setOrder: string[];
  hierarchy: "equal" | "center-emphasis";
  spacing: "compact" | "comfortable" | "wide";
  sampleArrangement: "row" | "stack";
  lightingDirection: Lighting["direction"];
  lightingSoftness: "soft" | "medium" | "hard";
  copyArea: "top" | "left" | "right" | "none";
  angleCompatibility: string;
  unresolved: string[];
};

export type Concept = {
  id: string;
  projectId: string;
  source: "ai" | "manual";
  name: string;
  rationale: string;
  payload: ConceptPayload;
  previewPath: string | null;
  createdAt: string;
};

export type Analysis = {
  id: string;
  projectId: string;
  observed: {
    colors: string[];
    motifs: string[];
    patternDensity: string;
    typography: string;
    seasonalReferences: string[];
    boxRelationships: string;
    visualBalance: string;
  };
  artDirection: {
    summary: string;
    palette: string[];
    mood: string;
    avoid: string[];
  };
  unresolved: string[];
  createdAt: string;
};

export type Operation =
  | { op: "adjustBackgroundBrightness"; delta: number }
  | { op: "preservePlacement" }
  | { op: "preserveScale" }
  | { op: "moveSetToCenter"; setId: string }
  | { op: "expandSampleSpacing"; setId: string; factor: number }
  | { op: "nudgePedestalHeight"; delta: number }
  | { op: "nudgeTopMargin"; delta: number }
  | { op: "regenerateBackground" };

export type RevisionRecord = {
  id: string;
  projectId: string;
  index: number;
  prompt: string;
  operations: Operation[];
  createdAt: string;
};

export type VisualState = {
  items: SceneItem[];
  lighting: Lighting;
  pedestal: Pedestal;
  camera: Camera;
  backgroundAssetId: string | null;
  backgroundLocked: boolean;
  backgroundGenerated: boolean;
  selectedConceptId: string | null;
};

export type Job = {
  id: string;
  projectId: string | null;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
};

export type ValidationIssue = {
  level: "error" | "warning";
  code: string;
  message: string;
  itemId?: string;
};

export type ValidationReport = {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  visualFlags: ValidationIssue[];
  passed: boolean;
  publicationGuarantee: false;
  note: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  campaignMonth: string;
  outputWidth: number;
  outputHeight: number;
  demo: boolean;
  updatedAt: string;
  setCount: number;
  rowCount: number;
};
