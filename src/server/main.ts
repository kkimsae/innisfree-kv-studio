import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";

loadEnv(path.resolve(".env"));

const port = Number(process.env.PORT || 8787);
const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const { app } = createApp(dataDir);

app.listen(port, "127.0.0.1", () => {
  console.log(`INNISFREE KV Studio API http://127.0.0.1:${port}`);
});

function loadEnv(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
