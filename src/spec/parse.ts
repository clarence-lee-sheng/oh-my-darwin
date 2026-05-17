import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DARWIN_DIR, META_SPEC_FILE } from "../cli/constants.js";

export interface SpecSlice {
  /** Raw markdown of the full spec. */
  raw: string;
  /** Body of the `## Task` section (prose, no heading). Empty if missing. */
  task: string;
  /** Slug from the `# oh-my-darwin meta-spec — <slug>` heading. Empty if missing. */
  slug: string;
}

/**
 * Minimal spec reader for v1: just enough for `darwin baseline` to
 * launch Codex with the task as the initial prompt. Full structured
 * parsing (scorer type, constraints, etc.) is deferred until `meta`
 * actually needs it.
 */
export function readSpec(cwd: string = process.cwd()): SpecSlice {
  const path = join(cwd, DARWIN_DIR, META_SPEC_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `no spec found at ${path}. Run \`darwin init\` first to create one.`,
    );
  }
  const raw = readFileSync(path, "utf-8");
  return { raw, task: extractSection(raw, "Task"), slug: extractSlug(raw) };
}

/**
 * Pull the body of a `## <name>` H2 section from markdown. Returns the
 * text between that heading and the next H2 (or end of file), trimmed.
 */
export function extractSection(md: string, name: string): string {
  const lines = md.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `## ${name}`) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^## \S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function extractSlug(md: string): string {
  // Accept both new "oh-my-darwin meta-spec" and legacy "Hyperion meta-spec".
  const m = md.match(/^#\s+(?:oh-my-darwin|Hyperion)\s+meta-spec\s+[—–-]\s+(.+)$/m);
  return m ? m[1].trim() : "";
}
