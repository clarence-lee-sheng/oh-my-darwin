import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  "target",
  ".darwin",
  ".codex",
  ".omx",
]);

const README_CANDIDATES = ["README.md", "README", "Readme.md", "readme.md"];
const MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
];

const MAX_LINES_PER_FILE = 100;
const MAX_TREE_ENTRIES = 200;
const MAX_TOTAL_CHARS = 12_000; // ~3000 tokens

/**
 * Scan the project rooted at `cwd` and return a single text block to
 * inject into the interviewer's system prompt. Empty string is fine —
 * the interviewer will fall back to asking blind questions.
 */
export function scanBrownfield(cwd: string): string {
  const parts: string[] = [];

  const tree = buildTree(cwd);
  if (tree) parts.push(`### File tree (depth 2)\n\`\`\`\n${tree}\n\`\`\``);

  const readme = findFirst(cwd, README_CANDIDATES);
  if (readme) parts.push(`### ${readme.name}\n\`\`\`\n${readme.body}\n\`\`\``);

  for (const m of MANIFEST_FILES) {
    const f = readCapped(join(cwd, m));
    if (f) parts.push(`### ${m}\n\`\`\`\n${f}\n\`\`\``);
  }

  const log = gitLog(cwd);
  if (log) parts.push(`### Recent git log\n\`\`\`\n${log}\n\`\`\``);

  let out = parts.join("\n\n");
  if (out.length > MAX_TOTAL_CHARS) {
    out = out.slice(0, MAX_TOTAL_CHARS) + "\n…[truncated]";
  }
  return out;
}

function buildTree(cwd: string): string {
  const lines: string[] = [];
  let count = 0;
  function walk(dir: string, depth: number, prefix: string) {
    if (depth > 2 || count >= MAX_TREE_ENTRIES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    entries.sort();
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      if (count >= MAX_TREE_ENTRIES) {
        lines.push(`${prefix}…`);
        return;
      }
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const marker = st.isDirectory() ? "/" : "";
      lines.push(`${prefix}${e}${marker}`);
      count++;
      if (st.isDirectory()) walk(full, depth + 1, prefix + "  ");
    }
  }
  walk(cwd, 0, "");
  return lines.join("\n");
}

function findFirst(
  cwd: string,
  names: string[],
): { name: string; body: string } | null {
  for (const n of names) {
    const body = readCapped(join(cwd, n));
    if (body) return { name: n, body };
  }
  return null;
}

function readCapped(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n");
    if (lines.length <= MAX_LINES_PER_FILE) return raw;
    return lines.slice(0, MAX_LINES_PER_FILE).join("\n") + "\n…[truncated]";
  } catch {
    return null;
  }
}

function gitLog(cwd: string): string | null {
  if (!existsSync(join(cwd, ".git"))) return null;
  try {
    const out = execSync("git log --oneline -10", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Exported for testing / future use; currently unused by callers.
export { relative };
