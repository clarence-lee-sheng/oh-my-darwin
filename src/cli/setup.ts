import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_DIR, HOOKS_DIR, HOOKS_FILE } from "./constants.js";
import { writeCliOutput } from "./display.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");

function templatePath(): string {
  // dist/cli/setup.js → ../../templates/hooks.json
  return resolve(packageRoot, "templates", "hooks.json");
}

function destPath(): string {
  return join(process.cwd(), HOOKS_DIR, HOOKS_FILE);
}

function displayDestPath(): string {
  return `${HOOKS_DIR}/${HOOKS_FILE}`;
}

function packageAgentsPath(): string {
  // dist/cli/setup.js → ../../.agents
  return resolve(packageRoot, AGENTS_DIR);
}

function agentsDestPath(): string {
  return join(process.cwd(), AGENTS_DIR);
}

function copyMissingFiles(srcDir: string, dstDir: string): number {
  mkdirSync(dstDir, { recursive: true });

  let copied = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);

    if (entry.isDirectory()) {
      copied += copyMissingFiles(src, dst);
      continue;
    }

    if (!entry.isFile() || existsSync(dst)) continue;

    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied++;
  }

  return copied;
}

/** Idempotent install/merge — ensure Darwin's native Codex hooks are present. */
export function ensureHooks(): boolean {
  const dst = destPath();
  if (existsSync(dst)) {
    return mergeHooksFile(dst);
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(templatePath(), dst);
  return true;
}

/** Idempotent install — copy packaged agent assets without overwriting local edits. */
export function ensureAgents(): boolean {
  const src = packageAgentsPath();
  if (!existsSync(src)) return false;
  return copyMissingFiles(src, agentsDestPath()) > 0;
}

/** Explicit `darwin setup` — always (re)installs and prints. */
export function setup(): void {
  const dst = destPath();
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(templatePath(), dst);
  writeCliOutput(`installed ${displayDestPath()}`);
}

function mergeHooksFile(path: string): boolean {
  let existing: Record<string, unknown>;
  try {
    existing = readJsonObject(path);
  } catch {
    // Do not overwrite user-authored invalid/non-object hook files implicitly.
    return false;
  }

  if (isLegacyDarwinHooksConfig(existing)) {
    copyFileSync(templatePath(), path);
    return true;
  }

  let template: Record<string, unknown>;
  try {
    template = readJsonObject(templatePath());
  } catch {
    return false;
  }

  const changed = mergeNativeHookConfig(existing, template);
  if (!changed) return false;
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
  return true;
}

function isLegacyDarwinHooksConfig(config: Record<string, unknown>): boolean {
  if ("hooks" in config) return false;
  const expected: Record<string, string> = {
    pre_tool_use: "darwin-hook pre_tool_use",
    post_tool_use: "darwin-hook post_tool_use",
    session_start: "darwin-hook session_start",
    user_prompt_submit: "darwin-hook user_prompt_submit",
    stop: "darwin-hook stop",
  };
  return Object.entries(expected).every(([event, command]) => config[event] === command);
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hooks config must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function mergeNativeHookConfig(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  const sourceHooks = objectRecord(source.hooks);
  if (!sourceHooks) return false;
  let targetHooks = objectRecord(target.hooks);
  let changed = false;
  if (!targetHooks) {
    targetHooks = {};
    target.hooks = targetHooks;
    changed = true;
  }

  for (const [event, sourceGroupsUnknown] of Object.entries(sourceHooks)) {
    if (!Array.isArray(sourceGroupsUnknown)) continue;
    let targetGroupsUnknown = targetHooks[event];
    if (!Array.isArray(targetGroupsUnknown)) {
      targetGroupsUnknown = [];
      targetHooks[event] = targetGroupsUnknown;
      changed = true;
    }
    const targetGroups = targetGroupsUnknown as unknown[];

    for (const sourceGroup of sourceGroupsUnknown) {
      if (!isObjectRecord(sourceGroup)) continue;
      const matcher = typeof sourceGroup.matcher === "string" ? sourceGroup.matcher : undefined;
      const sourceCommands = Array.isArray(sourceGroup.hooks) ? sourceGroup.hooks : [];
      let targetGroupUnknown = targetGroups.find((group: unknown) =>
        isObjectRecord(group) &&
        ((typeof group.matcher === "string" ? group.matcher : undefined) ?? "") === (matcher ?? "")
      );
      if (!isObjectRecord(targetGroupUnknown)) {
        targetGroupUnknown = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] };
        targetGroups.push(targetGroupUnknown);
        changed = true;
      }
      const targetGroup = targetGroupUnknown as Record<string, unknown>;
      let targetCommandListUnknown = targetGroup.hooks;
      if (!Array.isArray(targetCommandListUnknown)) {
        targetCommandListUnknown = [];
        targetGroup.hooks = targetCommandListUnknown;
        changed = true;
      }
      const targetCommandList = targetCommandListUnknown as unknown[];

      for (const sourceCommand of sourceCommands) {
        if (!isObjectRecord(sourceCommand)) continue;
        const command = typeof sourceCommand.command === "string" ? sourceCommand.command : undefined;
        const type = typeof sourceCommand.type === "string" ? sourceCommand.type : undefined;
        if (!command || !type) continue;
        const exists = targetCommandList.some((targetCommand: unknown) =>
          isObjectRecord(targetCommand) &&
          targetCommand.type === type &&
          targetCommand.command === command
        );
        if (!exists) {
          targetCommandList.push(sourceCommand);
          changed = true;
        }
      }
    }
  }
  return changed;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return isObjectRecord(value) ? value : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
