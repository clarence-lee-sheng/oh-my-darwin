import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DARWIN_DIR, PLUGINS_DIR } from "../../cli/constants.js";
import type { DarwinPlugin } from "./sdk.js";

/**
 * Discover plugins under <cwd>/.darwin/plugins/*.mjs. v0 only looks
 * per-project; a global ~/.darwin/plugins/ could be added later.
 */
export async function loadPlugins(): Promise<DarwinPlugin[]> {
  const dir = resolve(process.cwd(), DARWIN_DIR, PLUGINS_DIR);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
  const plugins: DarwinPlugin[] = [];

  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href);
      const p = (mod.default ?? mod) as DarwinPlugin;
      if (p && typeof p === "object" && p.name && p.handlers) {
        plugins.push(p);
      }
    } catch (err) {
      process.stderr.write(`darwin: failed to load plugin ${f}: ${err}\n`);
    }
  }
  return plugins;
}
