import { spawn } from "node:child_process";
import { stderr as procStderr } from "node:process";
import { dirname, resolve } from "node:path";
import type { ScorerSpec } from "../spec/parse.js";
import type { ScoreResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run the user-declared shell command in the project root (the parent of
 * .darwin/). Parse a number out of stdout per spec.parse (default: first_number).
 *
 * `runDir` is .darwin/runs/<attempt-id>/ — useful for resolving the project
 * root, but commands run from the project root, NOT from runDir (the
 * command typically points at the user's eval script in the project root).
 */
export async function commandScorer(
  spec: ScorerSpec,
  runDir: string,
): Promise<ScoreResult> {
  if (!spec.command || spec.command.trim().length === 0) {
    return { score: null, note: "command scorer: no `command:` field in meta-spec.md" };
  }

  // runDir = <project>/.darwin/runs/<id>/  →  project root is 3 levels up.
  const projectRoot = resolve(runDir, "..", "..", "..");
  const cmd = spec.command.trim();

  procStderr.write(`darwin: scoring with: ${cmd}  (cwd=${projectRoot})\n`);

  let stdoutBuf = "";
  let stderrBuf = "";
  let exitCode: number | null = null;
  let timedOut = false;

  const child = spawn("bash", ["-lc", cmd], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (b: Buffer) => { stdoutBuf += b.toString("utf-8"); });
  child.stderr?.on("data", (b: Buffer) => { stderrBuf += b.toString("utf-8"); });

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }, DEFAULT_TIMEOUT_MS);

  await new Promise<void>((res) => {
    child.on("exit", (code) => {
      exitCode = code;
      res();
    });
    child.on("error", () => res());
  });
  clearTimeout(timer);

  if (timedOut) {
    return {
      score: null,
      note: `command scorer: timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`,
    };
  }
  if (exitCode !== 0) {
    const tail = (stderrBuf || stdoutBuf).trim().split("\n").slice(-3).join(" | ");
    return {
      score: null,
      note: `command scorer: exit ${exitCode}${tail ? ` — ${tail.slice(0, 160)}` : ""}`,
    };
  }

  const score = parseScore(stdoutBuf, spec.parse);
  if (score === null) {
    const preview = stdoutBuf.trim().slice(0, 80);
    return {
      score: null,
      note: `command scorer: could not parse number from stdout (got: "${preview}")`,
    };
  }

  return { score, note: `command scorer: ${score} (cmd=${cmd})` };
}

/**
 * Extract a numeric score from command stdout. Supports:
 *   - "first_number" (default): first match of a number anywhere
 *   - "last_number": last number anywhere
 *   - "first_line": parse the first non-empty line as a number
 *   - "last_line": parse the last non-empty line as a number
 *
 * Returns null if no number can be extracted.
 */
function parseScore(stdout: string, parse?: string): number | null {
  const mode = (parse ?? "first_number").trim().toLowerCase();
  const numRe = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

  if (mode === "first_line" || mode === "last_line") {
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const line = mode === "first_line" ? lines[0] : lines[lines.length - 1];
    const n = Number(line);
    return Number.isFinite(n) ? n : firstNumber(line, numRe);
  }

  const all = stdout.match(numRe);
  if (!all || all.length === 0) return null;
  const pick = mode === "last_number" ? all[all.length - 1] : all[0];
  const n = Number(pick);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(s: string, re: RegExp): number | null {
  const m = s.match(re);
  if (!m || m.length === 0) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// Silence unused import warning in some TS configs.
void dirname;
