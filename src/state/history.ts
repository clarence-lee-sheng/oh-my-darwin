import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVOLUTION_FILE, DARWIN_DIR } from "../cli/constants.js";

export interface EvolutionRow {
  t: string;
  attempt_id: string;
  /** Score realized for this attempt; null if not scored. */
  score: number | null;
  /** Outcome category for fast filtering. */
  outcome: "scored" | "skipped" | "failed" | "rejected";
  /** Optional human note. */
  note?: string;
  /** Path (relative to .darwin/) of the attempt's run directory. */
  run_dir?: string;
  /** Optional: hypothesis the proposer committed to (filled by `meta`). */
  hypothesis?: string;
  /** Optional: score delta vs. frontier at time of this attempt. */
  delta?: number;
}

/** Append one row to .darwin/evolution.jsonl. Append-only by design. */
export function appendEvolution(
  row: EvolutionRow,
  cwd: string = process.cwd(),
): void {
  const p = join(cwd, DARWIN_DIR, EVOLUTION_FILE);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(row) + "\n");
}
