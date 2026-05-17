import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExecGoalPrompt,
  resolveGoalAttemptMode,
} from "../dist/runtime/goal-attempt.js";
import { engineExecArgs, engineInteractiveArgs } from "../dist/runtime/engine.js";
import { shouldPromptForGoalApproval } from "../dist/cli/meta.js";

test("goal attempt defaults to non-interactive exec mode", () => {
  const prev = process.env.DARWIN_GOAL_ATTEMPT_MODE;
  delete process.env.DARWIN_GOAL_ATTEMPT_MODE;
  try {
    assert.equal(resolveGoalAttemptMode(), "exec");
  } finally {
    if (prev === undefined) delete process.env.DARWIN_GOAL_ATTEMPT_MODE;
    else process.env.DARWIN_GOAL_ATTEMPT_MODE = prev;
  }
});

test("goal attempt preserves slash mode as explicit legacy override", () => {
  const prev = process.env.DARWIN_GOAL_ATTEMPT_MODE;
  process.env.DARWIN_GOAL_ATTEMPT_MODE = "/goal";
  try {
    assert.equal(resolveGoalAttemptMode(), "slash");
    assert.equal(resolveGoalAttemptMode("exec"), "exec");
    assert.equal(resolveGoalAttemptMode("slash"), "slash");
  } finally {
    if (prev === undefined) delete process.env.DARWIN_GOAL_ATTEMPT_MODE;
    else process.env.DARWIN_GOAL_ATTEMPT_MODE = prev;
  }
});

test("exec prompt carries multiline goals without slash injection", () => {
  const prompt = buildExecGoalPrompt("line one\nline two");
  assert.match(prompt, /darwin goal-mode/);
  assert.match(prompt, /line one\nline two/);
  assert.doesNotMatch(prompt, /^\/goal/m);
});

test("OMX exec args translate launch-only flags for codex-compatible exec", () => {
  assert.deepEqual(
    engineExecArgs("omx", ["--madmax", "--xhigh", "--direct", "--worktree", "tmp"], ["-"]),
    ["exec", "--dangerously-bypass-approvals-and-sandbox", "-c", 'model_reasoning_effort="xhigh"', "-"],
  );
});

test("OMX interactive args retain direct launch but strip conflicting launch policy", () => {
  assert.deepEqual(
    engineInteractiveArgs("omx", ["--madmax", "--xhigh", "--tmux"], ["--no-alt-screen"]),
    ["--direct", "--madmax", "--xhigh", "--no-alt-screen"],
  );
});

test("goal approval prompt stays on for unbounded/manual runs only", () => {
  assert.equal(
    shouldPromptForGoalApproval({ interactive: false, maxIterations: Infinity, maxDurationMs: Infinity }),
    true,
  );
  assert.equal(
    shouldPromptForGoalApproval({ interactive: true, maxIterations: 1, maxDurationMs: Infinity }),
    true,
  );
  assert.equal(
    shouldPromptForGoalApproval({ interactive: false, maxIterations: 1, maxDurationMs: Infinity }),
    false,
  );
  assert.equal(
    shouldPromptForGoalApproval({ interactive: false, maxIterations: Infinity, maxDurationMs: 60_000 }),
    false,
  );
});
