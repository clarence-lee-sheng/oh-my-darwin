import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  AGENTS_DIR,
  CAPABILITIES_DIR,
  CAPABILITY_MANIFEST_FILE,
  DARWIN_DIR,
  HOOKS_DIR,
  HOOKS_FILE,
  HOOKS_OWNERSHIP_FILE,
  OWNERSHIP_DIR,
  SKILL_FILE,
  SKILLS_DIR,
  SKILLS_OWNERSHIP_FILE,
} from "../cli/constants.js";
import {
  globalCapabilitiesPath,
  readLocalProject,
  resolveCurrentProject,
  type DarwinProject,
} from "../projects/registry.js";

export type CapabilityKind = "skill" | "hook";
export type HookMode = "observe" | "block_or_allow";

export interface SkillCapabilitySpec {
  kind: "skill";
  name: string;
  description?: string;
  path?: string;
  capability_id?: string;
}

export interface HookCapabilitySpec {
  kind: "hook";
  name: string;
  event: string;
  command?: string;
  mode?: HookMode;
  description?: string;
  capability_id?: string;
}

export type CapabilitySpec = SkillCapabilitySpec | HookCapabilitySpec;

export interface CapabilityManifest {
  version?: 1;
  capabilities?: CapabilitySpec[];
  skills?: Omit<SkillCapabilitySpec, "kind">[];
  hooks?: Omit<HookCapabilitySpec, "kind">[];
}

export interface ValidatedSkillCapability {
  kind: "skill";
  name: string;
  description: string;
  capability_id: string;
  source_path: string;
  relative_source_path: string;
  destination_path: string;
}

export interface ValidatedHookCapability {
  kind: "hook";
  name: string;
  event: string;
  command: string;
  mode: HookMode;
  capability_id: string;
  description?: string;
}

export interface ValidatedCapabilityBundle {
  manifest_path: string;
  skills: ValidatedSkillCapability[];
  hooks: ValidatedHookCapability[];
}

export interface CapabilityOwnershipRecord {
  kind: CapabilityKind;
  name: string;
  capability_id: string;
  project_id: string;
  path?: string;
  event?: string;
  command?: string;
  mode?: HookMode;
  hash?: string;
  updated_at: string;
}

interface SkillOwnershipFile {
  version: 1;
  skills: Record<string, CapabilityOwnershipRecord>;
}

interface HookOwnershipFile {
  version: 1;
  hooks: Record<string, CapabilityOwnershipRecord>;
}

interface GlobalCapabilitiesFile {
  version: 1;
  updated_at: string;
  capabilities: Record<string, CapabilityOwnershipRecord>;
}

export interface PromotionSummary {
  promoted: string[];
  skipped: string[];
}

export interface CapabilityDiscovery {
  active: CapabilityOwnershipRecord[];
  stale: Array<CapabilityOwnershipRecord & { reason: string }>;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOOK_EVENT_RE = /^[a-zA-Z][a-zA-Z0-9_:-]{0,80}$/;

export function capabilityManifestPath(proposalDir: string): string {
  return join(proposalDir, CAPABILITY_MANIFEST_FILE);
}

export function loadCapabilityManifest(
  proposalDir: string,
): CapabilityManifest | null {
  const path = capabilityManifestPath(proposalDir);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as CapabilityManifest;
  return parsed;
}

export function normalizeCapabilitySpecs(
  manifest: CapabilityManifest,
): CapabilitySpec[] {
  const specs: CapabilitySpec[] = [];
  if (Array.isArray(manifest.capabilities)) specs.push(...manifest.capabilities);
  if (Array.isArray(manifest.skills)) {
    specs.push(...manifest.skills.map((s) => ({ ...s, kind: "skill" as const })));
  }
  if (Array.isArray(manifest.hooks)) {
    specs.push(...manifest.hooks.map((h) => ({ ...h, kind: "hook" as const })));
  }
  return specs;
}

export function validateCapabilityProposal(
  cwd: string,
  proposalDir: string,
  project: DarwinProject | null = resolveCurrentProject(cwd),
): ValidatedCapabilityBundle | null {
  const manifest = loadCapabilityManifest(proposalDir);
  if (!manifest) return null;
  if (!project) {
    throw new Error("capability manifest requires a registered Darwin project; run `darwin init` first");
  }

  const manifestPath = capabilityManifestPath(proposalDir);
  const skills: ValidatedSkillCapability[] = [];
  const hooks: ValidatedHookCapability[] = [];
  const seen = new Set<string>();

  for (const spec of normalizeCapabilitySpecs(manifest)) {
    if (spec.kind === "skill") {
      const skill = validateSkillSpec(cwd, proposalDir, project, spec);
      const key = `skill:${skill.name}`;
      if (seen.has(key)) throw new Error(`duplicate capability in manifest: ${key}`);
      seen.add(key);
      skills.push(skill);
      continue;
    }
    if (spec.kind === "hook") {
      const hook = validateHookSpec(spec);
      const key = `hook:${hook.event}`;
      if (seen.has(key)) throw new Error(`duplicate capability in manifest: ${key}`);
      seen.add(key);
      hooks.push(hook);
      continue;
    }
    throw new Error(`unsupported capability kind: ${(spec as { kind?: string }).kind}`);
  }

  return {
    manifest_path: manifestPath,
    skills,
    hooks,
  };
}

function validateSkillSpec(
  cwd: string,
  proposalDir: string,
  project: DarwinProject,
  spec: SkillCapabilitySpec,
): ValidatedSkillCapability {
  const name = normalizeSkillName(spec.name);
  const rel = spec.path ?? join(CAPABILITIES_DIR, SKILLS_DIR, name, SKILL_FILE);
  const sourcePath = resolveUnder(proposalDir, rel, `skill ${name} path`);
  if (!existsSync(sourcePath)) {
    throw new Error(`skill capability ${name} missing file: ${rel}`);
  }
  if (!sourcePath.endsWith(`/${SKILL_FILE}`)) {
    throw new Error(`skill capability ${name} path must end with ${SKILL_FILE}`);
  }

  const parsed = parseSkillFrontmatter(readFileSync(sourcePath, "utf-8"));
  if (!parsed) {
    throw new Error(`skill capability ${name} must be Codex-compatible with YAML frontmatter`);
  }
  if (parsed.fields.name !== name) {
    throw new Error(`skill capability ${name} frontmatter name mismatch`);
  }
  const description = (parsed.fields.description ?? spec.description ?? "").trim();
  if (!description) {
    throw new Error(`skill capability ${name} must include a non-empty description`);
  }

  const destinationPath = join(cwd, AGENTS_DIR, SKILLS_DIR, name, SKILL_FILE);
  guardDarwinOwnedSkillDestination(destinationPath, project.project_id, name);

  return {
    kind: "skill",
    name,
    description,
    capability_id: spec.capability_id ?? `skill:${name}`,
    source_path: sourcePath,
    relative_source_path: rel,
    destination_path: destinationPath,
  };
}

function validateHookSpec(spec: HookCapabilitySpec): ValidatedHookCapability {
  const name = normalizeCapabilityName(spec.name || spec.event);
  const event = (spec.event ?? "").trim();
  if (!HOOK_EVENT_RE.test(event)) {
    throw new Error(`hook capability ${name} has invalid event: ${event}`);
  }
  const command = (spec.command ?? `darwin-hook ${event}`).trim();
  if (command !== `darwin-hook ${event}`) {
    throw new Error(
      `hook capability ${name} is not auto-safe: command must be exactly "darwin-hook ${event}"`,
    );
  }
  const mode = spec.mode ?? "observe";
  if (mode !== "observe" && mode !== "block_or_allow") {
    throw new Error(`hook capability ${name} has invalid mode: ${String(spec.mode)}`);
  }
  return {
    kind: "hook",
    name,
    event,
    command,
    mode,
    capability_id: spec.capability_id ?? `hook:${event}`,
    description: spec.description,
  };
}

export function promoteCapabilities(
  cwd: string,
  bundle: ValidatedCapabilityBundle | null,
  project: DarwinProject | null = resolveCurrentProject(cwd),
): PromotionSummary {
  if (!bundle || (bundle.skills.length === 0 && bundle.hooks.length === 0)) {
    return { promoted: [], skipped: ["no capability manifest"] };
  }
  if (!project) {
    throw new Error("cannot promote capabilities without a registered Darwin project");
  }

  const promoted: string[] = [];
  const now = new Date().toISOString();
  const skillOwnership = readSkillOwnership(cwd);
  const hookOwnership = readHookOwnership(cwd);
  const global = readGlobalCapabilities(project.project_id);

  for (const skill of bundle.skills) {
    const raw = readFileSync(skill.source_path, "utf-8");
    const content = withDarwinSkillOwnership(raw, {
      name: skill.name,
      description: skill.description,
      project_id: project.project_id,
      capability_id: skill.capability_id,
    });
    mkdirSync(dirname(skill.destination_path), { recursive: true });
    writeFileSync(skill.destination_path, content);
    const relPath = relative(cwd, skill.destination_path);
    const record: CapabilityOwnershipRecord = {
      kind: "skill",
      name: skill.name,
      capability_id: skill.capability_id,
      project_id: project.project_id,
      path: relPath,
      hash: sha256(content),
      updated_at: now,
    };
    skillOwnership.skills[skill.name] = record;
    global.capabilities[`skill:${skill.name}`] = record;
    promoted.push(relPath);
  }

  if (bundle.hooks.length > 0) {
    const hooksPath = join(cwd, HOOKS_DIR, HOOKS_FILE);
    const hooksJson = readHooksJson(hooksPath);
    for (const hook of bundle.hooks) {
      const existing = hooksJson[hook.event];
      const owned = hookOwnership.hooks[hook.event];
      if (
        existing !== undefined &&
        existing !== hook.command &&
        !(owned && owned.project_id === project.project_id)
      ) {
        throw new Error(`refusing to overwrite user-owned hook ${hook.event}`);
      }
      hooksJson[hook.event] = hook.command;
      const record: CapabilityOwnershipRecord = {
        kind: "hook",
        name: hook.name,
        capability_id: hook.capability_id,
        project_id: project.project_id,
        event: hook.event,
        command: hook.command,
        mode: hook.mode,
        updated_at: now,
      };
      hookOwnership.hooks[hook.event] = record;
      global.capabilities[`hook:${hook.event}`] = record;
      promoted.push(relative(cwd, hooksPath) + `#${hook.event}`);
    }
    mkdirSync(dirname(hooksPath), { recursive: true });
    atomicJsonWrite(hooksPath, hooksJson);
  }

  writeSkillOwnership(cwd, skillOwnership);
  writeHookOwnership(cwd, hookOwnership);
  writeGlobalCapabilities(project.project_id, global);

  return { promoted, skipped: [] };
}

export function discoverCapabilities(
  cwd: string = process.cwd(),
  project: DarwinProject | null = resolveCurrentProject(cwd),
): CapabilityDiscovery {
  const active: CapabilityOwnershipRecord[] = [];
  const stale: Array<CapabilityOwnershipRecord & { reason: string }> = [];
  if (!project) return { active, stale };

  const skills = readSkillOwnership(cwd).skills;
  for (const record of Object.values(skills)) {
    if (record.project_id !== project.project_id) continue;
    if (!record.path || !record.hash) {
      stale.push({ ...record, reason: "missing path/hash" });
      continue;
    }
    const path = join(cwd, record.path);
    if (!existsSync(path)) {
      stale.push({ ...record, reason: "file missing" });
      continue;
    }
    const actual = sha256(readFileSync(path, "utf-8"));
    if (actual !== record.hash) {
      stale.push({ ...record, reason: "hash mismatch" });
      continue;
    }
    active.push(record);
  }

  const hooksPath = join(cwd, HOOKS_DIR, HOOKS_FILE);
  const hooksJson = readHooksJson(hooksPath);
  const hooks = readHookOwnership(cwd).hooks;
  for (const record of Object.values(hooks)) {
    if (record.project_id !== project.project_id) continue;
    if (!record.event || !record.command) {
      stale.push({ ...record, reason: "missing event/command" });
      continue;
    }
    if (hooksJson[record.event] !== record.command) {
      stale.push({ ...record, reason: "hook command mismatch" });
      continue;
    }
    active.push(record);
  }

  return { active, stale };
}

export function formatCapabilitiesForPrompt(discovery: CapabilityDiscovery): string {
  const lines: string[] = [];
  if (discovery.active.length === 0) {
    lines.push("(none)");
  } else {
    for (const cap of discovery.active) {
      if (cap.kind === "skill") {
        lines.push(`- skill ${cap.name}: ${cap.path}`);
      } else {
        lines.push(`- hook ${cap.name}: ${cap.event} → ${cap.command} (${cap.mode})`);
      }
    }
  }
  if (discovery.stale.length > 0) {
    lines.push("\nStale/dirty capabilities are NOT available until repaired:");
    for (const cap of discovery.stale) {
      lines.push(`- ${cap.kind} ${cap.name}: ${cap.reason}`);
    }
  }
  return lines.join("\n");
}

function guardDarwinOwnedSkillDestination(
  destinationPath: string,
  projectId: string,
  name: string,
): void {
  if (!existsSync(destinationPath)) return;
  const parsed = parseSkillFrontmatter(readFileSync(destinationPath, "utf-8"));
  const owned = parsed?.fields["x-darwin-owned"] === "true";
  const ownerProject = parsed?.fields["x-darwin-project-id"];
  if (!owned || ownerProject !== projectId) {
    throw new Error(`refusing to overwrite user-owned project skill: ${name}`);
  }
}

function normalizeSkillName(name: string): string {
  const n = normalizeCapabilityName(name);
  if (!SKILL_NAME_RE.test(n)) {
    throw new Error(`invalid skill name: ${name}`);
  }
  return n;
}

function normalizeCapabilityName(name: string): string {
  const n = (name ?? "").trim().toLowerCase();
  if (!n || !/^[a-z0-9][a-z0-9_-]{0,80}$/.test(n)) {
    throw new Error(`invalid capability name: ${name}`);
  }
  return n.replaceAll("_", "-");
}

function resolveUnder(base: string, rel: string, label: string): string {
  if (!rel || isAbsolute(rel)) throw new Error(`${label} must be a relative path`);
  const normalized = normalize(rel);
  if (normalized.startsWith("..")) throw new Error(`${label} cannot escape proposal dir`);
  const full = resolve(base, normalized);
  const root = resolve(base);
  if (full !== root && !full.startsWith(root + "/")) {
    throw new Error(`${label} cannot escape proposal dir`);
  }
  return full;
}

function parseSkillFrontmatter(content: string): {
  fields: Record<string, string>;
  body: string;
} | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
  if (end === -1) return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    fields[m[1]] = stripYamlString(m[2]);
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

function withDarwinSkillOwnership(
  content: string,
  fields: {
    name: string;
    description: string;
    project_id: string;
    capability_id: string;
  },
): string {
  const parsed = parseSkillFrontmatter(content);
  const frontmatter = {
    ...(parsed?.fields ?? {}),
    name: fields.name,
    description: fields.description,
    "x-darwin-owned": "true",
    "x-darwin-project-id": fields.project_id,
    "x-darwin-capability-id": fields.capability_id,
  };
  const body = parsed?.body ?? content;
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${yamlString(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n${body.replace(/^\n+/, "")}`;
}

function stripYamlString(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function yamlString(value: string): string {
  if (/^[A-Za-z0-9_.:/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function readSkillOwnership(cwd: string): SkillOwnershipFile {
  const path = join(cwd, DARWIN_DIR, OWNERSHIP_DIR, SKILLS_OWNERSHIP_FILE);
  if (!existsSync(path)) return { version: 1, skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as SkillOwnershipFile;
    if (parsed.version === 1 && parsed.skills) return parsed;
  } catch {
    // ignore corrupt file and rewrite below
  }
  return { version: 1, skills: {} };
}

function writeSkillOwnership(cwd: string, data: SkillOwnershipFile): void {
  const path = join(cwd, DARWIN_DIR, OWNERSHIP_DIR, SKILLS_OWNERSHIP_FILE);
  mkdirSync(dirname(path), { recursive: true });
  atomicJsonWrite(path, data);
}

function readHookOwnership(cwd: string): HookOwnershipFile {
  const path = join(cwd, DARWIN_DIR, OWNERSHIP_DIR, HOOKS_OWNERSHIP_FILE);
  if (!existsSync(path)) return { version: 1, hooks: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as HookOwnershipFile;
    if (parsed.version === 1 && parsed.hooks) return parsed;
  } catch {
    // ignore corrupt file and rewrite below
  }
  return { version: 1, hooks: {} };
}

function writeHookOwnership(cwd: string, data: HookOwnershipFile): void {
  const path = join(cwd, DARWIN_DIR, OWNERSHIP_DIR, HOOKS_OWNERSHIP_FILE);
  mkdirSync(dirname(path), { recursive: true });
  atomicJsonWrite(path, data);
}

function readGlobalCapabilities(projectId: string): GlobalCapabilitiesFile {
  const path = globalCapabilitiesPath(projectId);
  if (!existsSync(path)) {
    return { version: 1, updated_at: new Date().toISOString(), capabilities: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as GlobalCapabilitiesFile;
    if (parsed.version === 1 && parsed.capabilities) return parsed;
  } catch {
    // ignore corrupt file and rewrite below
  }
  return { version: 1, updated_at: new Date().toISOString(), capabilities: {} };
}

function writeGlobalCapabilities(projectId: string, data: GlobalCapabilitiesFile): void {
  data.updated_at = new Date().toISOString();
  const path = globalCapabilitiesPath(projectId);
  mkdirSync(dirname(path), { recursive: true });
  atomicJsonWrite(path, data);
}

function readHooksJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function atomicJsonWrite(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

// Re-export for tests and simple CLI status surfaces.
export { readLocalProject };
