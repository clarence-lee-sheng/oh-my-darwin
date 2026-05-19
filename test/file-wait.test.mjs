import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { fileExists, waitForFile } from "../dist/runtime/file-wait.js";

test("fileExists reports whether a path is present", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-file-wait-exists-"));
  try {
    const path = join(cwd, "output.json");
    assert.equal(fileExists(path), false);
    writeFileSync(path, "{}\n");
    assert.equal(fileExists(path), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("waitForFile resolves after an interactive output file appears", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-file-wait-"));
  try {
    const path = join(cwd, "candidate.json");
    setTimeout(() => writeFileSync(path, "{\"ok\":true}\n"), 20);

    await waitForFile(path, { pollMs: 5, settleMs: 5 });

    assert.equal(readFileSync(path, "utf-8"), "{\"ok\":true}\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
