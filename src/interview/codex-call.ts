import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENVELOPE_SCHEMA, type Envelope } from "./schema.js";
import {
  DEFAULT_ENGINE,
  engineCommand,
  engineEnv,
  engineExecArgs,
  engineExecLabel,
  fallbackEngine,
  fallbackNotice,
  isEngineLaunchError,
  resolveEngineArgs,
  stripApprovalSandboxArgs,
  type EngineName,
} from "../runtime/engine.js";
import { resolvePositiveInt } from "../runtime/diagnostics.js";
import { runQuietChild } from "../runtime/quiet-child.js";
import { writeTerminalError } from "../runtime/terminal.js";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface CallInterviewerOptions {
  timeoutMsRaw?: string;
}

const DEFAULT_INTERVIEWER_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_INTERVIEWER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Single round-trip to the interviewer: serialize the conversation,
 * spawn `<engine> exec` with the JSON Schema enforced on its output,
 * read the resulting envelope, clean up.
 */
export async function callInterviewer(
  systemPrompt: string,
  history: Turn[],
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
  options: CallInterviewerOptions = {},
): Promise<Envelope> {
  try {
    return await callInterviewerOnce(systemPrompt, history, engine, engineArgs, options);
  } catch (err) {
    const fallback = fallbackEngine(engine);
    if (fallback && isEngineLaunchError(err)) {
      writeTerminalError(fallbackNotice(engine, fallback, err));
      return callInterviewerOnce(
        systemPrompt,
        history,
        fallback,
        resolveEngineArgs(fallback),
        options,
      );
    }
    throw err;
  }
}

async function callInterviewerOnce(
  systemPrompt: string,
  history: Turn[],
  engine: EngineName,
  engineArgs: string[],
  options: CallInterviewerOptions,
): Promise<Envelope> {
  const dir = mkdtempSync(join(tmpdir(), "hyp-init-"));
  const schemaPath = join(dir, "schema.json");
  const outPath = join(dir, "out.txt");
  writeFileSync(schemaPath, JSON.stringify(ENVELOPE_SCHEMA));

  const convo = history
    .map((h) => `### ${h.role.toUpperCase()}\n${h.content}`)
    .join("\n\n");
  const fullPrompt = `${systemPrompt}\n\n## Conversation so far\n\n${convo}\n\n## Your turn\n\nReturn the JSON envelope now.`;
  const execArgs = engineExecArgs(
    engine,
    stripApprovalSandboxArgs(engineArgs),
    [
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outPath,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      fullPrompt,
    ],
  );
  const timeoutMs = resolveInterviewerTimeoutMs(
    options.timeoutMsRaw ?? process.env.DARWIN_INTERVIEWER_TIMEOUT_MS,
  );

  try {
    const result = await runQuietChild({
      command: engineCommand(engine),
      args: execArgs,
      cwd: process.cwd(),
      env: engineEnv(engine),
      input: "",
      timeoutMs,
      timeoutLabel: "interviewer",
      writeStatus: writeTerminalError,
    });
    if (result.code !== 0) {
      const tail = result.stderrTail.trim();
      throw new Error(
        `${engineExecLabel(engine)} exited with code ${result.code}${tail ? `\n${tail}` : ""}`,
      );
    }
    const raw = readFileSync(outPath, "utf-8").trim();
    if (!raw) {
      throw new Error(`${engineExecLabel(engine)} produced empty output`);
    }
    return JSON.parse(stripCodeFences(raw)) as Envelope;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Defensive: even with --output-schema, models sometimes wrap in ```json. */
function stripCodeFences(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s;
}

export function resolveInterviewerTimeoutMs(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_INTERVIEWER_TIMEOUT_MS, MAX_INTERVIEWER_TIMEOUT_MS);
}
