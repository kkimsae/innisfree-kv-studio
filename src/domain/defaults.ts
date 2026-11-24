import type { Camera, Crop, Lighting, Pedestal, ShadowSettings } from "./types.js";

export const DEFAULT_CROP: Crop = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  bottomAnchor: 1,
};

export const DEFAULT_LIGHTING: Lighting = {
  direction: "left",
  softness: 0.65,
  backgroundBrightness: 1,
};

export const DEFAULT_PEDESTAL: Pedestal = {
  shape: "plank",
  arrangement: "per-set",
  height: 0.07,
  color: "#e4ddd2",
};

export const DEFAULT_CAMERA: Camera = {
  topMargin: 0.06,
};

export function defaultShadow(lighting: Lighting = DEFAULT_LIGHTING): ShadowSettings {
  return {
    opacity: 0.34,
    blur: 0.012 + lighting.softness * 0.02,
    offsetX: lighting.direction === "left" ? 0.012 : lighting.direction === "right" ? -0.012 : 0,
    offsetY: 0.008,
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
