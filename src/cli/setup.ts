import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_DIR, HOOKS_DIR, HOOKS_FILE } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");

function templatePath(): string {
  // dist/cli/setup.js → ../../templates/hooks.json
  return resolve(packageRoot, "templates", "hooks.json");
}

function destPath(): string {
  return join(process.cwd(), HOOKS_DIR, HOOKS_FILE);
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

/** Idempotent install — copy template if missing, return true if newly installed. */
export function ensureHooks(): boolean {
  const dst = destPath();
  if (existsSync(dst)) return false;
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
  console.log(`installed → ${dst}`);
}
