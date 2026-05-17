import test from "node:test";
import assert from "node:assert/strict";
import {
  engineExecArgs,
  engineInteractiveArgs,
  stripApprovalSandboxArgs,
} from "../dist/runtime/engine.js";

test("omx exec args translate launch shorthands and avoid launch-only flags", () => {
  assert.deepEqual(
    engineExecArgs("omx", ["--madmax", "--xhigh", "--direct"], ["--skip-git-repo-check"]),
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
