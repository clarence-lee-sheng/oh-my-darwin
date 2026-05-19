import { join } from "node:path";
import { FRONTIER_FILE, DARWIN_DIR } from "../cli/constants.js";
import { atomicJsonWrite, readJsonFile } from "./json-file.js";

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
  const parsed = readJsonFile<unknown>(frontierPath(cwd));
  return isFrontierRecord(parsed) ? parsed : null;
}

/** Persist the frontier through the shared atomic JSON writer. */
export function writeFrontier(
  record: FrontierRecord,
  cwd: string = process.cwd(),
): void {
  atomicJsonWrite(frontierPath(cwd), record);
}

function isFrontierRecord(value: unknown): value is FrontierRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<FrontierRecord>;
  return (
    typeof record.attempt_id === "string" &&
    record.attempt_id.length > 0 &&
    (record.score === null || typeof record.score === "number") &&
    typeof record.t === "string"
  );
}
