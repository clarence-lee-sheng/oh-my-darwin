import readline from "node:readline/promises";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout, stderr } from "node:process";
import {
  DARWIN_DIR,
  INIT_DIR,
  META_SPEC_FILE,
  TRANSCRIPT_FILE,
} from "../cli/constants.js";
import { scanBrownfield } from "./brownfield.js";
import { buildSystemPrompt } from "./prompt.js";
import { callInterviewer, type Turn } from "./codex-call.js";
import { meanAmbiguity, type Envelope } from "./schema.js";
import {
  DEFAULT_ENGINE,
  engineLabel,
  resolveEngineArgs,
  type EngineName,
} from "../runtime/engine.js";

const MAX_TURNS = 15;
const AMBIGUITY_THRESHOLD = 0.2;

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

  stderr.write("darwin: scanning project...\n");
  const brownfield = scanBrownfield(cwd);
  const systemPrompt = buildSystemPrompt(brownfield);
  stderr.write(
    brownfield.trim().length > 0
      ? `darwin: scan captured ${brownfield.length} chars of context\n`
      : "darwin: empty project (no brownfield context)\n",
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const history: Turn[] = [{ role: "user", content: "<begin interview>" }];

  let lastEnv: Envelope | null = null;
  let forcedDone = false;

  try {
    stderr.write(`darwin: starting interview (${engineLabel(engine)})\n`);
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      stderr.write(`\ndarwin: thinking (turn ${turn + 1})...\n`);
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
        stderr.write(
          `\ndarwin: ambiguity ${mean.toFixed(2)} ≤ ${AMBIGUITY_THRESHOLD}, finalizing\n`,
        );
        break;
      }

      stdout.write(`\n[${turn + 1}] ${env.next_question}\n`);
      const answer = (await rl.question("> ")).trim();

      if (answer === "/done") {
        forcedDone = true;
        stderr.write("darwin: user requested /done, finalizing\n");
        break;
      }
      if (answer === "/quit") {
        stderr.write(
          "darwin: user requested /quit, leaving partial spec in place\n",
        );
        rl.close();
        return;
      }

      history.push({ role: "assistant", content: JSON.stringify(env) });
      history.push({ role: "user", content: answer });
      appendTranscript(transcriptPath, {
        turn: turn + 1,
        user_answer: answer,
      });
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
    stderr.write("darwin: no interview turns completed; nothing written\n");
    return;
  }

  // Final spec write (idempotent — same content as last per-turn write).
  if (env.spec_draft) writeFileSync(specPath, env.spec_draft);

  stdout.write(`\ndarwin: wrote ${specPath}\n`);

  if (env.safety_notes && env.safety_notes.length > 0) {
    stdout.write("\ndarwin: SAFETY NOTES from interviewer:\n");
    for (const note of env.safety_notes) {
      stdout.write(`  - ${note}\n`);
    }
    stdout.write(
      "\nReview these and the spec before running `darwin baseline` or `darwin meta`.\n",
    );
  }

  if (forcedDone) {
    stdout.write(
      "\ndarwin: spec was finalized early via /done — review for completeness.\n",
    );
  }
}
