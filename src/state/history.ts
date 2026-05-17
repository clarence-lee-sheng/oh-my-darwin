import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
  /**
   * Optional: hint emitted by this attempt's harness for the next iteration.
   * Used by darwin meta to seed the next proposer prompt.
   */
  next_hint?: string;
}

function evolutionPath(cwd: string): string {
  return join(cwd, DARWIN_DIR, EVOLUTION_FILE);
}

/** Append one row to .darwin/evolution.jsonl. Append-only by design. */
export function appendEvolution(
  row: EvolutionRow,
  cwd: string = process.cwd(),
): void {
  const p = evolutionPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(row) + "\n");
}

/**
 * Walk the evolution log backwards to find the most recent non-empty
 * `next_hint`. Returns undefined if no hint exists anywhere in the log.
 */
export function readLastEvolutionHint(
  cwd: string = process.cwd(),
): string | undefined {
  const p = evolutionPath(cwd);
  if (!existsSync(p)) return undefined;
  const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]) as EvolutionRow;
      if (typeof row.next_hint === "string" && row.next_hint.trim().length > 0) {
        return row.next_hint.trim();
      }
    } catch {
      /* skip malformed line */
    }
  }
  return undefined;
}
