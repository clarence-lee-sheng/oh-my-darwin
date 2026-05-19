import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { terminateChildProcess } from "../dist/runtime/process-tree.js";

test("terminateChildProcess resolves after SIGTERM exits the child", async () => {
  const child = fakeChild((signal) => {
    if (signal !== "SIGTERM") return;
    child.signalCode = signal;
    setImmediate(() => child.emit("exit", null, signal));
  });

  await terminateChildProcess(child, { killGraceMs: 10, settleMs: 10 });

  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("terminateChildProcess escalates to SIGKILL when the child stays alive", async () => {
  const child = fakeChild();

  await terminateChildProcess(child, { killGraceMs: 5, settleMs: 5 });

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

function fakeChild(onKill = () => {}) {
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    onKill(signal);
    return true;
  };
  return child;
}
