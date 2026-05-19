import { stdin, stdout } from "node:process";
import type { ScorerSpec } from "../spec/parse.js";
import type { ScoreResult } from "./types.js";

/**
 * The always-present scorer. Prompts the user for a number and an
 * optional note. Returns null score if the user enters nothing or a
 * non-number.
 */
export async function humanScorer(_spec: ScorerSpec): Promise<ScoreResult> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stdout });
  let score: number | null = null;
  let note: string | undefined;
  try {
    const raw = (await rl.question("realized score? (number, blank to skip) > ")).trim();
    if (raw.length > 0) {
      const parsed = Number(raw);
      if (!Number.isNaN(parsed)) score = parsed;
    }
    const n = (await rl.question("note? (optional, single line) > ")).trim();
    if (n.length > 0) note = n;
  } finally {
    rl.close();
  }
  return { score, note };
}
