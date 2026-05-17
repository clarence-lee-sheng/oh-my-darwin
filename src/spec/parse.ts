import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DARWIN_DIR, META_SPEC_FILE } from "../cli/constants.js";

export type ScorerSource = "human" | "command" | "test-suite" | "llm-judge";
export type ScorerDirection = "higher_is_better" | "lower_is_better";

export interface ScorerSpec {
  /** How the score is produced. */
  source: ScorerSource;
  /** Whether higher or lower numbers are better. */
  direction: ScorerDirection;
  /** Human-readable name. Optional. */
  name?: string;
  /** Score above which a candidate counts as "not bad". Optional. */
  threshold_good?: number;
  /** Score above which the loop is "done" and may auto-stop. Optional. */
  threshold_done?: number;
  /** Shell command for source: command or test-suite. */
  command?: string;
  /** Parse rule for source: command (e.g. "first_number", "last_number"). */
  parse?: string;
  /** Path to rubric file for source: llm-judge. */
  rubric_path?: string;
  /** Glob/path of the artifact for source: llm-judge. */
  artifact_path?: string;
  /** True if the scorer section was absent and this is the defensive default. */
  is_default?: boolean;
}

const DEFAULT_SCORER: ScorerSpec = {
  source: "human",
  direction: "higher_is_better",
  is_default: true,
};

export interface SpecSlice {
  /** Raw markdown of the full spec. */
  raw: string;
  /** Body of the `## Task` section (prose, no heading). Empty if missing. */
  task: string;
  /** Slug from the `# oh-my-darwin meta-spec — <slug>` heading. Empty if missing. */
  slug: string;
  /** Parsed `## Scorer` section, with safe defaults if missing. */
  scorer: ScorerSpec;
}

/**
 * Minimal spec reader: pulls task prose, slug, and scorer config.
 * Other structured sections (Constraints, HITL, Surface, etc.) are
 * available via extractSection() but not yet consumed.
 */
export function readSpec(cwd: string = process.cwd()): SpecSlice {
  const path = join(cwd, DARWIN_DIR, META_SPEC_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `no spec found at ${path}. Run \`darwin init\` first to create one.`,
    );
  }
  const raw = readFileSync(path, "utf-8");
  return {
    raw,
    task: extractSection(raw, "Task"),
    slug: extractSlug(raw),
    scorer: extractScorer(raw),
  };
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

/**
 * Parse the `## Scorer` section. Format is loose: any number of
 * `- key: value` bullets. Unknown keys are ignored. Missing required
 * fields fall back to defaults with `is_default: true`.
 */
export function extractScorer(md: string): ScorerSpec {
  const body = extractSection(md, "Scorer");
  if (!body) return { ...DEFAULT_SCORER };

  const fields: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*-\s*([a-zA-Z_]+)\s*:\s*(.+?)\s*$/);
    if (m) fields[m[1].toLowerCase()] = m[2];
  }

  const source = normalizeSource(fields.source);
  const direction = normalizeDirection(fields.direction);

  const spec: ScorerSpec = { source, direction };
  if (fields.name) spec.name = fields.name;

  const tg = parseNumber(fields.threshold_good);
  if (tg !== null) spec.threshold_good = tg;
  const td = parseNumber(fields.threshold_done);
  if (td !== null) spec.threshold_done = td;

  if (fields.command) spec.command = fields.command;
  if (fields.parse) spec.parse = fields.parse;
  if (fields.rubric_path || fields.rubric) {
    spec.rubric_path = fields.rubric_path ?? fields.rubric;
  }
  if (fields.artifact_path || fields.artifact) {
    spec.artifact_path = fields.artifact_path ?? fields.artifact;
  }

  return spec;
}

function normalizeSource(s?: string): ScorerSource {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "command") return "command";
  if (v === "test-suite" || v === "test_suite" || v === "tests") return "test-suite";
  if (v === "llm-judge" || v === "llm_judge" || v === "judge") return "llm-judge";
  return "human";
}

function normalizeDirection(s?: string): ScorerDirection {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "lower_is_better" || v === "lower" || v === "min") return "lower_is_better";
  return "higher_is_better";
}

function parseNumber(s?: string): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
