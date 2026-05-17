import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EVENTS_LOG, DARWIN_DIR } from "../../cli/constants.js";
import { loadPlugins } from "./loader.js";
import type { HookPayload, DarwinPlugin, LifecycleEvent } from "./sdk.js";

let pluginsCache: DarwinPlugin[] | null = null;

async function getPlugins(): Promise<DarwinPlugin[]> {
  if (pluginsCache === null) pluginsCache = await loadPlugins();
  return pluginsCache;
}

function logEvent(event: string, payload: HookPayload): void {
  const path = resolve(process.cwd(), DARWIN_DIR, EVENTS_LOG);
  mkdirSync(dirname(path), { recursive: true });
  const record = { t: new Date().toISOString(), event, ...payload };
  appendFileSync(path, JSON.stringify(record) + "\n");
}

/**
 * Single fan-out point. Always logs (built-in observer), then invokes
 * each loaded plugin's matching handler. Plugin failures are isolated.
 */
export async function dispatch(event: LifecycleEvent, payload: HookPayload): Promise<void> {
  logEvent(event, payload);

  const plugins = await getPlugins();
  for (const p of plugins) {
    const h = p.handlers[event];
    if (!h) continue;
    try {
      await h(payload);
    } catch (err) {
      process.stderr.write(`darwin: plugin ${p.name} ${event} failed: ${err}\n`);
    }
  }
}
