import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureHooks } from "../dist/cli/setup.js";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));

test("darwin --help prints usage without installing hooks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-help-"));

  const proc = spawnSync(process.execPath, [cli, "--help"], {
    cwd,
    encoding: "utf-8",
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /usage:/);
  assert.match(proc.stdout, /darwin meta/);
  assert.match(proc.stdout, /darwin - meta-harness/);
  assert.match(proc.stdout, /propose -> execute -> score -> repeat/);
  assert.doesNotMatch(proc.stdout, /[^ -~\n]/);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin --help still prints when engine configuration is invalid", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-help-engine-"));

  const proc = spawnSync(process.execPath, [cli, "--help"], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, DARWIN_ENGINE: "not-a-real-engine" },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /usage:/);
  assert.match(proc.stdout, /selected\/default engine: invalid engine configuration/);
  assert.match(proc.stdout, /selected\/default command: unavailable/);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin --help keeps selected engine command single-line and bounded", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-help-command-"));
  const dirtyArg = `bad\n${"x".repeat(500)}`;

  const proc = spawnSync(process.execPath, [cli, "--help"], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      DARWIN_ENGINE_ARGS: `--flag '${dirtyArg}'`,
    },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.doesNotMatch(proc.stdout, /bad\n/);
  const commandLine = proc.stdout
    .split("\n")
    .find((line) => line.startsWith("selected/default command: "));
  assert.ok(commandLine);
  assert.match(commandLine, /bad x+/);
  assert.doesNotMatch(commandLine, /x{300}/);
  assert.ok(commandLine.length <= "selected/default command: ".length + 240);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("invalid DARWIN_ENGINE diagnostics name the environment value", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-env-engine-"));
  const invalidEngine = `bad\n${"x".repeat(500)}`;

  const proc = spawnSync(process.execPath, [cli, "baseline"], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, DARWIN_ENGINE: invalidEngine },
  });

  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /unsupported engine "bad x+/);
  assert.doesNotMatch(proc.stderr, /unsupported engine "undefined"/);
  assert.doesNotMatch(proc.stderr, /bad\n/);
  assert.doesNotMatch(proc.stderr, /x{300}/);
  assert.ok(proc.stderr.length <= 240);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin status runs through explicit subcommand dispatch", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-status-"));

  const proc = spawnSync(process.execPath, [cli, "status"], {
    cwd,
    encoding: "utf-8",
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /project: \(unregistered; run `darwin init`\)/);
  assert.match(proc.stdout, /evolution_rows: 0/);
  assert.match(proc.stdout, /recent_attempts:\n\(none\)/);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin status does not require engine configuration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-status-engine-"));

  const proc = spawnSync(process.execPath, [cli, "status"], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, DARWIN_ENGINE: "not-a-real-engine" },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /project: \(unregistered; run `darwin init`\)/);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin capabilities unregistered path stays cheap and non-mutating", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-capabilities-empty-"));

  const proc = spawnSync(process.execPath, [cli, "capabilities"], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, DARWIN_ENGINE: "not-a-real-engine" },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(
    proc.stdout,
    "darwin: no project registered for this directory. Run `darwin init` first.\n",
  );
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin does not treat engine option values as subcommands", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-engine-value-"));

  const proc = spawnSync(process.execPath, [cli, "--engine", "status"], {
    cwd,
    encoding: "utf-8",
  });

  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /unsupported engine "status"/);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin top-level errors are single-line and bounded", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-error-"));
  const invalidEngine = `bad\n${"x".repeat(1000)}`;

  const proc = spawnSync(process.execPath, [cli, "--engine", invalidEngine, "baseline"], {
    cwd,
    encoding: "utf-8",
  });

  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /unsupported engine "bad x+/);
  assert.doesNotMatch(proc.stderr, /bad\n/);
  assert.doesNotMatch(proc.stderr, /x{300}/);
  assert.ok(proc.stderr.length <= 240);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin status shows recent evolution attempts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-status-history-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  const rows = Array.from({ length: 7 }, (_, i) => ({
    t: "2026-05-19T00:00:00.000Z",
    attempt_id: `iter-${i + 1}`,
    score: i,
    outcome: "scored",
    delta: i === 5 ? 0.5 : undefined,
    exit_reason: i === 6 ? "engine_exit" : undefined,
  }));
  writeFileSync(
    join(cwd, ".darwin", "evolution.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );

  const proc = spawnSync(process.execPath, [cli, "status"], {
    cwd,
    encoding: "utf-8",
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /evolution_rows: 7/);
  assert.doesNotMatch(proc.stdout, /iter-1/);
  assert.doesNotMatch(proc.stdout, /iter-2/);
  assert.match(proc.stdout, /- iter-3 scored score=2/);
  assert.match(proc.stdout, /- iter-6 scored score=5 delta=\+0.5/);
  assert.match(proc.stdout, /- iter-7 scored score=6 exit=engine_exit/);
});

test("darwin status keeps stored fields single-line and bounded", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-status-fields-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  const longName = `dirty-name\n${"n".repeat(500)}`;
  const longProjectId = `proj-dirty\n${"p".repeat(500)}`;
  const longPath = `/tmp/darwin-root\n${"r".repeat(500)}`;
  const longAttempt = `iter-dirty\n${"a".repeat(500)}`;
  const longOutcome = `scored\n${"o".repeat(500)}`;
  const longExit = `engine-exit\n${"e".repeat(500)}`;

  writeFileSync(
    join(cwd, ".darwin", "project.json"),
    JSON.stringify({
      project_id: longProjectId,
      name: longName,
      root_path: longPath,
      created_at: "2026-05-19T00:00:00.000Z",
      last_used_at: "2026-05-19T00:00:00.000Z",
    }),
  );
  writeFileSync(
    join(cwd, ".darwin", "frontier.json"),
    JSON.stringify({
      attempt_id: longAttempt,
      score: null,
      t: "2026-05-19T00:00:00.000Z",
    }),
  );
  writeFileSync(
    join(cwd, ".darwin", "evolution.jsonl"),
    JSON.stringify({
      t: "2026-05-19T00:00:00.000Z",
      attempt_id: longAttempt,
      score: 1,
      outcome: longOutcome,
      exit_reason: longExit,
    }) + "\n",
  );

  const proc = spawnSync(process.execPath, [cli, "status"], {
    cwd,
    encoding: "utf-8",
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /dirty-name n+/);
  assert.match(proc.stdout, /proj-dirty p+/);
  assert.match(proc.stdout, /frontier: iter-dirty a+\.\.\. score=null/);
  assert.match(proc.stdout, /- iter-dirty a+\.\.\. scored o+\.\.\. score=1 exit=engine-exit e+\.\.\./);
  assert.doesNotMatch(proc.stdout, /dirty-name\nn/);
  assert.doesNotMatch(proc.stdout, /proj-dirty\np/);
  assert.doesNotMatch(proc.stdout, /iter-dirty\na/);
  assert.doesNotMatch(proc.stdout, /scored\no/);
  assert.doesNotMatch(proc.stdout, /engine-exit\ne/);
  assert.doesNotMatch(proc.stdout, /n{300}|p{300}|r{300}|a{300}|o{300}|e{300}/);
});

test("darwin projects keeps registry fields single-line and bounded", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-projects-"));
  const home = mkdtempSync(join(tmpdir(), "darwin-home-projects-"));
  mkdirSync(home, { recursive: true });
  const longId = `proj-dirty\n${"p".repeat(500)}`;
  const longName = `registry-name\n${"n".repeat(500)}`;
  const longRoot = `/tmp/darwin-root\n${"r".repeat(500)}`;

  writeFileSync(
    join(home, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          project_id: longId,
          name: longName,
          root_path: longRoot,
          created_at: "2026-05-19T00:00:00.000Z",
          last_used_at: "2026-05-19T00:00:00.000Z",
        },
      ],
    }),
  );

  const proc = spawnSync(process.execPath, [cli, "projects"], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, DARWIN_HOME: home, DARWIN_ENGINE: "not-a-real-engine" },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /proj-dirty p+\.\.\.\tregistry-name n+\.\.\.\t\/tmp\/darwin-root r+\.\.\./);
  assert.doesNotMatch(proc.stdout, /proj-dirty\np/);
  assert.doesNotMatch(proc.stdout, /registry-name\nn/);
  assert.doesNotMatch(proc.stdout, /darwin-root\nr/);
  assert.doesNotMatch(proc.stdout, /p{300}|n{300}|r{300}/);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin capabilities keeps project header single-line and bounded", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-capabilities-"));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  const longId = `proj-dirty\n${"p".repeat(500)}`;
  const longName = `capability-project\n${"n".repeat(500)}`;

  writeFileSync(
    join(cwd, ".darwin", "project.json"),
    JSON.stringify({
      project_id: longId,
      name: longName,
      root_path: cwd,
      created_at: "2026-05-19T00:00:00.000Z",
      last_used_at: "2026-05-19T00:00:00.000Z",
    }),
  );

  const proc = spawnSync(process.execPath, [cli, "capabilities"], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, DARWIN_ENGINE: "not-a-real-engine" },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /project: capability-project n+\.\.\. \(proj-dirty p+\.\.\.\)/);
  assert.match(proc.stdout, /\(none\)/);
  assert.doesNotMatch(proc.stdout, /capability-project\nn/);
  assert.doesNotMatch(proc.stdout, /proj-dirty\np/);
  assert.doesNotMatch(proc.stdout, /n{300}|p{300}/);
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), false);
});

test("darwin setup prints stable relative hook path without engine configuration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-setup-"));

  const proc = spawnSync(process.execPath, [cli, "setup"], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, DARWIN_ENGINE: "not-a-real-engine" },
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stdout.trim(), "installed .codex/hooks.json");
  assert.doesNotMatch(proc.stdout, new RegExp(escapeRegExp(cwd)));
  assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), true);
  const hooks = JSON.parse(readFileSync(join(cwd, ".codex", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, "darwin-hook pre_tool_use");
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, "darwin-hook user_prompt_submit");
});

test("ensureHooks upgrades legacy Darwin hook maps to native Codex hooks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-hooks-upgrade-"));
  const oldCwd = process.cwd();
  try {
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(
      join(cwd, ".codex", "hooks.json"),
      JSON.stringify({
        pre_tool_use: "darwin-hook pre_tool_use",
        post_tool_use: "darwin-hook post_tool_use",
        session_start: "darwin-hook session_start",
        user_prompt_submit: "darwin-hook user_prompt_submit",
        stop: "darwin-hook stop",
      }, null, 2),
    );

    process.chdir(cwd);
    assert.equal(ensureHooks(), true);
    const hooks = JSON.parse(readFileSync(join(cwd, ".codex", "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.Stop[0].hooks[0].command, "darwin-hook stop");
    assert.equal(hooks.hooks.PermissionRequest[0].hooks[0].command, "darwin-hook permission_request");
    assert.equal(hooks.pre_tool_use, undefined);
  } finally {
    process.chdir(oldCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ensureHooks merges Darwin stop observer into existing native hook config", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-hooks-merge-"));
  const oldCwd = process.cwd();
  try {
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(
      join(cwd, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "echo user-hook",
                },
              ],
            },
          ],
        },
      }, null, 2),
    );

    process.chdir(cwd);
    assert.equal(ensureHooks(), true);
    const hooks = JSON.parse(readFileSync(join(cwd, ".codex", "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, "echo user-hook");
    assert.equal(
      hooks.hooks.PreToolUse.some((group) =>
        group.hooks.some((hook) => hook.command === "darwin-hook pre_tool_use")
      ),
      true,
    );
    assert.equal(hooks.hooks.Stop[0].hooks[0].command, "darwin-hook stop");
  } finally {
    process.chdir(oldCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ensureHooks leaves invalid hook config untouched", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cli-hooks-invalid-"));
  const oldCwd = process.cwd();
  try {
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(join(cwd, ".codex", "hooks.json"), "{not json");

    process.chdir(cwd);
    assert.equal(ensureHooks(), false);
    assert.equal(readFileSync(join(cwd, ".codex", "hooks.json"), "utf8"), "{not json");
  } finally {
    process.chdir(oldCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
