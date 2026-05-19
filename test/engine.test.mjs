import test from "node:test";
import assert from "node:assert/strict";
import {
  engineExecArgs,
  formatEngineCommandForLog,
  engineInteractiveArgs,
  stripApprovalSandboxArgs,
} from "../dist/runtime/engine.js";

test("omx exec args translate launch shorthands and avoid launch-only flags", () => {
  assert.deepEqual(
    engineExecArgs("omx", ["--madmax", "--xhigh", "--direct", "--launch-policy", "tmux", "--launch-policy=direct"], ["--skip-git-repo-check"]),
    [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_reasoning_effort="xhigh"',
      "--skip-git-repo-check",
    ],
  );
});

test("bypass modes drop conflicting sandbox and approval flags", () => {
  assert.deepEqual(
    engineExecArgs("codex", [
      "--dangerously-bypass-approvals-and-sandbox",
      "-a",
      "never",
      "--sandbox",
      "read-only",
    ]),
    ["exec", "--dangerously-bypass-approvals-and-sandbox"],
  );

  assert.deepEqual(
    engineInteractiveArgs("omx", ["--tmux", "--madmax", "-a", "never", "-s", "read-only"], ["-m", "gpt-test"]),
    ["--direct", "--madmax", "-m", "gpt-test"],
  );
});

test("stripApprovalSandboxArgs preserves model/reasoning while removing policy flags", () => {
  assert.deepEqual(
    stripApprovalSandboxArgs([
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-test",
      "--sandbox=read-only",
      "-c",
      'model_reasoning_effort="high"',
      "--ask-for-approval",
      "never",
    ]),
    ["-m", "gpt-test", "-c", 'model_reasoning_effort="high"'],
  );
});

test("formatEngineCommandForLog redacts generated output paths", () => {
  const formatted = formatEngineCommandForLog("codex", [
    "exec",
    "--output-last-message",
    "/tmp/darwin-goal-attempt-abc/last.txt",
    "--output-schema=/tmp/darwin/schema.json",
    "--color",
    "never",
    "-",
  ]);

  assert.match(formatted, /--output-last-message/);
  assert.match(formatted, /OUTPUT_LAST_MESSAGE_PATH/);
  assert.match(formatted, /--output-schema=OUTPUT_SCHEMA_PATH/);
  assert.doesNotMatch(formatted, /darwin-goal-attempt-abc/);
  assert.doesNotMatch(formatted, /schema\.json/);
});

test("formatEngineCommandForLog keeps command previews single-line and bounded", () => {
  const formatted = formatEngineCommandForLog("codex", [
    "exec",
    "--flag",
    `bad\n${"x".repeat(500)}`,
  ]);

  assert.match(formatted, /bad x+/);
  assert.doesNotMatch(formatted, /bad\n/);
  assert.doesNotMatch(formatted, /x{300}/);
  assert.ok(formatted.length <= 240);
  assert.match(formatted, /\.\.\.$/);
});
