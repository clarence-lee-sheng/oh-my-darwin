import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import {
  DARWIN_DIR,
  INIT_DIR,
  META_SPEC_FILE,
  TRANSCRIPT_FILE,
} from "../cli/constants.js";
import { writeCliError } from "../cli/display.js";
import { meanAmbiguity, type Envelope } from "./schema.js";
import { createOpeningEnvelope } from "./opening.js";
import {
  DEFAULT_ENGINE,
  engineLabel,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";
import { formatErrorSummary } from "../runtime/diagnostics.js";
import { writeTerminalStream } from "../runtime/terminal.js";

const MAX_TURNS = 15;
const AMBIGUITY_THRESHOLD = 0.2;
const SPEC_DISPLAY_PATH = `${DARWIN_DIR}/${META_SPEC_FILE}`;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

export async function runInterview(
  engine: EngineName = DEFAULT_ENGINE,
  engineArgs: string[] = resolveEngineArgs(engine),
): Promise<void> {
  const cwd = process.cwd();
  const darwinDir = join(cwd, DARWIN_DIR);
  const initDir = join(darwinDir, INIT_DIR);
  const specPath = join(darwinDir, META_SPEC_FILE);
  const transcriptPath = join(initDir, TRANSCRIPT_FILE);

  mkdirSync(initDir, { recursive: true });
  // Truncate any prior transcript at the start of a fresh interview.
  writeFileSync(transcriptPath, "");

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stdout });
  const history: Turn[] = [{ role: "user", content: "<begin interview>" }];

  let lastEnv: Envelope | null = null;
  let forcedDone = false;

  try {
    writeCliError(`darwin: starting interview (${engineLabel(engine)})`);
    const opening = createOpeningEnvelope();
    lastEnv = opening;
    if (opening.spec_draft) {
      writeFileSync(specPath, opening.spec_draft);
    }
    appendTranscript(transcriptPath, {
      turn: 1,
      envelope: opening,
    });

    writeInterviewOutput(
      `\n[1] ${formatInterviewQuestionForTerminal(opening.next_question)}\n`,
    );
    const firstAnswer = (await rl.question("> ")).trim();

    if (firstAnswer === "/done") {
      forcedDone = true;
      writeCliError("darwin: user requested /done, finalizing");
    } else if (firstAnswer === "/quit") {
      writeCliError(
        "darwin: user requested /quit, leaving partial spec in place",
      );
      return;
    } else {
      history.push({ role: "assistant", content: JSON.stringify(opening) });
      history.push({ role: "user", content: firstAnswer });
      appendTranscript(transcriptPath, {
        turn: 1,
        user_answer: firstAnswer,
      });
    }

    if (!forcedDone) {
      const [
        { scanBrownfield },
        { buildSystemPrompt },
        { callInterviewer },
      ] = await Promise.all([
        import("./brownfield.js"),
        import("./prompt.js"),
        import("./codex-call.js"),
      ]);
      writeCliError("darwin: scanning project...");
      const brownfield = scanBrownfield(cwd);
      const systemPrompt = buildSystemPrompt(brownfield);
      writeCliError(
        brownfield.trim().length > 0
          ? `darwin: scan captured ${brownfield.length} chars of context`
          : "darwin: empty project (no brownfield context)",
      );

      for (let turn = 1; turn < MAX_TURNS; turn++) {
        writeCliError(`\ndarwin: thinking (turn ${turn + 1})...`);
        const env = await callInterviewer(systemPrompt, history, engine, engineArgs);
        lastEnv = env;

        // Persist progress every turn so ^C leaves a useful draft.
        if (env.spec_draft) {
          writeFileSync(specPath, env.spec_draft);
        }
        appendTranscript(transcriptPath, {
          turn: turn + 1,
          envelope: env,
        });

        const mean = meanAmbiguity(env.ambiguity);
        if (env.done || mean <= AMBIGUITY_THRESHOLD) {
          writeCliError(
            `\ndarwin: ambiguity ${mean.toFixed(2)} <= ${AMBIGUITY_THRESHOLD}, finalizing`,
          );
          break;
        }

        writeInterviewOutput(
          `\n[${turn + 1}] ${formatInterviewQuestionForTerminal(env.next_question)}\n`,
        );
        const answer = (await rl.question("> ")).trim();

        if (answer === "/done") {
          forcedDone = true;
          writeCliError("darwin: user requested /done, finalizing");
          break;
        }
        if (answer === "/quit") {
          writeCliError(
            "darwin: user requested /quit, leaving partial spec in place",
          );
          return;
        }

        history.push({ role: "assistant", content: JSON.stringify(env) });
        history.push({ role: "user", content: answer });
        appendTranscript(transcriptPath, {
          turn: turn + 1,
          user_answer: answer,
        });
      }
    }
  } finally {
    rl.close();
  }

  await finalize(specPath, lastEnv, forcedDone);
}

function appendTranscript(path: string, row: unknown): void {
  appendFileSync(path, JSON.stringify(row) + "\n");
}

async function finalize(
  specPath: string,
  env: Envelope | null,
  forcedDone: boolean,
): Promise<void> {
  if (!env) {
    writeCliError("darwin: no interview turns completed; nothing written");
    return;
  }

  // Final spec write (idempotent — same content as last per-turn write).
  if (env.spec_draft) writeFileSync(specPath, env.spec_draft);

  writeInterviewOutput(`\ndarwin: wrote ${SPEC_DISPLAY_PATH}\n`);

  if (env.safety_notes && env.safety_notes.length > 0) {
    writeInterviewOutput("\ndarwin: SAFETY NOTES from interviewer:\n");
    for (const note of env.safety_notes) {
      writeInterviewOutput(`  - ${formatSafetyNoteForTerminal(note)}\n`);
    }
    writeInterviewOutput(
      "\nReview these and the spec before running `darwin baseline` or `darwin meta`.\n",
    );
  }

  if (forcedDone) {
    writeInterviewOutput(
      "\ndarwin: spec was finalized early via /done - review for completeness.\n",
    );
  }
}

function writeInterviewOutput(message: string): void {
  writeTerminalStream(stdout, message);
}

export function formatInterviewQuestionForTerminal(value: unknown): string {
  return formatErrorSummary(value);
}

export function formatSafetyNoteForTerminal(value: unknown): string {
  return formatErrorSummary(value);
}
