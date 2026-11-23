import type { PanelRotation } from "./types.js";

export const CABINET = {
  depthScale: 0.5,
  lift: 0.22,
};

export function uprightPixelSize(width: number, height: number, rotation: PanelRotation) {
  if (rotation === 90 || rotation === 270) return { width: height, height: width };
  return { width, height };
}

export function boxFacePixels(
  mm: { widthMm: number; heightMm: number; depthMm: number },
  pxPerMm: number,
  scale: number,
) {
  const factor = pxPerMm * scale;
  return {
    front: { width: mm.widthMm * factor, height: mm.heightMm * factor },
    side: { width: mm.depthMm * factor, height: mm.heightMm * factor },
    top: { width: mm.widthMm * factor, height: mm.depthMm * factor },
  };
}

export function boxSpriteSize(faces: ReturnType<typeof boxFacePixels>) {
  const screenSide = faces.side.width * CABINET.depthScale;
  const screenTop = faces.top.height * CABINET.depthScale;
  const lift = faces.side.width * CABINET.lift;
  return {
    width: faces.front.width + screenSide,
    height: faces.front.height + screenTop,
    screenSide,
    screenTop,
    lift,
    frontWidth: faces.front.width,
    frontHeight: faces.front.height,
  };
}

export function isPanelRotation(value: number): value is PanelRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}
