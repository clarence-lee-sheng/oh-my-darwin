import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";

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
const MAX_BYTES_PER_FILE = 64_000;
const MAX_TREE_ENTRIES = 200;
const MAX_TOTAL_CHARS = 12_000; // ~3000 tokens

/**
 * Scan the project rooted at `cwd` and return a single text block to
 * inject into the interviewer's system prompt. Empty string is fine —
 * the interviewer will fall back to asking blind questions.
 */
export function scanBrownfield(cwd: string): string {
  const parts: string[] = [];
  let totalChars = 0;
  const addPart = (part: string): boolean => {
    if (totalChars >= MAX_TOTAL_CHARS) return false;
    parts.push(part);
    totalChars += part.length + (parts.length > 1 ? 2 : 0);
    return totalChars < MAX_TOTAL_CHARS;
  };

  const tree = buildTree(cwd);
  if (tree && !addPart(`### File tree (depth 2)\n\`\`\`\n${tree}\n\`\`\``)) {
    return truncateScan(parts);
  }

  const readme = findFirst(cwd, README_CANDIDATES, remainingBudget(totalChars));
  if (readme && !addPart(`### ${readme.name}\n\`\`\`\n${readme.body}\n\`\`\``)) {
    return truncateScan(parts);
  }

  for (const m of MANIFEST_FILES) {
    const f = readCapped(join(cwd, m), remainingBudget(totalChars));
    if (f && !addPart(`### ${m}\n\`\`\`\n${f}\n\`\`\``)) {
      return truncateScan(parts);
    }
  }

  const log = gitLog(cwd);
  if (log) addPart(`### Recent git log\n\`\`\`\n${log}\n\`\`\``);

  return truncateScan(parts);
}

function truncateScan(parts: string[]): string {
  let out = parts.join("\n\n");
  if (out.length > MAX_TOTAL_CHARS) {
    out = out.slice(0, MAX_TOTAL_CHARS) + "\n...[truncated]";
  }
  return out;
}

function buildTree(cwd: string): string {
  const lines: string[] = [];
  let count = 0;
  function walk(dir: string, depth: number, prefix: string) {
    if (depth > 2 || count >= MAX_TREE_ENTRIES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = entry.name;
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      if (count >= MAX_TREE_ENTRIES) {
        lines.push(`${prefix}...`);
        return;
      }
      const isDir = entry.isDirectory();
      const marker = isDir ? "/" : "";
      lines.push(`${prefix}${name}${marker}`);
      count++;
      if (isDir) walk(join(dir, name), depth + 1, prefix + "  ");
    }
  }
  walk(cwd, 0, "");
  return lines.join("\n");
}

function findFirst(
  cwd: string,
  names: string[],
  maxBytes: number,
): { name: string; body: string } | null {
  for (const n of names) {
    const body = readCapped(join(cwd, n), maxBytes);
    if (body) return { name: n, body };
  }
  return null;
}

function readCapped(path: string, maxBytes: number = MAX_BYTES_PER_FILE): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const byteLimit = Math.min(MAX_BYTES_PER_FILE, Math.max(1, maxBytes));
    const buf = Buffer.alloc(byteLimit + 1);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    if (bytes === 0) return null;

    const byteTruncated = bytes > byteLimit;
    const raw = buf.subarray(0, Math.min(bytes, byteLimit)).toString("utf-8");
    const lines = raw.split("\n");
    const lineTruncated = lines.length > MAX_LINES_PER_FILE;
    const body = lineTruncated
      ? lines.slice(0, MAX_LINES_PER_FILE).join("\n")
      : raw;
    return byteTruncated || lineTruncated ? body + "\n...[truncated]" : body;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function remainingBudget(usedChars: number): number {
  return Math.max(1, MAX_TOTAL_CHARS - usedChars);
}

function gitLog(cwd: string): string | null {
  if (!existsSync(join(cwd, ".git"))) return null;
  try {
    const out = execFileSync("git", ["log", "--oneline", "-10"], {
      cwd,
      encoding: "utf-8",
      maxBuffer: 16_384,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}
