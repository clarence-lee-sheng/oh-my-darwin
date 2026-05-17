import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DARWIN_DIR } from "../cli/constants.js";
import type { NicheEntry } from "../strategy/contract.js";

export const NICHES_FILE = "niches.json";

function nichesPath(cwd: string): string {
  return join(cwd, DARWIN_DIR, NICHES_FILE);
}

export function readNiches(cwd: string = process.cwd()): Record<string, NicheEntry> | undefined {
  const p = nichesPath(cwd);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, NicheEntry>;
  } catch {
    return undefined;
  }
}

/**
 * Atomic write of the niche grid. Same pattern as frontier: tmp + rename.
 * No-op if niches is undefined/empty (the file only exists when in use).
 */
export function writeNiches(
  niches: Record<string, NicheEntry> | undefined,
  cwd: string = process.cwd(),
): void {
  if (!niches || Object.keys(niches).length === 0) return;
  const p = nichesPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(niches, null, 2) + "\n");
  renameSync(tmp, p);
}
