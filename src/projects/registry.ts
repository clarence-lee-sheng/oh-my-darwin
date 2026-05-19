import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DARWIN_DIR, PROJECT_FILE } from "../cli/constants.js";
import { atomicJsonWrite, readJsonFile } from "../state/json-file.js";

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
  const parsed = readJsonFile<ProjectRegistry>(registryPath(home));
  if (parsed?.version === 1 && Array.isArray(parsed.projects)) {
    return {
      version: 1,
      projects: parsed.projects.flatMap((project) => {
        const normalized = normalizeDarwinProject(project);
        return normalized ? [normalized] : [];
      }),
    };
  }
  return { version: 1, projects: [] };
}

export function saveRegistry(
  registry: ProjectRegistry,
  home: string = darwinHome(),
): void {
  atomicJsonWrite(registryPath(home), registry);
}

export function readLocalProject(
  cwd: string = process.cwd(),
): DarwinProject | null {
  const parsed = readJsonFile<unknown>(localProjectPath(cwd));
  return normalizeDarwinProject(parsed);
}

export function writeLocalProject(
  cwd: string,
  project: DarwinProject,
): void {
  atomicJsonWrite(localProjectPath(cwd), project);
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
    project_id: newProjectId(),
    name,
    root_path: resolve(cwd),
    created_at: now,
    last_used_at: now,
  };
}

function newProjectId(): string {
  return `proj_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
  atomicJsonWrite(globalProjectPath(project.project_id, home), project);
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

export function listProjects(home: string = darwinHome()): DarwinProject[] {
  return loadRegistry(home).projects;
}

function normalizeDarwinProject(value: unknown): DarwinProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const project = value as Partial<DarwinProject>;
  if (!isNonEmptyString(project.project_id) || !isNonEmptyString(project.root_path)) {
    return null;
  }
  const created = isNonEmptyString(project.created_at) ? project.created_at : "";
  return {
    project_id: project.project_id,
    name: isNonEmptyString(project.name)
      ? project.name
      : basename(project.root_path) || project.project_id,
    root_path: project.root_path,
    created_at: created,
    last_used_at: isNonEmptyString(project.last_used_at)
      ? project.last_used_at
      : created,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
