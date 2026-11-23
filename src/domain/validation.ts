import { croppedPixelSize, ratiosMatch } from "./aspect.js";
import { buildRenderPlan, type PlanInput, type PlacedItem } from "./plan.js";
import type { AssetRecord, ValidationIssue, ValidationReport } from "./types.js";

const NOTE = "자동 검증은 출판 품질을 보장하지 않습니다. 인스턴스 수와 화면에 보이는 수는 다를 수 있으며, 아래 항목을 직접 확인하세요.";

export function validateProject(
  input: PlanInput,
  readHash?: (asset: AssetRecord) => string | null,
): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const visualFlags: ValidationIssue[] = [];
  const rows = input.project.sets.flatMap((set) => set.rows.map((row) => ({ ...row, setName: set.displayName })));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const counts = new Map<string, number>();

  if (input.project.outputWidth < 64 || input.project.outputHeight < 64) {
    errors.push(issue("error", "output-size", "출력 크기가 너무 작습니다."));
  }

  for (const item of input.project.items) {
    counts.set(item.assortmentRowId, (counts.get(item.assortmentRowId) ?? 0) + 1);
    const row = rowById.get(item.assortmentRowId);
    if (!row) {
      errors.push(issue("error", "unknown-instance", "구색에 없는 장면 객체가 있습니다.", item.id));
      continue;
    }
    if (row.role === "box") {
      if (item.assetId) {
        errors.push(issue("error", "box-illustration", `${row.productName}: 박스 인쇄면은 별도 제품 인스턴스가 될 수 없습니다.`, item.id));
      }
      const template = item.boxTemplateId ? input.templates.get(item.boxTemplateId) : undefined;
      const set = input.project.sets.find((candidate) => candidate.id === row.setId);
      if (!template) errors.push(issue("error", "box-template", `${row.productName}: 박스 템플릿이 없습니다.`, item.id));
      else if (set?.boxTemplateId && set.boxTemplateId !== item.boxTemplateId) {
        errors.push(issue("error", "box-template", `${row.productName}: 장면의 박스 치수가 세트 템플릿과 다릅니다.`, item.id));
      }
    } else if (item.assetId !== row.assetId) {
      errors.push(issue("error", "asset-mismatch", `${row.productName}: 장면에 구색과 다른 자산이 연결되어 있습니다.`, item.id));
    }
    if (!item.visible) errors.push(issue("error", "hidden-required", `${row.productName}: 필수 객체가 숨겨져 있습니다.`, item.id));
    if (item.rotationDeg !== 0) {
      errors.push(issue("error", "rotation", `${row.productName}: 원본에 없는 회전입니다.`, item.id));
    }
    if (!(item.scale > 0)) errors.push(issue("error", "scale", `${row.productName}: 균일 스케일이 아닙니다.`, item.id));
    if (row.capacity.trim() === "" && row.role !== "box") {
      warnings.push(issue("warning", "capacity", `${row.productName}: 용량이 비어 있습니다. 값을 만들지 않았습니다.`));
    }
  }

  for (const row of rows) {
    const found = counts.get(row.id) ?? 0;
    if (found !== row.requiredQuantity) {
      errors.push(issue(
        "error",
        "quantity",
        `${row.setName} / ${row.productName}: 인스턴스가 ${row.requiredQuantity}개여야 하는데 ${found}개입니다.`,
      ));
    }
  }

  for (const asset of input.assets.values()) {
    if (asset.mediaType !== "product" && asset.mediaType !== "pdf" && asset.mediaType !== "background") continue;
    if (!readHash) continue;
    const actual = readHash(asset);
    if (!actual) {
      errors.push(issue("error", "missing-source", `${asset.originalFilename}: 원본 파일을 찾을 수 없습니다.`));
    } else if (actual !== asset.sourceSha256) {
      errors.push(issue("error", "source-changed", `${asset.originalFilename}: 원본 파일이 저장된 뒤에 바뀌었습니다.`));
    }
  }

  let planItems: PlacedItem[] = [];
  try {
    const plan = buildRenderPlan(input);
    if (plan.width !== input.project.outputWidth || plan.height !== input.project.outputHeight) {
      errors.push(issue("error", "output-size", "렌더 크기가 프로젝트 출력 크기와 다릅니다."));
    }
    planItems = plan.items;
    for (const placed of plan.items) {
      checkGeometry(placed, input, errors, warnings);
    }
    visualHeuristics(plan.items, input.project.outputWidth, input.project.outputHeight, visualFlags);
  } catch (error) {
    errors.push(issue("error", "plan", error instanceof Error ? error.message : "장면 계산에 실패했습니다."));
  }

  return {
    errors,
    warnings,
    visualFlags,
    passed: errors.length === 0,
    publicationGuarantee: false,
    note: NOTE,
  };
}

function checkGeometry(placed: PlacedItem, input: PlanInput, errors: ValidationIssue[], warnings: ValidationIssue[]) {
  if (placed.boxFaces) {
    const { front, side, top, widthMm, heightMm, depthMm } = placed.boxFaces;
    if (!ratiosMatch(front.width / front.height, widthMm / heightMm)) {
      errors.push(issue("error", "box-aspect", `${placed.name}: 앞면 비율이 템플릿 치수와 다릅니다.`, placed.id));
    }
    if (!ratiosMatch(side.width / side.height, depthMm / heightMm)) {
      errors.push(issue("error", "box-aspect", `${placed.name}: 옆면 비율이 템플릿 치수와 다릅니다.`, placed.id));
    }
    if (!ratiosMatch(top.width / top.height, widthMm / depthMm)) {
      errors.push(issue("error", "box-aspect", `${placed.name}: 윗면 비율이 템플릿 치수와 다릅니다.`, placed.id));
    }
  } else if (!placed.missingAsset && placed.role !== "box") {
    const asset = placed.assetId ? input.assets.get(placed.assetId) : undefined;
    if (asset?.pixelWidth && asset.pixelHeight) {
      const cropped = croppedPixelSize(asset.pixelWidth, asset.pixelHeight, asset.crop);
      const expected = cropped.width / cropped.height;
      if (!ratiosMatch(placed.displayWidth / placed.displayHeight, expected)) {
        errors.push(issue("error", "aspect", `${placed.name}: 원본 비율이 늘어나거나 줄었습니다.`, placed.id));
      }
    }
  }

  const centerOutside = placed.anchorX < 0 || placed.anchorY < 0 || placed.anchorX > input.project.outputWidth || placed.anchorY > input.project.outputHeight;
  if (centerOutside) errors.push(issue("error", "bounds", `${placed.name}: 기준점이 출력 영역 밖에 있습니다.`, placed.id));
  const partial = placed.left < 0 || placed.top < 0 || placed.left + placed.width > input.project.outputWidth || placed.top + placed.height > input.project.outputHeight;
  if (partial && !centerOutside) warnings.push(issue("warning", "bounds", `${placed.name}: 일부가 출력 가장자리 밖으로 나갑니다.`, placed.id));
}

function visualHeuristics(items: PlacedItem[], width: number, height: number, flags: ValidationIssue[]) {
  const visible = items.filter((item) => item.visible && item.role !== "box");
  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      const overlap = iou(visible[i], visible[j]);
      if (overlap > 0.55) {
        flags.push(issue("warning", "overlap", `${visible[i].name}와 ${visible[j].name}가 많이 겹칩니다. 가려졌는지는 따로 봐야 합니다.`));
      }
    }
    if (visible[i].height < height * 0.045) {
      flags.push(issue("warning", "label", `${visible[i].name}: 표시 높이가 낮아 라벨을 읽기 어려울 수 있습니다.`, visible[i].id));
    }
  }
  for (const item of items) {
    if (item.shadow.opacity < 0.05) {
      flags.push(issue("warning", "shadow", `${item.name}: 접촉 그림자가 거의 없습니다.`, item.id));
    }
    if (item.role !== "box" && item.anchorY < height * 0.35) {
      flags.push(issue("warning", "floating", `${item.name}: 바닥에서 떠 보일 수 있습니다.`, item.id));
    }
  }
  if (width > 0) {
    flags.push(issue("warning", "review-limit", "시각 휴리스틱은 출판 품질을 보장하지 않습니다. 배경 속 제품처럼 보이는 형태는 자동으로 단정하지 않습니다."));
  }
}

function iou(a: PlacedItem, b: PlacedItem) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return 0;
  const intersection = w * h;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function issue(level: ValidationIssue["level"], code: string, message: string, itemId?: string): ValidationIssue {
  return { level, code, message, itemId };
}

export function exportQualityWarnings(input: PlanInput) {
  const plan = buildRenderPlan(input);
  const warnings: ValidationIssue[] = [];
  for (const placed of plan.items) {
    if (placed.missingAsset || placed.role === "box") continue;
    if (placed.displayHeight > placed.sourceHeight * 1.2) {
      warnings.push(issue(
        "warning",
        "resolution",
        `${placed.name}: 출력에서 원본보다 크게 확대됩니다. 가장자리와 글자가 부드러워질 수 있습니다.`,
        placed.id,
      ));
    }
  }
  const background = input.project.backgroundAssetId ? input.assets.get(input.project.backgroundAssetId) : undefined;
  if (background?.pixelWidth && background.pixelHeight) {
    const actual = background.pixelWidth / background.pixelHeight;
    const expected = input.project.outputWidth / input.project.outputHeight;
    if (!ratiosMatch(actual, expected, 0.08)) {
      warnings.push(issue("warning", "background-aspect", "배경 비율이 출력 비율과 달라 맞출 때 가장자리가 잘립니다."));
    }
    if (background.pixelWidth < input.project.outputWidth || background.pixelHeight < input.project.outputHeight) {
      warnings.push(issue("warning", "background-resolution", "배경 원본이 출력 크기보다 작아 확대됩니다."));
    }
  }
  return warnings;
}
