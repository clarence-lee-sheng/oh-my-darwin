import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScorerSpec } from "../spec/parse.js";
import type { ScoreResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function commandScorer(
  spec: ScorerSpec,
  runDir: string,
): Promise<ScoreResult> {
  if (!spec.command?.trim()) {
    return { score: null, note: "command scorer has no command configured" };
  }

  const result = await runScorerCommand(spec.command, runDir, "command");
  if (result.timedOut) {
    return {
      score: null,
      note: `command scorer timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`,
    };
  }
  const parsed = parseCommandScore(result, spec.parse);
  const exitNote = formatExit(result);
  if (parsed === null) {
    return {
      score: null,
      note: `command scorer could not parse a numeric score (${exitNote})`,
    };
  }

  return {
    score: parsed,
    note: `command scorer parsed score ${parsed} (${exitNote})`,
  };
}

export async function runScorerCommand(
  command: string,
  runDir: string,
  artifactPrefix: string,
): Promise<CommandResult> {
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DARWIN_PROJECT_DIR: process.cwd(),
        DARWIN_RUN_DIR: runDir,
      },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, DEFAULT_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });

  writeFileSync(join(runDir, `${artifactPrefix}.stdout.txt`), result.stdout);
  writeFileSync(join(runDir, `${artifactPrefix}.stderr.txt`), result.stderr);
  writeFileSync(
    join(runDir, `${artifactPrefix}.exit.json`),
    JSON.stringify(
      { code: result.code, signal: result.signal, timedOut: result.timedOut },
      null,
      2,
    ) + "\n",
  );

  return result;
}

export function parseCommandScore(
  result: CommandResult,
  parseRule = "first_number",
): number | null {
  const rule = parseRule.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (rule === "exit_code" || rule === "exitcode") return result.code;

  const output = result.stdout.trim().length > 0
    ? result.stdout
    : `${result.stdout}\n${result.stderr}`;
  const numbers = output.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
  if (!numbers || numbers.length === 0) return null;

  const selected = rule === "last_number" || rule === "last" || rule === "final_number"
    ? numbers[numbers.length - 1]
    : numbers[0];
  const parsed = Number(selected);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatExit(result: CommandResult): string {
  if (result.timedOut) return "timed out";
  return result.signal
    ? `signal=${result.signal}`
    : `exit=${result.code ?? "unknown"}`;
}
