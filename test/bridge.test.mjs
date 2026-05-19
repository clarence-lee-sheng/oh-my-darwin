import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnEngine } from "../dist/runtime/bridge.js";

test("spawnEngine reports signaled exits as failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "darwin-bridge-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nkill -TERM $$\n");
  chmodSync(codex, 0o755);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = bin;

    const result = spawnEngine("codex", [], { engineArgs: [] });

    assert.equal(await result.exit, 1);
    assert.deepEqual(await result.exitInfo, { engine: "codex", code: 1 });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawnEngine falls back from missing OMX with a terminal diagnostic", async () => {
  const root = mkdtempSync(join(tmpdir(), "darwin-bridge-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n");
  chmodSync(codex, 0o755);
  const oldPath = process.env.PATH;
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    process.env.PATH = bin;
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return true;
    };

    const result = spawnEngine("omx", [], { engineArgs: [] });

    assert.equal(await result.exit, 0);
    assert.deepEqual(await result.exitInfo, { engine: "codex", code: 0 });
    assert.match(stderr, /darwin: omx could not launch \(ENOENT\); falling back to codex/);
    assert.match(stderr, /\n$/);
    assert.doesNotMatch(stderr, /\n\n$/);
  } finally {
    process.stderr.write = oldWrite;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
