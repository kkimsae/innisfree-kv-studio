import fs from "node:fs";
import OpenAI from "openai";
import sharp from "sharp";
import type { Analysis, ConceptPayload, Operation } from "../../domain/types.js";
import { HttpError } from "../errors.js";

export function aiStatus() {
  const key = process.env.OPENAI_API_KEY?.trim() ?? "";
  return {
    configured: key.length > 0,
    visionModel: process.env.OPENAI_VISION_MODEL?.trim() || "gpt-6.2-astra",
    planningModel: process.env.OPENAI_PLANNING_MODEL?.trim() || "gpt-6.2-astra",
    imageModel: process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2.5-sunburst",
    imageQuality: normalizeQuality(process.env.OPENAI_IMAGE_QUALITY),
    requiredEnv: ["OPENAI_API_KEY"],
    optionalEnv: ["OPENAI_VISION_MODEL", "OPENAI_PLANNING_MODEL", "OPENAI_IMAGE_MODEL", "OPENAI_IMAGE_QUALITY"],
  };
}

function normalizeQuality(value: string | undefined) {
  const allowed = new Set(["low", "medium", "high", "auto", "xhigh", "max"]);
  const quality = value?.trim() || "medium";
  return allowed.has(quality) ? quality : "medium";
}

export function assertAiConfigured() {
  const status = aiStatus();
  if (!status.configured) {
    throw new HttpError(
      503,
      "패키지 분석, 콘셉트 제안, 배경 생성, 예시 문장 밖의 수정 해석에는 OPENAI_API_KEY가 필요합니다. 직접 배치와 배경 업로드는 사용할 수 있습니다.",
      "ai_not_configured",
      { requiredEnv: status.requiredEnv },
    );
  }
}

function requireClient() {
  assertAiConfigured();
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" };

async function completeJson<T>(args: {
  model: string;
  system: string;
  user: ContentPart[];
  schemaName: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  const openai = requireClient();
  const response = await openai.responses.create({
    model: args.model,
    input: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
    text: {
      format: {
        type: "json_schema",
        name: args.schemaName,
        strict: true,
        schema: args.schema,
      },
    },
  }, { signal: args.signal });
  const text = response.output_text?.trim();
  if (!text) throw new Error("모델이 구조화된 결과를 돌려주지 않았습니다.");
  return JSON.parse(text) as T;
}

export async function imageToDataUrl(filePath: string) {
  const resized = await sharp(filePath).resize({ width: 768, height: 768, fit: "inside" }).png().toBuffer();
  return `data:image/png;base64,${resized.toString("base64")}`;
}

const stringArray = { type: "array", items: { type: "string" } };

export async function analyzePackaging(input: {
  assortmentText: string;
  imagePaths: string[];
  signal?: AbortSignal;
}): Promise<Omit<Analysis, "id" | "projectId" | "createdAt">> {
  if (!input.imagePaths.length) {
    throw new HttpError(400, "분석할 패키지 면 이미지가 없습니다. 먼저 PDF에서 면을 지정하세요.");
  }
  const status = aiStatus();
  const images: ContentPart[] = [];
  for (const filePath of input.imagePaths.slice(0, 8)) {
    if (!fs.existsSync(filePath)) continue;
    images.push({ type: "input_image", image_url: await imageToDataUrl(filePath), detail: "auto" });
  }
  if (!images.length) throw new HttpError(400, "패키지 이미지를 읽지 못했습니다.");
  const result = await completeJson<{
    observed: Analysis["observed"];
    artDirection: Analysis["artDirection"];
    unresolved: string[];
  }>({
    model: status.visionModel,
    schemaName: "packaging_analysis",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["observed", "artDirection", "unresolved"],
      properties: {
        observed: {
          type: "object",
          additionalProperties: false,
          required: ["colors", "motifs", "patternDensity", "typography", "seasonalReferences", "boxRelationships", "visualBalance"],
          properties: {
            colors: stringArray,
            motifs: stringArray,
            patternDensity: { type: "string" },
            typography: { type: "string" },
            seasonalReferences: stringArray,
            boxRelationships: { type: "string" },
            visualBalance: { type: "string" },
          },
        },
        artDirection: {
          type: "object",
          additionalProperties: false,
          required: ["summary", "palette", "mood", "avoid"],
          properties: {
            summary: { type: "string" },
            palette: stringArray,
            mood: { type: "string" },
            avoid: stringArray,
          },
        },
        unresolved: stringArray,
      },
    },
    system: [
      "당신은 승인된 패키지 아트워크만 보고 미술 방향을 정리합니다.",
      "관찰과 제안과 미확정 정보를 나누세요.",
      "보이지 않는 제품명, 용량, 수량, 치수, 옆면, 뒷면 문구를 만들지 마세요.",
      "제공된 구색 목록 밖의 제품을 추가하지 마세요.",
      "모든 문장은 한국어로 쓰세요.",
    ].join("\n"),
    user: [
      { type: "input_text", text: `현재 구색(권위 있는 목록):\n${input.assortmentText}\n이미지에 보이는 패키지만 분석하세요.` },
      ...images,
    ],
    signal: input.signal,
  });
  return result;
}

export async function proposeConcepts(input: {
  assortmentText: string;
  setIds: { id: string; displayName: string }[];
  analysis: Omit<Analysis, "id" | "projectId" | "createdAt">;
  angles: string;
  signal?: AbortSignal;
}) {
  const status = aiStatus();
  const result = await completeJson<{ concepts: Array<ConceptPayload & { name: string; rationale: string }> }>({
    model: status.planningModel,
    schemaName: "hero_concepts",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["concepts"],
      properties: {
        concepts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "name", "rationale", "backgroundTreatment", "palette", "pedestalShape", "pedestalArrangement",
              "setOrder", "hierarchy", "spacing", "sampleArrangement", "lightingDirection", "lightingSoftness",
              "copyArea", "angleCompatibility", "unresolved",
            ],
            properties: {
              name: { type: "string" },
              rationale: { type: "string" },
              backgroundTreatment: { type: "string" },
              palette: stringArray,
              pedestalShape: { type: "string", enum: ["rect", "oval", "plank"] },
              pedestalArrangement: { type: "string", enum: ["per-set", "shared"] },
              setOrder: stringArray,
              hierarchy: { type: "string", enum: ["equal", "center-emphasis"] },
              spacing: { type: "string", enum: ["compact", "comfortable", "wide"] },
              sampleArrangement: { type: "string", enum: ["row", "stack"] },
              lightingDirection: { type: "string", enum: ["left", "right", "front"] },
              lightingSoftness: { type: "string", enum: ["soft", "medium", "hard"] },
              copyArea: { type: "string", enum: ["top", "left", "right", "none"] },
              angleCompatibility: { type: "string" },
              unresolved: stringArray,
            },
          },
        },
      },
    },
    system: [
      "월간 히어로의 콘셉트 3개를 제안합니다.",
      "제품 이미지나 박스 그림을 새로 묘사하지 마세요. 배치, 단상, 조명, 배경 분위기만 말하세요.",
      "setOrder에는 제공된 세트 id만 쓰세요.",
      "서로 구분되는 세 가지여야 합니다.",
      "한국어로 쓰세요.",
    ].join("\n"),
    user: [{
      type: "input_text",
      text: JSON.stringify({
        sets: input.setIds,
        assortment: input.assortmentText,
        analysis: input.analysis,
        sourceAngles: input.angles,
      }),
    }],
    signal: input.signal,
  });
  if (!Array.isArray(result.concepts) || result.concepts.length < 3) {
    throw new Error("콘셉트 3개를 받지 못했습니다. 성공으로 처리하지 않습니다.");
  }
  return result.concepts.slice(0, 3).map((concept) => {
    const known = new Set(input.setIds.map((set) => set.id));
    const setOrder = concept.setOrder.filter((id) => known.has(id));
    const unresolved = [...concept.unresolved];
    if (setOrder.length !== concept.setOrder.length) unresolved.push("알 수 없는 세트 순서는 무시했습니다.");
    return { ...concept, setOrder, unresolved };
  });
}

export async function interpretRevision(input: {
  prompt: string;
  sets: { id: string; displayName: string }[];
  signal?: AbortSignal;
}) {
  const status = aiStatus();
  const result = await completeJson<{
    operations: Array<{
      op: "adjustBackgroundBrightness" | "preservePlacement" | "preserveScale" | "moveSetToCenter" | "expandSampleSpacing" | "nudgePedestalHeight" | "nudgeTopMargin" | "regenerateBackground";
      setId: string;
      delta: number;
      factor: number;
    }>;
    unresolved: string[];
  }>({
    model: status.planningModel,
    schemaName: "revision_ops",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["operations", "unresolved"],
      properties: {
        unresolved: stringArray,
        operations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["op", "setId", "delta", "factor"],
            properties: {
              op: {
                type: "string",
                enum: [
                  "adjustBackgroundBrightness",
                  "preservePlacement",
                  "preserveScale",
                  "moveSetToCenter",
                  "expandSampleSpacing",
                  "nudgePedestalHeight",
                  "nudgeTopMargin",
                  "regenerateBackground",
                ],
              },
              setId: { type: "string" },
              delta: { type: "number" },
              factor: { type: "number" },
            },
          },
        },
      },
    },
    system: [
      "한국어 수정 문장을 허용된 작업으로만 바꿉니다.",
      "수량, 제품 추가, 자산 교체, 비율 변형은 만들지 마세요.",
      "세트가 필요하면 제공된 id를 setId에 넣으세요. 필요 없으면 빈 문자열입니다.",
      "해당 없는 숫자는 0입니다.",
    ].join("\n"),
    user: [{ type: "input_text", text: JSON.stringify({ prompt: input.prompt, sets: input.sets }) }],
    signal: input.signal,
  });
  const known = new Set(input.sets.map((set) => set.id));
  const operations: Operation[] = [];
  const unresolved = [...result.unresolved];
  for (const operation of result.operations) {
    if ((operation.op === "moveSetToCenter" || operation.op === "expandSampleSpacing") && !known.has(operation.setId)) {
      unresolved.push("요청한 세트를 찾지 못해 그 이동은 적용하지 않았습니다.");
      continue;
    }
    if (operation.op === "adjustBackgroundBrightness") operations.push({ op: operation.op, delta: clamp(operation.delta, -0.4, 0.4) });
    else if (operation.op === "nudgePedestalHeight") operations.push({ op: operation.op, delta: clamp(operation.delta, -0.08, 0.08) });
    else if (operation.op === "nudgeTopMargin") operations.push({ op: operation.op, delta: clamp(operation.delta, -0.12, 0.12) });
    else if (operation.op === "expandSampleSpacing") operations.push({ op: operation.op, setId: operation.setId, factor: clamp(operation.factor || 1.4, 1.05, 2) });
    else if (operation.op === "moveSetToCenter") operations.push({ op: operation.op, setId: operation.setId });
    else operations.push({ op: operation.op });
  }
  return { operations, unresolved };
}

export async function reviewComposite(input: { imagePath: string; signal?: AbortSignal }) {
  const status = aiStatus();
  return completeJson<{ flags: string[]; unresolved: string[] }>({
    model: status.visionModel,
    schemaName: "visual_notes",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["flags", "unresolved"],
      properties: { flags: stringArray, unresolved: stringArray },
    },
    system: "합성 히어로의 시각 메모만 한국어로 적으세요. 출판 가능하다고 단정하지 마세요. 수량 검증은 하지 마세요. 배경에 제품처럼 보이는 형태, 떠 보임, 라벨, 그림자, 원근을 짧게 적으세요.",
    user: [
      { type: "input_text", text: "이 미리보기의 시각적 위험만 적으세요." },
      { type: "input_image", image_url: await imageToDataUrl(input.imagePath), detail: "auto" },
    ],
    signal: input.signal,
  });
}

export async function generateBackgroundImage(input: { prompt: string; size: string; signal?: AbortSignal }) {
  const status = aiStatus();
  const openai = requireClient();
  const result = await openai.images.generate({
    model: status.imageModel,
    prompt: input.prompt,
    size: input.size as "1024x1024",
    quality: status.imageQuality as "medium",
    output_format: "png",
    background: "opaque",
    n: 1,
  }, { signal: input.signal });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("배경 생성 응답에 이미지가 없습니다. 성공으로 처리하지 않습니다.");
  return Buffer.from(b64, "base64");
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}
