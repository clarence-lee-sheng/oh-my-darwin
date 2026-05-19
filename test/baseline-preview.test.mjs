import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBaselineEngineCommand,
  formatBaselineField,
  formatTaskPreview,
} from "../dist/cli/baseline.js";

test("formatTaskPreview indents short multiline tasks", () => {
  assert.equal(formatTaskPreview("line one\nline two\n"), "line one\n  line two");
});

test("formatTaskPreview truncates long tasks and points to the saved artifact", () => {
  const preview = formatTaskPreview("x".repeat(2500), "runs/baseline");

  assert.ok(preview.length < 2300);
  assert.match(preview, /^\S+/);
  assert.match(preview, /\.\.\.\[truncated; full task saved to \.darwin\/runs\/baseline\/task\.md\]$/);
  assert.doesNotMatch(preview, /x{2400}/);
});

test("baseline terminal fields are single-line and bounded", () => {
  const field = formatBaselineField(`bad slug\n${"s".repeat(1000)}`);

  assert.match(field, /bad slug s+/);
  assert.doesNotMatch(field, /bad slug\ns/);
  assert.doesNotMatch(field, /s{300}/);
});

test("baseline engine command preview redacts generated output paths and stays bounded", () => {
  const command = formatBaselineEngineCommand("codex", [
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message",
    `/tmp/${"x".repeat(1000)}`,
  ]);

  assert.match(command, /OUTPUT_LAST_MESSAGE_PATH/);
  assert.doesNotMatch(command, /x{300}/);
  assert.ok(command.length <= 240);
});
