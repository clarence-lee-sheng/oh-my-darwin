import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { invokeProposer } from "../dist/proposer/invoke.js";

test("invokeProposer interactive runner launches engine without exec", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-proposer-interactive-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  const logPath = join(cwd, "argv.json");
  const outputPath = join(cwd, "harness.mjs");

  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));
if (process.argv[2] === "exec") process.exit(42);
const prompt = process.argv.slice(2).join("\\n");
const marker = prompt.match(/WRITE_TO:([^\\n]+)/);
if (!marker) process.exit(43);
fs.writeFileSync(marker[1], "export default { buildPrompt: (task) => task };\\n");
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    await invokeProposer(
      `Please write the harness.\nWRITE_TO:${outputPath}\n`,
      outputPath,
      "codex",
      [],
      { runner: "interactive" },
    );
  } finally {
    process.env.PATH = oldPath;
  }

  const argv = JSON.parse(readFileSync(logPath, "utf8"));
  assert.notEqual(argv[0], "exec");
  assert.match(readFileSync(outputPath, "utf8"), /buildPrompt/);
});

test("invokeProposer interactive runner auto-closes after output file appears", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-proposer-interactive-autoclose-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  const outputPath = join(cwd, "harness.mjs");
  const terminatedPath = join(cwd, "terminated.txt");

  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
const prompt = process.argv.slice(2).join("\\n");
const marker = prompt.match(/WRITE_TO:([^\\n]+)/);
if (!marker) process.exit(43);
fs.writeFileSync(marker[1], "export default { buildPrompt: (task) => task };\\n");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(terminatedPath)}, "yes\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    await invokeProposer(
      `Please write the harness.\nWRITE_TO:${outputPath}\n`,
      outputPath,
      "codex",
      [],
      { runner: "interactive" },
    );
  } finally {
    process.env.PATH = oldPath;
  }

  assert.match(readFileSync(outputPath, "utf8"), /buildPrompt/);
  assert.equal(readFileSync(terminatedPath, "utf8"), "yes\n");
});
