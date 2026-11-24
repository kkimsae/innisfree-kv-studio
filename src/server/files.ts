import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  return sha256(fs.readFileSync(filePath));
}

export function safeJoin(root: string, ...parts: string[]) {
  const resolved = path.resolve(root, ...parts);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("경로가 데이터 폴더 밖을 가리킵니다.");
  }
  return resolved;
}

export function extensionFor(filename: string, mime: string) {
  const fromName = path.extname(filename).toLowerCase();
  if (fromName === ".png" || fromName === ".jpg" || fromName === ".jpeg" || fromName === ".webp" || fromName === ".pdf") {
    return fromName === ".jpeg" ? ".jpg" : fromName;
  }
  if (mime === "application/pdf") return ".pdf";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/png") return ".png";
  return ".bin";
}

export function isAiFilename(filename: string) {
  return path.extname(filename).toLowerCase() === ".ai";
}
