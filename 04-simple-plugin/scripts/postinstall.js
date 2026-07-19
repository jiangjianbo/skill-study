import { mkdir, cp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = resolve(__dirname, "..");
const OPENCODE_DIR = join(PROJECT_ROOT, ".opencode");
const PLUGIN_DIR = join(OPENCODE_DIR, "plugins", "04-simple-plugin");
const CONFIG_PATH = join(OPENCODE_DIR, "opencode.json");

async function deploy() {
  console.log("[deploy] Deploying plugin to .opencode/ ...");

  await mkdir(PLUGIN_DIR, { recursive: true });

  await cp(join(PROJECT_ROOT, "package.json"), join(PLUGIN_DIR, "package.json"), { recursive: true });
  await cp(join(PROJECT_ROOT, "src"), join(PLUGIN_DIR, "src"), { recursive: true });

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      config = JSON.parse(raw);
    } catch {
      config = {};
    }
  }

  const pluginRef = "./plugins/04-simple-plugin/src/index.js";
  const plugins = config.plugin || [];
  if (!plugins.includes(pluginRef)) {
    plugins.push(pluginRef);
  }
  config.plugin = plugins;
  config["$schema"] = "https://opencode.ai/config.json";

  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");

  console.log("[deploy] Plugin deployed to", PLUGIN_DIR);
  console.log("[deploy] Config written to", CONFIG_PATH);
}

deploy().catch((err) => {
  console.error("[deploy] Failed:", err);
  process.exit(1);
});
