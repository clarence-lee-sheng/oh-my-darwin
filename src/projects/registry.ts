import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { stdin, stdout, stderr } from "node:process";
import { DARWIN_DIR, PROJECT_FILE } from "../cli/constants.js";

export interface DarwinProject {
  project_id: string;
  name: string;
  root_path: string;
  created_at: string;
  last_used_at: string;
}

export interface ProjectRegistry {
  version: 1;
  projects: DarwinProject[];
}

const REGISTRY_FILE = "projects.json";
const GLOBAL_PROJECTS_DIR = "projects";
const GLOBAL_CAPABILITIES_FILE = "capabilities.json";

export function darwinHome(): string {
  return process.env.DARWIN_HOME
    ? resolve(process.env.DARWIN_HOME)
    : join(homedir(), ".darwin");
}

function registryPath(home: string = darwinHome()): string {
  return join(home, REGISTRY_FILE);
}

export function globalProjectDir(
  projectId: string,
  home: string = darwinHome(),
): string {
  return join(home, GLOBAL_PROJECTS_DIR, projectId);
}

export function globalProjectPath(
  projectId: string,
  home: string = darwinHome(),
): string {
  return join(globalProjectDir(projectId, home), PROJECT_FILE);
}

export function globalCapabilitiesPath(
  projectId: string,
  home: string = darwinHome(),
): string {
  return join(globalProjectDir(projectId, home), GLOBAL_CAPABILITIES_FILE);
}

export function localProjectPath(cwd: string = process.cwd()): string {
  return join(cwd, DARWIN_DIR, PROJECT_FILE);
}

export function loadRegistry(home: string = darwinHome()): ProjectRegistry {
  const path = registryPath(home);
  if (!existsSync(path)) return { version: 1, projects: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ProjectRegistry;
    if (parsed.version === 1 && Array.isArray(parsed.projects)) {
      return parsed;
    }
  } catch {
    // fall through to a safe empty registry
  }
  return { version: 1, projects: [] };
}

export function saveRegistry(
  registry: ProjectRegistry,
  home: string = darwinHome(),
): void {
  const path = registryPath(home);
  mkdirSync(dirname(path), { recursive: true });
  atomicJsonWrite(path, registry);
}

export function readLocalProject(
  cwd: string = process.cwd(),
): DarwinProject | null {
  const path = localProjectPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as DarwinProject;
    if (parsed.project_id && parsed.root_path) return parsed;
  } catch {
    // ignore corrupt local project file
  }
  return null;
}

export function writeLocalProject(
  cwd: string,
  project: DarwinProject,
): void {
  const path = localProjectPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  atomicJsonWrite(path, project);
}

export function findProjectByExactRoot(
  cwd: string = process.cwd(),
  home: string = darwinHome(),
): DarwinProject | null {
  const root = resolve(cwd);
  const registry = loadRegistry(home);
  return registry.projects.find((p) => resolve(p.root_path) === root) ?? null;
}

export function findProjectById(
  projectId: string,
  home: string = darwinHome(),
): DarwinProject | null {
  return loadRegistry(home).projects.find((p) => p.project_id === projectId) ?? null;
}

export function resolveCurrentProject(
  cwd: string = process.cwd(),
  home: string = darwinHome(),
): DarwinProject | null {
  const local = readLocalProject(cwd);
  if (local) {
    const global = findProjectById(local.project_id, home);
    return global ?? local;
  }
  return findProjectByExactRoot(cwd, home);
}

export function createProjectRecord(
  cwd: string = process.cwd(),
  name: string = basename(resolve(cwd)) || "darwin-project",
): DarwinProject {
  const now = new Date().toISOString();
  return {
    project_id: `proj_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    name,
    root_path: resolve(cwd),
    created_at: now,
    last_used_at: now,
  };
}

export function upsertProject(
  project: DarwinProject,
  home: string = darwinHome(),
): DarwinProject {
  const registry = loadRegistry(home);
  const now = new Date().toISOString();
  const normalized: DarwinProject = {
    ...project,
    root_path: resolve(project.root_path),
    last_used_at: now,
  };
  const idx = registry.projects.findIndex((p) => p.project_id === project.project_id);
  if (idx === -1) registry.projects.push(normalized);
  else registry.projects[idx] = { ...registry.projects[idx], ...normalized };
  registry.projects.sort((a, b) => a.name.localeCompare(b.name));
  saveRegistry(registry, home);
  writeGlobalProject(normalized, home);
  return normalized;
}

export function writeGlobalProject(
  project: DarwinProject,
  home: string = darwinHome(),
): void {
  const path = globalProjectPath(project.project_id, home);
  mkdirSync(dirname(path), { recursive: true });
  atomicJsonWrite(path, project);
}

export function registerProjectForCwd(
  cwd: string = process.cwd(),
  home: string = darwinHome(),
  name?: string,
): DarwinProject {
  const existing = findProjectByExactRoot(cwd, home);
  const project = existing ?? createProjectRecord(cwd, name);
  const saved = upsertProject({ ...project, root_path: resolve(cwd) }, home);
  writeLocalProject(cwd, saved);
  return saved;
}

/**
 * `darwin init` project selection:
 * - exact root_path match is auto-selected;
 * - otherwise, interactive users may choose an existing project or create one;
 * - non-interactive users get a new project for cwd.
 *
 * Selecting an existing project intentionally re-points its root_path to cwd.
 */
export async function selectProjectForInit(
  cwd: string = process.cwd(),
  home: string = darwinHome(),
): Promise<DarwinProject> {
  const exact = findProjectByExactRoot(cwd, home);
  if (exact) {
    const selected = upsertProject(exact, home);
    writeLocalProject(cwd, selected);
    stderr.write(
      `darwin: using existing project ${selected.name} (${selected.project_id})\n`,
    );
    return selected;
  }

  const registry = loadRegistry(home);
  if (!stdin.isTTY || registry.projects.length === 0) {
    const created = registerProjectForCwd(cwd, home);
    stderr.write(
      `darwin: registered new project ${created.name} (${created.project_id})\n`,
    );
    return created;
  }

  stdout.write("\ndarwin: no project registered for this exact root_path.\n");
  stdout.write("Choose an existing project to attach here, or create a new one:\n");
  stdout.write("  n) create new project (default)\n");
  registry.projects.forEach((p, idx) => {
    stdout.write(`  ${idx + 1}) ${p.name} — ${p.root_path} (${p.project_id})\n`);
  });

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const raw = (await rl.question("> ")).trim().toLowerCase();
    const choice = Number(raw);
    if (Number.isInteger(choice) && choice >= 1 && choice <= registry.projects.length) {
      const selected = {
        ...registry.projects[choice - 1],
        root_path: resolve(cwd),
      };
      const saved = upsertProject(selected, home);
      writeLocalProject(cwd, saved);
      stderr.write(
        `darwin: attached existing project ${saved.name} (${saved.project_id}) to ${saved.root_path}\n`,
      );
      return saved;
    }
  } finally {
    rl.close();
  }

  const created = registerProjectForCwd(cwd, home);
  stderr.write(
    `darwin: registered new project ${created.name} (${created.project_id})\n`,
  );
  return created;
}

export function listProjects(home: string = darwinHome()): DarwinProject[] {
  return loadRegistry(home).projects;
}

function atomicJsonWrite(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
