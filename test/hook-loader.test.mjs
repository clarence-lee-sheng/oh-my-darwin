import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPlugins } from "../dist/hooks/extensibility/loader.js";

async function withCwd(cwd, fn) {
  const oldCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(oldCwd);
  }
}

test("loadPlugins treats missing or non-directory plugin paths as empty", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-loader-"));
  try {
    await withCwd(cwd, async () => {
      assert.deepEqual(await loadPlugins(), []);

      mkdirSync(join(cwd, ".darwin"), { recursive: true });
      writeFileSync(join(cwd, ".darwin", "plugins"), "not a directory");
      assert.deepEqual(await loadPlugins(), []);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadPlugins ignores directories and loads plugin files deterministically", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-loader-"));
  try {
    const pluginsDir = join(cwd, ".darwin", "plugins");
    mkdirSync(join(pluginsDir, "ignored.js"), { recursive: true });
    writeFileSync(
      join(pluginsDir, "z-last.mjs"),
      "export default { name: 'z-last', handlers: {} };\n",
    );
    writeFileSync(
      join(pluginsDir, "a-first.js"),
      "export default { name: 'a-first', handlers: {} };\n",
    );
    writeFileSync(join(pluginsDir, "README.txt"), "ignored\n");

    await withCwd(cwd, async () => {
      const plugins = await loadPlugins();
      assert.deepEqual(plugins.map((plugin) => plugin.name), ["a-first", "z-last"]);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadPlugins summarizes long import errors", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-loader-"));
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    const pluginsDir = join(cwd, ".darwin", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "bad.mjs"),
      'throw new Error("x".repeat(1000));\n',
    );
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return true;
    };

    await withCwd(cwd, async () => {
      assert.deepEqual(await loadPlugins(), []);
    });

    assert.match(stderr, /failed to load plugin bad\.mjs: Error: x+/);
    assert.doesNotMatch(stderr, /x{250}/);
  } finally {
    process.stderr.write = oldWrite;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadPlugins keeps plugin filenames single-line and bounded in diagnostics", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-loader-"));
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    const pluginsDir = join(cwd, ".darwin", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, `bad\n${"n".repeat(180)}.mjs`),
      'throw new Error("boom");\n',
    );
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return true;
    };

    await withCwd(cwd, async () => {
      assert.deepEqual(await loadPlugins(), []);
    });

    assert.match(stderr, /failed to load plugin bad n+/);
    assert.match(stderr, /Error: boom/);
    assert.doesNotMatch(stderr, /bad\nn/);
    assert.doesNotMatch(stderr, /n{180}/);
  } finally {
    process.stderr.write = oldWrite;
    rmSync(cwd, { recursive: true, force: true });
  }
});
