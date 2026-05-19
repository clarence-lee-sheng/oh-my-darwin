import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scanBrownfield } from "../dist/interview/brownfield.js";

test("scanBrownfield builds a capped tree while skipping heavy internal directories", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-brownfield-"));
  mkdirSync(join(cwd, "src", "nested"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, "README.md"), "# Demo\n");
  writeFileSync(join(cwd, "package.json"), '{"name":"demo"}\n');
  writeFileSync(join(cwd, "src", "index.ts"), "export {}\n");
  writeFileSync(join(cwd, "src", "nested", "deep.ts"), "export {}\n");
  writeFileSync(join(cwd, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
  writeFileSync(join(cwd, ".darwin", "events.jsonl"), "{}\n");

  const scan = scanBrownfield(cwd);

  assert.match(scan, /### File tree/);
  assert.match(scan, /src\//);
  assert.match(scan, /  index\.ts/);
  assert.match(scan, /  nested\//);
  assert.doesNotMatch(scan, /node_modules/);
  assert.doesNotMatch(scan, /\.darwin/);
  assert.match(scan, /### README\.md/);
  assert.match(scan, /### package\.json/);
});

test("scanBrownfield reads only capped file prefixes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-brownfield-large-"));
  const largeReadme = "# Large\n" + "a".repeat(80_000) + "TAIL_MARKER\n";
  writeFileSync(join(cwd, "README.md"), largeReadme);
  writeFileSync(join(cwd, "package.json"), '{"name":"SHOULD_NOT_BE_READ"}\n');

  const scan = scanBrownfield(cwd);

  assert.match(scan, /### README\.md/);
  assert.match(scan, /\.\.\.\[truncated\]/);
  assert.doesNotMatch(scan, /[^\x00-\x7F]/);
  assert.doesNotMatch(scan, /TAIL_MARKER/);
  assert.doesNotMatch(scan, /SHOULD_NOT_BE_READ/);
  assert.ok(scan.length <= 12_100, `scan length: ${scan.length}`);
});
