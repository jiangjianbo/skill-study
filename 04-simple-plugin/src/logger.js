import fs from "node:fs";
import path from "node:path";

export function createLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const logPath = path.join(logDir, `log-${ts}.log`);

  return (...args) => {
    const t = new Date().toISOString();
    const line = `[${t}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  };
}
