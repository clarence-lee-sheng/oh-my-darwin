import assert from "node:assert/strict";
import test from "node:test";
import {
  captureBoundedOutput,
  createBoundedOutputCapture,
  formatDurationMs,
  formatErrorSummary,
  formatPathForTerminal,
  resolvePositiveInt,
} from "../dist/runtime/diagnostics.js";

test("formatErrorSummary keeps noisy values single-line and visibly bounded", () => {
  const summary = formatErrorSummary(`bad\n${"x".repeat(50)}`, 24);

  assert.equal(summary.length, 24);
  assert.match(summary, /^bad x+\.\.\.$/);
  assert.doesNotMatch(summary, /\n/);
  assert.doesNotMatch(summary, /x{40}/);
});

test("formatErrorSummary preserves short normalized values", () => {
  assert.equal(formatErrorSummary("already short", 40), "already short");
});

test("formatDurationMs keeps sub-second timeout text useful", () => {
  assert.equal(formatDurationMs(Number.NaN), "<1s");
  assert.equal(formatDurationMs(-1), "<1s");
  assert.equal(formatDurationMs(999), "<1s");
  assert.equal(formatDurationMs(1_499), "1s");
  assert.equal(formatDurationMs(1_500), "2s");
});

test("resolvePositiveInt falls back and clamps parsed values", () => {
  assert.equal(resolvePositiveInt(undefined, 10, 100), 10);
  assert.equal(resolvePositiveInt("bad", 10, 100), 10);
  assert.equal(resolvePositiveInt("50", 10, 100), 50);
  assert.equal(resolvePositiveInt("500", 10, 100), 100);
});

test("captureBoundedOutput keeps head, tail, and truncation state", () => {
  const capture = createBoundedOutputCapture();

  captureBoundedOutput(capture, "abcdef", 4);
  captureBoundedOutput(capture, "gh", 4);

  assert.equal(capture.head, "abcd");
  assert.equal(capture.tail, "efgh");
  assert.equal(capture.totalChars, 8);
  assert.equal(capture.truncated, true);
});

test("formatPathForTerminal makes external paths inspectable without leaking full roots", () => {
  const formatted = formatPathForTerminal(
    `/tmp/${"parent".repeat(40)}/${"file".repeat(40)}.txt`,
    { cwd: "/workspace/project", limit: 80 },
  );

  assert.match(formatted, /^<external>\//);
  assert.ok(formatted.length <= 80);
  assert.equal(formatted.includes("parent".repeat(20)), false);
  assert.equal(formatted.includes("file".repeat(20)), false);
});
