import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  formatHookFatalError,
  parseHookPayload,
  readHookInput,
  resolveHookStdinLimit,
  runHook,
} from "../dist/cli/hook.js";
import {
  dispatch,
  resolveEventLogStringLimit,
  resolveHookPluginTimeoutMs,
} from "../dist/hooks/extensibility/dispatcher.js";

async function withCwd(cwd, fn) {
  const oldCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(oldCwd);
  }
}

function readLastEvent(cwd) {
  const rows = readFileSync(join(cwd, ".darwin", "events.jsonl"), "utf-8")
    .trim()
    .split("\n");
  return JSON.parse(rows[rows.length - 1]);
}

test("readHookInput bounds non-tty stdin while draining the stream", async () => {
  const input = Readable.from(["abc", "def", "ghi"]);

  const result = await readHookInput(input, false, 5);

  assert.deepEqual(result, { raw: "abcde", truncated: true });
});

test("hook stdin limit env is bounded", () => {
  assert.equal(resolveHookStdinLimit(undefined), 64_000);
  assert.equal(resolveHookStdinLimit("128"), 128);
  assert.equal(resolveHookStdinLimit("999999999"), 1_000_000);
  assert.equal(resolveHookStdinLimit("not-a-number"), 64_000);
});

test("parseHookPayload keeps normal JSON payloads intact", () => {
  assert.deepEqual(parseHookPayload('{"tool":"shell","ok":true}'), {
    tool: "shell",
    ok: true,
  });
  assert.deepEqual(parseHookPayload('"plain string"'), {
    payload: "plain string",
  });
});

test("formatHookFatalError keeps direct hook failures single-line and bounded", () => {
  const message = formatHookFatalError(new Error(`bad\n${"x".repeat(1000)}`));

  assert.match(message, /^darwin-hook: Error: bad x+/);
  assert.doesNotMatch(message, /bad\n/);
  assert.doesNotMatch(message, /x{300}/);
  assert.ok(message.length <= 240);
});

test("runHook records a bounded payload when hook stdin is large", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-cli-"));
  try {
    await withCwd(cwd, async () => {
      const input = Readable.from([
        JSON.stringify({ tool: "shell", output: "x".repeat(500) }),
      ]);

      await runHook(["post_tool_use"], input, false, { stdinLimitRaw: "32" });

      const event = readLastEvent(cwd);
      assert.equal(event.event, "post_tool_use");
      assert.equal(event._raw_truncated, true);
      assert.equal(typeof event._raw, "string");
      assert.ok(event._raw.length <= 32);
      assert.doesNotMatch(JSON.stringify(event), /x{100}/);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runHook reloads project plugins when cwd changes", async () => {
  const cwdOne = mkdtempSync(join(tmpdir(), "darwin-hook-cwd-one-"));
  const cwdTwo = mkdtempSync(join(tmpdir(), "darwin-hook-cwd-two-"));
  try {
    writePlugin(cwdOne, "plugin-one", "one");
    writePlugin(cwdTwo, "plugin-two", "two");

    await withCwd(cwdOne, async () => {
      await runHook(["stop"], Readable.from([]), false);
    });
    await withCwd(cwdTwo, async () => {
      await runHook(["stop"], Readable.from([]), false);
    });

    assert.equal(readFileSync(join(cwdOne, "marker.txt"), "utf-8"), "one\n");
    assert.equal(readFileSync(join(cwdTwo, "marker.txt"), "utf-8"), "two\n");
  } finally {
    rmSync(cwdOne, { recursive: true, force: true });
    rmSync(cwdTwo, { recursive: true, force: true });
  }
});

test("runHook times out hanging plugin handlers", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-timeout-"));
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    const pluginsDir = join(cwd, ".darwin", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "slow.mjs"),
      `export default {
  name: "slow",
  handlers: {
    stop() {
      return new Promise(() => {});
    }
  }
};
`,
    );
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return true;
    };

    await withCwd(cwd, async () => {
      await runHook(["stop"], Readable.from([]), false, {
        pluginTimeoutMsRaw: "20",
      });
    });

    assert.match(stderr, /plugin slow stop failed: Error: timed out after <1s/);
    const event = readLastEvent(cwd);
    assert.equal(event.event, "stop");
  } finally {
    process.stderr.write = oldWrite;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runHook continues plugin dispatch when event logging fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-log-failure-"));
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    mkdirSync(join(cwd, ".darwin", "events.jsonl"), { recursive: true });
    writePlugin(cwd, "plugin-after-log-failure", "dispatched");
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return true;
    };

    await withCwd(cwd, async () => {
      await runHook(["stop"], Readable.from([]), false);
    });

    assert.match(stderr, /event log failed/);
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf-8"), "dispatched\n");
  } finally {
    process.stderr.write = oldWrite;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runHook prints Codex-compatible JSON returned by a plugin", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-output-"));
  try {
    const pluginsDir = join(cwd, ".darwin", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "blocker.mjs"),
      `export default {
  name: "blocker",
  handlers: {
    user_prompt_submit() {
      return { decision: "block", reason: "blocked by test hook" };
    }
  }
};
`,
    );
    const hookModule = new URL("../dist/cli/hook.js", import.meta.url).href;
    const script = `
import { Readable } from "node:stream";
import { runHook } from ${JSON.stringify(hookModule)};
await runHook(["UserPromptSubmit"], Readable.from(['{"prompt":"hi"}']), false);
`;
    const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      encoding: "utf8",
    });

    assert.equal(proc.status, 0, proc.stderr);
    assert.deepEqual(JSON.parse(proc.stdout), {
      decision: "block",
      reason: "blocked by test hook",
    });
    const event = readLastEvent(cwd);
    assert.equal(event.event, "user_prompt_submit");
    assert.equal(event.prompt, "hi");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runHook bounds plugin returned JSON strings", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-output-bound-"));
  try {
    const pluginsDir = join(cwd, ".darwin", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "long-blocker.mjs"),
      `export default {
  name: "long-blocker",
  handlers: {
    user_prompt_submit() {
      return { decision: "block", reason: "x".repeat(5000) };
    }
  }
};
`,
    );
    const hookModule = new URL("../dist/cli/hook.js", import.meta.url).href;
    const script = `
import { Readable } from "node:stream";
import { runHook } from ${JSON.stringify(hookModule)};
await runHook(["UserPromptSubmit"], Readable.from(['{"prompt":"hi"}']), false);
`;
    const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      encoding: "utf8",
    });

    assert.equal(proc.status, 0, proc.stderr);
    const output = JSON.parse(proc.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /^x+\.\.\.\[truncated 1000 chars\]$/);
    assert.doesNotMatch(output.reason, /x{4500}/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runHook summarizes long plugin handler errors", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-long-error-"));
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    const pluginsDir = join(cwd, ".darwin", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "long-error.mjs"),
      `export default {
  name: "long-error",
  handlers: {
    stop() {
      throw new Error("x".repeat(1000));
    }
  }
};
`,
    );
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return true;
    };

    await withCwd(cwd, async () => {
      await runHook(["stop"], Readable.from([]), false);
    });

    assert.match(stderr, /plugin long-error stop failed: Error: x+/);
    assert.doesNotMatch(stderr, /x{250}/);
  } finally {
    process.stderr.write = oldWrite;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runHook keeps plugin failure names single-line and bounded", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-long-name-"));
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    const pluginsDir = join(cwd, ".darwin", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "long-name.mjs"),
      `export default {
  name: "dirty\\n" + "n".repeat(500),
  handlers: {
    stop() {
      throw new Error("boom");
    }
  }
};
`,
    );
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return true;
    };

    await withCwd(cwd, async () => {
      await runHook(["stop"], Readable.from([]), false);
    });

    assert.match(stderr, /plugin dirty n+\.\.\. stop failed: Error: boom/);
    assert.doesNotMatch(stderr, /dirty\nn/);
    assert.doesNotMatch(stderr, /n{250}/);
  } finally {
    process.stderr.write = oldWrite;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runHook keeps custom event names single-line and bounded", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-event-name-"));
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    const dirtyEvent = `dirty-event\n${"e".repeat(500)}`;
    const pluginsDir = join(cwd, ".darwin", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "dirty-event.mjs"),
      `export default {
  name: "dirty-event-plugin",
  handlers: {
    [${JSON.stringify(dirtyEvent)}]() {
      throw new Error("boom");
    }
  }
};
`,
    );
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      return true;
    };

    await withCwd(cwd, async () => {
      await runHook([dirtyEvent], Readable.from([]), false);
    });

    assert.match(stderr, /plugin dirty-event-plugin dirty-event e+\.\.\. failed: Error: boom/);
    assert.doesNotMatch(stderr, /dirty-event\ne/);
    assert.doesNotMatch(stderr, /e{300}/);
    const event = readLastEvent(cwd);
    assert.match(event.event, /^dirty-event e+\.\.\.$/);
    assert.doesNotMatch(event.event, /\n/);
    assert.doesNotMatch(event.event, /e{300}/);
    assert.ok(event.event.length <= 120);
  } finally {
    process.stderr.write = oldWrite;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dispatch bounds event-log strings without mutating plugin payloads", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-log-bound-"));
  try {
    writePayloadLengthPlugin(cwd);
    const largeArg = "x".repeat(500);

    await withCwd(cwd, async () => {
      await dispatch(
        "run_start",
        {
          args: [largeArg],
          nested: { detail: "y".repeat(100) },
        },
        {
          eventLogStringLimitRaw: "32",
        },
      );
    });

    const event = readLastEvent(cwd);
    assert.equal(event.event, "run_start");
    assert.match(event.args[0], /^x{32}\.\.\.\[truncated 468 chars\]$/);
    assert.match(event.nested.detail, /^y{32}\.\.\.\[truncated 68 chars\]$/);
    assert.equal(readFileSync(join(cwd, "payload-length.txt"), "utf-8"), "500\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dispatch bounds event-log collection fanout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-log-fanout-"));
  try {
    const args = Array.from({ length: 130 }, (_, i) => `item-${i}`);
    const nested = Object.fromEntries(
      Array.from({ length: 130 }, (_, i) => [`key_${i}`, `value-${i}`]),
    );

    await withCwd(cwd, async () => {
      await dispatch("run_start", { args, nested });
    });

    const event = readLastEvent(cwd);
    assert.equal(event.args.length, 101);
    assert.equal(event.args[0], "item-0");
    assert.equal(event.args[99], "item-99");
    assert.equal(event.args[100], "...[truncated 30 items]");
    assert.equal(event.nested.key_0, "value-0");
    assert.equal(event.nested.key_99, "value-99");
    assert.equal(event.nested.key_100, undefined);
    assert.equal(event.nested.__darwin_truncated_entries, 30);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dispatch bounds event-log object keys", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-hook-log-key-bound-"));
  try {
    const dirtyKey = `dirty\n${"k".repeat(500)}`;

    await withCwd(cwd, async () => {
      await dispatch("run_start", { nested: { [dirtyKey]: "value" } });
    });

    const event = readLastEvent(cwd);
    const keys = Object.keys(event.nested);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^dirty k+\.\.\.$/);
    assert.doesNotMatch(keys[0], /\n/);
    assert.doesNotMatch(keys[0], /k{300}/);
    assert.ok(keys[0].length <= 160);
    assert.equal(event.nested[keys[0]], "value");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hook plugin timeout and event-log limit env values are bounded", () => {
  assert.equal(resolveHookPluginTimeoutMs(undefined), 2_000);
  assert.equal(resolveHookPluginTimeoutMs("1234"), 1_234);
  assert.equal(resolveHookPluginTimeoutMs("999999999"), 60_000);
  assert.equal(resolveHookPluginTimeoutMs("nope"), 2_000);

  assert.equal(resolveEventLogStringLimit(undefined), 8_000);
  assert.equal(resolveEventLogStringLimit("256"), 256);
  assert.equal(resolveEventLogStringLimit("999999999"), 64_000);
  assert.equal(resolveEventLogStringLimit("nope"), 8_000);
});

function writePlugin(cwd, name, marker) {
  const pluginsDir = join(cwd, ".darwin", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, `${name}.mjs`),
    `import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default {
  name: ${JSON.stringify(name)},
  handlers: {
    stop() {
      appendFileSync(join(process.cwd(), "marker.txt"), ${JSON.stringify(`${marker}\n`)});
    }
  }
};
`,
  );
}

function writePayloadLengthPlugin(cwd) {
  const pluginsDir = join(cwd, ".darwin", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, "payload-length.mjs"),
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default {
  name: "payload-length",
  handlers: {
    run_start(payload) {
      writeFileSync(join(process.cwd(), "payload-length.txt"), String(payload.args[0].length) + "\\n");
    }
  }
};
`,
  );
}
