export function normalizedToPixel(normalized: number, size: number) {
  return normalized * size;
}

export function pixelToNormalized(pixel: number, size: number) {
  if (!(size > 0)) throw new Error("출력 크기가 없습니다.");
  return pixel / size;
}

export function sameRelativePoint(
  normalized: number,
  sizeA: number,
  sizeB: number,
) {
  const a = normalizedToPixel(normalized, sizeA) / sizeA;
  const b = normalizedToPixel(normalized, sizeB) / sizeB;
  return Math.abs(a - b) < 1e-9;
}
