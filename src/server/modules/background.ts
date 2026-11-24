import type { Concept, Project } from "../../domain/types.js";

export function backgroundPrompt(project: Project, concept: Concept | null) {
  const palette = concept?.payload.palette.length ? concept.payload.palette.join(", ") : "warm paper, soft gray-green";
  const treatment = concept?.payload.backgroundTreatment || project.brief || "quiet daylight studio sweep";
  const copy = concept?.payload.copyArea === "none"
    ? "Balanced negative space."
    : `Keep the ${concept?.payload.copyArea ?? "top"} area empty for later typography. Do not draw that typography.`;
  return [
    "Empty photographed backdrop for a commercial still-life. Environment only.",
    "No products, bottles, jars, tubes, pumps, droppers, boxes, cartons, packaging, labels, logos, letters, numbers, promotional text, people, hands, pedestals, plinths, shelves, or cosmetic props.",
    "The application draws the products, approved boxes, and pedestals separately. Do not paint them.",
    `Palette: ${palette}.`,
    `Atmosphere without objects: ${treatment}.`,
    `Light direction ${project.lighting.direction}, softness ${project.lighting.softness}.`,
    "Straight-on camera, low horizon, realistic, quiet, no collage.",
    copy,
  ].join(" ");
}

export function snapImageSize(width: number, height: number) {
  const aspect = width / Math.max(1, height);
  const maxEdge = 1536;
  let nextWidth = aspect >= 1 ? maxEdge : Math.round(maxEdge * aspect);
  let nextHeight = aspect >= 1 ? Math.round(maxEdge / aspect) : maxEdge;
  const quantize = (value: number) => Math.max(16, Math.round(value / 16) * 16);
  nextWidth = quantize(nextWidth);
  nextHeight = quantize(nextHeight);
  const ratio = nextWidth / nextHeight;
  if (ratio > 3 || ratio < 1 / 3) return "1536x1024";
  return `${nextWidth}x${nextHeight}`;
}
