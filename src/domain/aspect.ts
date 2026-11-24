import type { Crop } from "./types.js";

export function sizeForHeight(sourceWidth: number, sourceHeight: number, targetHeight: number) {
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(targetHeight > 0)) {
    throw new Error("원본 비율을 계산할 수 없습니다.");
  }
  const height = targetHeight;
  const width = targetHeight * (sourceWidth / sourceHeight);
  return { width, height };
}

export function aspectRatio(width: number, height: number) {
  if (!(height > 0)) throw new Error("높이가 없습니다.");
  return width / height;
}

export function ratiosMatch(a: number, b: number, tolerance = 0.02) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-6);
  return Math.abs(a - b) / scale <= tolerance;
}

export function croppedPixelSize(pixelWidth: number, pixelHeight: number, crop: Crop) {
  const width = pixelWidth * (1 - crop.left - crop.right);
  const height = pixelHeight * (1 - crop.top - crop.bottom);
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

export function assertUniformScale(scale: unknown): number {
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
    throw new Error("스케일은 0보다 큰 하나의 숫자여야 합니다. 가로나 세로를 따로 늘리지 않습니다.");
  }
  return scale;
}

export function assertNoUnsupportedRotation(rotationDeg: number) {
  if (rotationDeg !== 0) {
    throw new Error("공급된 각도를 유지합니다. 사진 한 장으로 보이지 않는 면을 만들지 않습니다.");
  }
}
