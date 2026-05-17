import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS_DIR, HOOKS_FILE } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function templatePath(): string {
  // dist/cli/setup.js → ../../templates/hooks.json
  return resolve(__dirname, "..", "..", "templates", "hooks.json");
}

function destPath(): string {
  return join(process.cwd(), HOOKS_DIR, HOOKS_FILE);
}

/** Idempotent install — copy template if missing, return true if newly installed. */
export function ensureHooks(): boolean {
  const dst = destPath();
  if (existsSync(dst)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(templatePath(), dst);
  return true;
}

/** Explicit `darwin setup` — always (re)installs and prints. */
export function setup(): void {
  const dst = destPath();
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(templatePath(), dst);
  console.log(`installed → ${dst}`);
}
