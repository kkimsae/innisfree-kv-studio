export function projectFilename(
  project: { campaignMonth: string; name: string },
  kind: string,
  ext: string,
) {
  const base = `${project.campaignMonth}-${project.name}-${kind}`
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "project"}.${ext}`;
}
