import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ensureTrailingNewline,
  writeTerminalStream,
} from "../dist/runtime/terminal.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("ensureTrailingNewline adds one newline when needed", () => {
  assert.equal(ensureTrailingNewline("message"), "message\n");
  assert.equal(ensureTrailingNewline("message\n"), "message\n");
});

test("writeTerminalStream writes exactly one trailing newline", () => {
  let output = "";
  const stream = {
    write(chunk) {
      output += String(chunk);
      return true;
    },
  };

  writeTerminalStream(stream, "first");
  writeTerminalStream(stream, "second\n");
  writeTerminalStream(stream, "");

  assert.equal(output, "first\nsecond\n");
});

test("production terminal writes stay behind terminal helpers", () => {
  const allowed = new Set([
    "src/cli/hook.ts",
  ]);
  const rawWritePattern = /\b(?:process\.)?(?:stderr|stdout)\.write\s*\(|\bconsole\.(?:error|log|warn)\s*\(/;
  const violations = [];

  for (const file of sourceFiles(join(repoRoot, "src"))) {
    const rel = relative(repoRoot, file);
    if (allowed.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (rawWritePattern.test(line)) {
        violations.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}
