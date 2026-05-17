import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Harness {
  buildPrompt(task: string): string;
  /**
   * Optional. Returns a short hint that the NEXT iteration's proposer will
   * see as advisory context. Empty / missing return means no hint.
   */
  suggestNextHypothesis?(): string;
}

/**
 * Dynamic-import a harness file and verify the bare minimum:
 *  - file exists
 *  - default export is an object with a buildPrompt function
 *  - smoke call returns a non-empty string and doesn't throw
 *
 * Returns the validated harness. Throws with a useful message on failure.
 *
 * Cache-busts the URL with `?t=<timestamp>` so successive imports of the
 * same path pick up file changes between iterations.
 */
export async function loadAndValidate(path: string): Promise<Harness> {
  if (!existsSync(path)) {
    throw new Error(`harness file missing: ${path}`);
  }

  const url = pathToFileURL(path).href + `?t=${Date.now()}`;
  const mod = await import(url);
  const h = mod.default;

  if (!h || typeof h !== "object") {
    throw new Error("harness must default-export an object");
  }
  if (typeof h.buildPrompt !== "function") {
    throw new Error("harness must export buildPrompt(task): string");
  }
  if (h.suggestNextHypothesis !== undefined && typeof h.suggestNextHypothesis !== "function") {
    throw new Error("suggestNextHypothesis, if provided, must be a function");
  }

  let result: unknown;
  try {
    result = h.buildPrompt("smoketest");
  } catch (e) {
    throw new Error(`buildPrompt threw on smoketest: ${e}`);
  }
  if (typeof result !== "string" || result.length === 0) {
    throw new Error("buildPrompt did not return a non-empty string on smoketest");
  }

  return h as Harness;
}
