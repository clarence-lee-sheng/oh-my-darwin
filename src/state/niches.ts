import { join } from "node:path";
import { DARWIN_DIR } from "../cli/constants.js";
import type { NicheEntry } from "../strategy/contract.js";
import { atomicJsonWrite, readJsonFile } from "./json-file.js";

export const NICHES_FILE = "niches.json";

function nichesPath(cwd: string): string {
  return join(cwd, DARWIN_DIR, NICHES_FILE);
}

export function readNiches(cwd: string = process.cwd()): Record<string, NicheEntry> | undefined {
  const parsed = readJsonFile<unknown>(nichesPath(cwd));
  return isNicheMap(parsed) && Object.keys(parsed).length > 0 ? parsed : undefined;
}

/** Persist the niche grid only when it contains a valid non-empty map. */
export function writeNiches(
  niches: Record<string, NicheEntry> | undefined,
  cwd: string = process.cwd(),
): void {
  if (!isNicheMap(niches) || Object.keys(niches).length === 0) return;
  atomicJsonWrite(nichesPath(cwd), niches);
}

function isNicheMap(value: unknown): value is Record<string, NicheEntry> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isNicheEntry)
  );
}

function isNicheEntry(value: unknown): value is NicheEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<NicheEntry>;
  return (
    typeof entry.attempt_id === "string" &&
    entry.attempt_id.length > 0 &&
    Number.isFinite(entry.score) &&
    typeof entry.niche === "string" &&
    (entry.run_dir === undefined || typeof entry.run_dir === "string")
  );
}
