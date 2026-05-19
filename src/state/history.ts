import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
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
  /** Optional (goal-mode): the goal statement the proposer chose for this attempt. */
  goal?: string;
  /** Optional (goal-mode): the proposer's rationale for this goal. */
  rationale?: string;
  /** Optional (goal-mode): execution knobs used (model, sandbox, approval). */
  knobs?: Record<string, string>;
  /** Optional (goal-mode): why the attempt finished (quiet/time_cap/codex_exit/error). */
  exit_reason?: string;
  /** Optional (goal-mode): attempt duration in seconds. */
  duration_s?: number;
}

export interface EvolutionSummary {
  rowCount: number;
  recent: EvolutionRow[];
}

const HISTORY_CHUNK_BYTES = 64 * 1024;
type StringEvolutionField =
  | "note"
  | "run_dir"
  | "hypothesis"
  | "next_hint"
  | "goal"
  | "rationale"
  | "exit_reason";
type NumberEvolutionField = "delta" | "duration_s";

/**
 * Read the most recent N attempts from evolution.jsonl, newest last.
 * Returns [] if no file. Malformed lines are skipped silently.
 */
export function readRecentEvolution(
  cwd: string,
  n: number,
): EvolutionRow[] {
  const p = evolutionPath(cwd);
  if (n <= 0) return [];
  const rows: EvolutionRow[] = [];
  visitNonEmptyLinesReverse(p, (line) => {
    const row = parseEvolutionRow(line);
    if (row) rows.push(row);
    return rows.length >= n;
  });
  return rows.reverse();
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

export function countEvolutionRows(cwd: string = process.cwd()): number {
  return countNonEmptyLines(evolutionPath(cwd));
}

/**
 * Read status-friendly evolution stats in one reverse scan: count every
 * non-empty row and keep the most recent valid JSON rows, newest last.
 */
export function readEvolutionSummary(
  cwd: string = process.cwd(),
  recentLimit = 5,
): EvolutionSummary {
  let rowCount = 0;
  const recent: EvolutionRow[] = [];
  visitNonEmptyLinesReverse(evolutionPath(cwd), (line) => {
    rowCount++;
    if (recent.length < recentLimit) {
      const row = parseEvolutionRow(line);
      if (row) recent.push(row);
    }
    return false;
  });
  return {
    rowCount,
    recent: recent.reverse(),
  };
}

/**
 * Walk the evolution log backwards to find the most recent non-empty
 * `next_hint`. Returns undefined if no hint exists anywhere in the log.
 */
export function readLastEvolutionHint(
  cwd: string = process.cwd(),
): string | undefined {
  const p = evolutionPath(cwd);
  let hint: string | undefined;
  visitNonEmptyLinesReverse(p, (line) => {
    const row = parseEvolutionRow(line);
    if (typeof row?.next_hint === "string" && row.next_hint.trim().length > 0) {
      hint = row.next_hint.trim();
      return true;
    }
    return false;
  });
  return hint;
}

function parseEvolutionRow(line: string): EvolutionRow | null {
  try {
    return normalizeEvolutionRow(JSON.parse(line));
  } catch {
    return null;
  }
}

function normalizeEvolutionRow(value: unknown): EvolutionRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<EvolutionRow>;
  const score = row.score;
  if (
    typeof row.t !== "string" ||
    typeof row.attempt_id !== "string" ||
    row.attempt_id.length === 0 ||
    !isEvolutionScore(score) ||
    typeof row.outcome !== "string" ||
    row.outcome.length === 0
  ) {
    return null;
  }

  const normalized: EvolutionRow = {
    t: row.t,
    attempt_id: row.attempt_id,
    score,
    outcome: row.outcome as EvolutionRow["outcome"],
  };
  copyStringField(row, normalized, "note");
  copyStringField(row, normalized, "run_dir");
  copyStringField(row, normalized, "hypothesis");
  copyStringField(row, normalized, "next_hint");
  copyStringField(row, normalized, "goal");
  copyStringField(row, normalized, "rationale");
  copyStringField(row, normalized, "exit_reason");
  copyNumberField(row, normalized, "delta");
  copyNumberField(row, normalized, "duration_s");
  if (isStringRecord(row.knobs)) normalized.knobs = row.knobs;
  return normalized;
}

function copyStringField(
  source: Partial<EvolutionRow>,
  target: EvolutionRow,
  key: StringEvolutionField,
): void {
  if (typeof source[key] === "string") {
    target[key] = source[key];
  }
}

function copyNumberField(
  source: Partial<EvolutionRow>,
  target: EvolutionRow,
  key: NumberEvolutionField,
): void {
  if (Number.isFinite(source[key])) {
    target[key] = source[key] as number;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isEvolutionScore(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function countNonEmptyLines(path: string): number {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(HISTORY_CHUNK_BYTES);
    let count = 0;
    let lineHasBytes = false;
    let bytes = 0;
    while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytes; i++) {
        if (buf[i] === 10) {
          if (lineHasBytes) count++;
          lineHasBytes = false;
        } else {
          lineHasBytes = true;
        }
      }
    }
    if (lineHasBytes) count++;
    return count;
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function visitNonEmptyLinesReverse(
  path: string,
  visit: (line: string) => boolean,
): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    let position = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const bytesToRead = Math.min(HISTORY_CHUNK_BYTES, position);
      position -= bytesToRead;
      const buf = Buffer.allocUnsafe(bytesToRead);
      readSync(fd, buf, 0, bytesToRead, position);
      const combined = carry.length > 0 ? Buffer.concat([buf, carry]) : buf;
      let lineEnd = combined.length;

      for (let i = combined.length - 1; i >= 0; i--) {
        if (combined[i] !== 10) continue;
        const line = combined.subarray(i + 1, lineEnd);
        if (line.length > 0 && visit(line.toString("utf-8"))) return;
        lineEnd = i;
      }

      carry = combined.subarray(0, lineEnd);
    }

    if (carry.length > 0) {
      visit(carry.toString("utf-8"));
    }
  } catch {
    return;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}
