import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicJsonWrite,
  readJsonFile,
} from "../dist/state/json-file.js";

test("readJsonFile returns undefined for missing or invalid JSON", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-json-file-read-"));
  const missing = join(cwd, "missing.json");
  const invalid = join(cwd, "invalid.json");
  writeFileSync(invalid, "{not json");

  assert.equal(readJsonFile(missing), undefined);
  assert.equal(readJsonFile(invalid), undefined);
});

test("atomicJsonWrite creates parents and writes formatted JSON with newline", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-json-file-write-"));
  const path = join(cwd, "nested", "value.json");

  atomicJsonWrite(path, { ok: true });

  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(path, "utf-8"), '{\n  "ok": true\n}\n');
  assert.deepEqual(readJsonFile(path), { ok: true });
});
