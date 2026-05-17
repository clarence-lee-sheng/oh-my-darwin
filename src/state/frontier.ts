import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { FRONTIER_FILE, DARWIN_DIR } from "../cli/constants.js";

export interface FrontierRecord {
  /** Identifier of the winning attempt (e.g. "baseline", "iter-3"). */
  attempt_id: string;
  /** Realized score; null if not yet scored. */
  score: number | null;
  /** ISO timestamp the record was written. */
  t: string;
  /** Optional human note carried forward from the attempt. */
  note?: string;
  /** Path (relative to .darwin/) of the attempt's run directory. */
  run_dir?: string;
}

function frontierPath(cwd: string): string {
  return join(cwd, DARWIN_DIR, FRONTIER_FILE);
}

export function readFrontier(cwd: string = process.cwd()): FrontierRecord | null {
  const p = frontierPath(cwd);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as FrontierRecord;
  } catch {
    return null;
  }
}

/**
 * Atomic write: serialize to a temp file, fsync via writeFileSync, then
 * rename over the target. A crash mid-write leaves the previous
 * frontier intact.
 */
export function writeFrontier(
  record: FrontierRecord,
  cwd: string = process.cwd(),
): void {
  const p = frontierPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, p);
}
