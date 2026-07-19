import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_DIR = join(__dirname, "..", ".log");

mkdirSync(LOG_DIR, { recursive: true });

const now = new Date();
const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
const LOG_FILE = join(LOG_DIR, `log-${ts}.log`);

function formatTime() {
  return new Date().toISOString();
}

function log(...args) {
  const line = `[${formatTime()}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
  appendFileSync(LOG_FILE, line, "utf-8");
}

export default log;
