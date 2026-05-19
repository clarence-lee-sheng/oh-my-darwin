import assert from "node:assert/strict";
import test from "node:test";
import {
  formatStrategyHookName,
  isParentArray,
  isPopulation,
  safeHook,
} from "../dist/strategy/contract.js";

function captureStderr() {
  const originalWrite = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk, encoding, callback) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk));
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}

test("safeHook summarizes thrown hook errors on one bounded line", () => {
  const capture = captureStderr();
  try {
    const result = safeHook(
      "selectParents",
      () => {
        throw new Error(`bad\n${"x".repeat(1000)}`);
      },
      [],
      () => "fallback",
      (value) => typeof value === "string",
    );

    assert.equal(result, "fallback");
    const stderr = capture.text();
    assert.match(stderr, /strategy hook selectParents threw \(Error: bad x+/);
    assert.doesNotMatch(stderr, /bad\n/);
    assert.doesNotMatch(stderr, /x{300}/);
    assert.ok(stderr.length <= 220);
  } finally {
    capture.restore();
  }
});

test("safeHook keeps hook names single-line and bounded in diagnostics", () => {
  const capture = captureStderr();
  try {
    const result = safeHook(
      `dirtyHook\n${"h".repeat(1000)}`,
      () => "not-a-number",
      [],
      () => 42,
      (value) => typeof value === "number",
    );

    assert.equal(result, 42);
    const stderr = capture.text();
    assert.match(stderr, /strategy hook dirtyHook h+\.\.\. returned invalid shape/);
    assert.doesNotMatch(stderr, /dirtyHook\n/);
    assert.doesNotMatch(stderr, /h{300}/);
    assert.ok(stderr.length <= 210);
  } finally {
    capture.restore();
  }
});

test("formatStrategyHookName summarizes arbitrary labels", () => {
  const formatted = formatStrategyHookName(`hook\n${"x".repeat(1000)}`);

  assert.match(formatted, /^hook x+/);
  assert.doesNotMatch(formatted, /hook\n/);
  assert.doesNotMatch(formatted, /x{300}/);
  assert.ok(formatted.length <= 120);
});

test("strategy validators reject malformed parent and population shapes", () => {
  assert.equal(isParentArray([
    {
      attempt_id: "iter-1",
      score: null,
      outcome: "skipped",
      knobs: { model: "default" },
    },
  ]), true);
  assert.equal(
    isParentArray([{ attempt_id: "iter-1", score: "1", outcome: "scored" }]),
    false,
  );
  assert.equal(
    isParentArray([{
      attempt_id: "iter-1",
      score: 1,
      outcome: "scored",
      knobs: { model: 42 },
    }]),
    false,
  );

  assert.equal(isPopulation({
    frontier: {
      attempt_id: "iter-2",
      score: 0.5,
      t: "2026-05-19T00:00:00.000Z",
    },
    niches: {
      fast: { attempt_id: "iter-2", score: 0.5, niche: "latency=fast" },
    },
  }), true);
  assert.equal(isPopulation({ frontier: { attempt_id: "iter-2" } }), false);
  assert.equal(isPopulation({
    frontier: {
      attempt_id: "iter-2",
      score: 0.5,
      t: "2026-05-19T00:00:00.000Z",
    },
    niches: {
      fast: { attempt_id: "iter-2", score: "0.5", niche: "latency=fast" },
    },
  }), false);
});
