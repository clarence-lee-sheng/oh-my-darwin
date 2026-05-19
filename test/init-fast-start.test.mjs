import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import {
  formatInterviewQuestionForTerminal,
  formatSafetyNoteForTerminal,
} from "../dist/interview/loop.js";

async function runInitWithInput(input) {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-init-fast-"));
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
  const cli = join(process.cwd(), "dist", "cli", "index.js");

  const child = spawn(
    process.execPath,
    [
      cli,
      "--codex",
      "--engine-arg",
      "--definitely-not-a-real-engine-flag",
      "init",
    ],
    {
      cwd,
      env: {
        ...process.env,
        DARWIN_HOME: home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(input);

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, 2_000);

  const [code, signal] = await once(child, "exit");
  clearTimeout(timeout);

  return { code, signal, stdout, stderr, cwd };
}

test("darwin init asks the first question before invoking an engine", async () => {
  const { code, signal, stdout, stderr } = await runInitWithInput("/quit\n");

  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /\[1\] What concrete task should Darwin iterate on\?/);
  assert.doesNotMatch(stderr, /scanning project/);
  assert.doesNotMatch(stderr, /thinking \(turn 1\)/);
});

test("darwin init /done finalizes without scanning or invoking an engine", async () => {
  const { code, signal, stdout, stderr, cwd } = await runInitWithInput("/done\n");

  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /darwin: wrote \.darwin\/meta-spec\.md/);
  assert.doesNotMatch(stdout, new RegExp(escapeRegExp(cwd)));
  assert.match(stdout, /spec was finalized early via \/done - review/);
  assert.doesNotMatch(stdout, /[^\x00-\x7F]/);
  assert.doesNotMatch(stderr, /scanning project/);
  assert.doesNotMatch(stderr, /thinking \(turn 1\)/);
});

test("interview questions preserve multiline text and are not truncated", () => {
  const question = formatInterviewQuestionForTerminal(`What now?\n${"q".repeat(1000)}`);

  assert.match(question, /^What now\?\nq+$/);
  assert.doesNotMatch(question, /\.\.\.$/);
  assert.ok(question.length > 900);
});

test("interview safety notes are single-line and bounded", () => {
  const note = formatSafetyNoteForTerminal(`Review this\n${"s".repeat(1000)}`);

  assert.match(note, /Review this s+/);
  assert.doesNotMatch(note, /Review this\ns/);
  assert.doesNotMatch(note, /s{180}/);
  assert.ok(note.length <= 160);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
