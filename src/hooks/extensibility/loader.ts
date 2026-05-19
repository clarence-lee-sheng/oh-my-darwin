import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DARWIN_DIR, PLUGINS_DIR } from "../../cli/constants.js";
import { formatErrorSummary } from "../../runtime/diagnostics.js";
import { writeTerminalError } from "../../runtime/terminal.js";
import type { DarwinPlugin } from "./sdk.js";

/**
 * Discover plugins under <cwd>/.darwin/plugins/*.mjs. v0 only looks
 * per-project; a global ~/.darwin/plugins/ could be added later.
 */
export async function loadPlugins(cwd: string = process.cwd()): Promise<DarwinPlugin[]> {
  const dir = resolve(cwd, DARWIN_DIR, PLUGINS_DIR);

  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) =>
        entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js"))
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const plugins: DarwinPlugin[] = [];

  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href);
      const p = (mod.default ?? mod) as DarwinPlugin;
      if (p && typeof p === "object" && p.name && p.handlers) {
        plugins.push(p);
      }
    } catch (err) {
      writeTerminalError(
        `darwin: failed to load plugin ${formatPluginFilename(f)}: ${formatErrorSummary(err)}`,
      );
    }
  }
  return plugins;
}

function formatPluginFilename(filename: string): string {
  return formatErrorSummary(filename);
}
