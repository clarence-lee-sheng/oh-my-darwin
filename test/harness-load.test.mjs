import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatHarnessPathForTerminal,
  loadAndValidate,
} from "../dist/harness/load.js";

test("loadAndValidate summarizes buildPrompt smoke-test failures", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-harness-load-"));
  const harnessPath = join(cwd, "harness.mjs");
  writeFileSync(
    harnessPath,
    `export default {
  buildPrompt() {
    throw new Error("bad\\n" + "x".repeat(1000));
  }
};
`,
  );

  try {
    await assert.rejects(
      () => loadAndValidate(harnessPath),
      (err) => {
        assert.match(err.message, /^buildPrompt threw on smoketest: Error: bad x+/);
        assert.doesNotMatch(err.message, /bad\n/);
        assert.doesNotMatch(err.message, /x{300}/);
        assert.ok(err.message.length <= 240);
        return true;
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("harness paths are relative, single-line, and bounded for terminal errors", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-harness-path-"));
  const harnessPath = join(
    cwd,
    ".darwin",
    "proposals",
    `iter-1\n${"x".repeat(500)}`,
    "harness.mjs",
  );

  const formatted = formatHarnessPathForTerminal(harnessPath, cwd);

  assert.match(formatted, /^\.darwin\/proposals\/iter-1 x+/);
  assert.doesNotMatch(formatted, new RegExp(escapeRegExp(cwd)));
  assert.doesNotMatch(formatted, /\n/);
  assert.doesNotMatch(formatted, /x{300}/);
  assert.ok(formatted.length <= 160);

  const oldCwd = process.cwd();
  process.chdir(cwd);
  try {
    const missingHarnessPath = join(
      process.cwd(),
      ".darwin",
      "proposals",
      `iter-1\n${"x".repeat(500)}`,
      "harness.mjs",
    );
    await assert.rejects(
      () => loadAndValidate(missingHarnessPath),
      (err) => {
        assert.match(err.message, /^harness file missing: \.darwin\/proposals\/iter-1 x+/);
        assert.doesNotMatch(err.message, new RegExp(escapeRegExp(cwd)));
        assert.doesNotMatch(err.message, /\n/);
        assert.doesNotMatch(err.message, /x{300}/);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
