import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
import { formatErrorSummary } from "../runtime/diagnostics.js";
import { atomicJsonWrite, readJsonFile } from "../state/json-file.js";

export type CapabilityKind = "skill" | "hook";
export type HookMode = "observe" | "block_or_allow";
export type CodexHookEvent =
  | "SessionStart"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop";

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
  /** Codex hook event, e.g. PreToolUse, or Darwin's legacy snake_case alias. */
  event: string;
  /** Optional Codex matcher regex. Ignored events must omit it. */
  matcher?: string;
  command?: string;
  mode?: HookMode;
  timeout?: number;
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
  /** Darwin plugin/event alias used by darwin-hook and .darwin/events.jsonl. */
  event: string;
  /** Native Codex hooks.json event name. */
  codex_event: CodexHookEvent;
  matcher?: string;
  command: string;
  mode: HookMode;
  timeout?: number;
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
  codex_event?: CodexHookEvent;
  matcher?: string;
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

export interface CapabilityPromotionOptions {
  home?: string;
}

export interface CapabilityDiscovery {
  active: CapabilityOwnershipRecord[];
  stale: Array<CapabilityOwnershipRecord & { reason: string }>;
  omitted?: number;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DEFAULT_CAPABILITY_OUTPUT_LIMIT = 50;
const CODEX_HOOK_EVENTS: Record<string, { codex_event: CodexHookEvent; event: string; matcher: boolean }> = {
  sessionstart: { codex_event: "SessionStart", event: "session_start", matcher: true },
  session_start: { codex_event: "SessionStart", event: "session_start", matcher: true },
  pretooluse: { codex_event: "PreToolUse", event: "pre_tool_use", matcher: true },
  pre_tool_use: { codex_event: "PreToolUse", event: "pre_tool_use", matcher: true },
  permissionrequest: { codex_event: "PermissionRequest", event: "permission_request", matcher: true },
  permission_request: { codex_event: "PermissionRequest", event: "permission_request", matcher: true },
  posttooluse: { codex_event: "PostToolUse", event: "post_tool_use", matcher: true },
  post_tool_use: { codex_event: "PostToolUse", event: "post_tool_use", matcher: true },
  userpromptsubmit: { codex_event: "UserPromptSubmit", event: "user_prompt_submit", matcher: false },
  user_prompt_submit: { codex_event: "UserPromptSubmit", event: "user_prompt_submit", matcher: false },
  stop: { codex_event: "Stop", event: "stop", matcher: false },
};

export function capabilityManifestPath(proposalDir: string): string {
  return join(proposalDir, CAPABILITY_MANIFEST_FILE);
}

export function loadCapabilityManifest(
  proposalDir: string,
): CapabilityManifest | null {
  const path = capabilityManifestPath(proposalDir);
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!isRecord(parsed)) {
    throw new Error("capability manifest must be a JSON object");
  }
  return parsed as CapabilityManifest;
}

export function normalizeCapabilitySpecs(
  manifest: CapabilityManifest,
): CapabilitySpec[] {
  const specs: CapabilitySpec[] = [];
  if (Array.isArray(manifest.capabilities)) {
    for (const spec of manifest.capabilities) {
      if (!isRecord(spec)) {
        throw new Error(
          `capability manifest entry must be a JSON object: ${formatCapabilityField(spec)}`,
        );
      }
      specs.push(spec as CapabilitySpec);
    }
  }
  if (Array.isArray(manifest.skills)) {
    for (const spec of manifest.skills) {
      if (!isRecord(spec)) {
        throw new Error(
          `skill manifest entry must be a JSON object: ${formatCapabilityField(spec)}`,
        );
      }
      specs.push({ ...spec, kind: "skill" as const } as SkillCapabilitySpec);
    }
  }
  if (Array.isArray(manifest.hooks)) {
    for (const spec of manifest.hooks) {
      if (!isRecord(spec)) {
        throw new Error(
          `hook manifest entry must be a JSON object: ${formatCapabilityField(spec)}`,
        );
      }
      specs.push({ ...spec, kind: "hook" as const } as HookCapabilitySpec);
    }
  }
  return specs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
      const key = `hook:${hook.codex_event}`;
      if (seen.has(key)) throw new Error(`duplicate capability in manifest: ${key}`);
      seen.add(key);
      hooks.push(hook);
      continue;
    }
    throw new Error(`unsupported capability kind: ${formatCapabilityField((spec as { kind?: string }).kind)}`);
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
    throw new Error(`skill capability ${name} missing file: ${formatCapabilityField(rel)}`);
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
  const eventInfo = normalizeHookEvent(spec.event);
  const matcher = normalizeHookMatcher(spec.matcher, eventInfo.matcher, name);
  const command = (spec.command ?? `darwin-hook ${eventInfo.event}`).trim();
  if (command !== `darwin-hook ${eventInfo.event}`) {
    throw new Error(
      `hook capability ${name} is not auto-safe: command must be exactly "darwin-hook ${eventInfo.event}"`,
    );
  }
  const mode = spec.mode ?? "observe";
  if (mode !== "observe" && mode !== "block_or_allow") {
    throw new Error(`hook capability ${name} has invalid mode: ${formatCapabilityField(spec.mode)}`);
  }
  const timeout = normalizeHookTimeout(spec.timeout, name);
  return {
    kind: "hook",
    name,
    event: eventInfo.event,
    codex_event: eventInfo.codex_event,
    matcher,
    command,
    mode,
    timeout,
    capability_id: spec.capability_id ?? `hook:${eventInfo.codex_event}`,
    description: spec.description,
  };
}

export function promoteCapabilities(
  cwd: string,
  bundle: ValidatedCapabilityBundle | null,
  project: DarwinProject | null = resolveCurrentProject(cwd),
  opts: CapabilityPromotionOptions = {},
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
  const global = readGlobalCapabilities(project.project_id, opts.home);

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
      upsertNativeDarwinHook(hooksJson, hook);
      const record: CapabilityOwnershipRecord = {
        kind: "hook",
        name: hook.name,
        capability_id: hook.capability_id,
        project_id: project.project_id,
        event: hook.event,
        codex_event: hook.codex_event,
        matcher: matcherForNativeConfig(hook),
        command: hook.command,
        mode: hook.mode,
        updated_at: now,
      };
      hookOwnership.hooks[hook.capability_id] = record;
      global.capabilities[hook.capability_id] = record;
      promoted.push(relative(cwd, hooksPath) + `#${hook.codex_event}`);
    }
    mkdirSync(dirname(hooksPath), { recursive: true });
    atomicJsonWrite(hooksPath, hooksJson);
  }

  writeSkillOwnership(cwd, skillOwnership);
  writeHookOwnership(cwd, hookOwnership);
  writeGlobalCapabilities(project.project_id, global, opts.home);

  return { promoted, skipped: [] };
}

export function discoverCapabilities(
  cwd: string = process.cwd(),
  project: DarwinProject | null = resolveCurrentProject(cwd),
  opts: CapabilityDiscoveryOptions = {},
): CapabilityDiscovery {
  const active: CapabilityOwnershipRecord[] = [];
  const stale: Array<CapabilityOwnershipRecord & { reason: string }> = [];
  let omitted = 0;
  if (!project) return { active, stale };
  const inspectLimit = normalizeCapabilityInspectLimit(opts.inspectLimit);
  const shouldInspect = () => {
    if (active.length + stale.length >= inspectLimit) {
      omitted++;
      return false;
    }
    return true;
  };

  const skills = readSkillOwnership(cwd).skills;
  for (const record of Object.values(skills)) {
    if (record.project_id !== project.project_id) continue;
    if (!shouldInspect()) continue;
    if (!record.path || !record.hash) {
      stale.push({ ...record, reason: "missing path/hash" });
      continue;
    }
    const path = join(cwd, record.path);
    if (!existsSync(path)) {
      stale.push({ ...record, reason: "file missing" });
      continue;
    }
    let actual: string;
    try {
      actual = sha256File(path);
    } catch (err) {
      stale.push({ ...record, reason: `hash read failed: ${formatErrorSummary(err, 120)}` });
      continue;
    }
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
    if (!shouldInspect()) continue;
    if (!record.event || !record.command) {
      stale.push({ ...record, reason: "missing event/command" });
      continue;
    }
    if (!hasNativeDarwinHook(hooksJson, record)) {
      stale.push({ ...record, reason: "hook command mismatch" });
      continue;
    }
    active.push(record);
  }

  return omitted > 0 ? { active, stale, omitted } : { active, stale };
}

export interface CapabilityDiscoveryOptions {
  inspectLimit?: number;
}

export interface CapabilityFormatOptions {
  limit?: number;
}

export function formatCapabilitiesForPrompt(
  discovery: CapabilityDiscovery,
  opts: CapabilityFormatOptions = {},
): string {
  const limit = normalizeCapabilityOutputLimit(opts.limit);
  const lines: string[] = [];
  if (discovery.active.length === 0) {
    lines.push("(none)");
  } else {
    const active = discovery.active.slice(0, limit);
    for (const cap of active) {
      if (cap.kind === "skill") {
        lines.push(`- skill ${formatCapabilityField(cap.name)}: ${formatCapabilityField(cap.path)}`);
      } else {
        const event = cap.codex_event ?? cap.event;
        const matcher = cap.matcher ? ` matcher=${formatCapabilityField(cap.matcher)}` : "";
        lines.push(
          `- hook ${formatCapabilityField(cap.name)}: ${formatCapabilityField(event)}${matcher} -> ${formatCapabilityField(cap.command)} (${formatCapabilityField(cap.mode)})`,
        );
      }
    }
    const omitted = discovery.active.length - active.length;
    if (omitted > 0) {
      lines.push(`- ... ${omitted} more active capabilities omitted`);
    }
  }
  if (discovery.stale.length > 0) {
    lines.push("\nStale/dirty capabilities are NOT available until repaired:");
    const stale = discovery.stale.slice(0, limit);
    for (const cap of stale) {
      lines.push(
        `- ${formatCapabilityField(cap.kind)} ${formatCapabilityField(cap.name)}: ${formatCapabilityField(cap.reason)}`,
      );
    }
    const omitted = discovery.stale.length - stale.length;
    if (omitted > 0) {
      lines.push(`- ... ${omitted} more stale capabilities omitted`);
    }
  }
  if (discovery.omitted && discovery.omitted > 0) {
    lines.push(`\n${discovery.omitted} capability record(s) not inspected in this summary`);
  }
  return lines.join("\n");
}

function formatCapabilityField(value: unknown): string {
  return formatErrorSummary(value);
}

function normalizeCapabilityOutputLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_CAPABILITY_OUTPUT_LIMIT;
  return Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : DEFAULT_CAPABILITY_OUTPUT_LIMIT;
}

function normalizeCapabilityInspectLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  return Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : Number.POSITIVE_INFINITY;
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
    throw new Error(`invalid skill name: ${formatCapabilityField(name)}`);
  }
  return n;
}

function normalizeCapabilityName(name: string): string {
  const n = (name ?? "").trim().toLowerCase();
  if (!n || !/^[a-z0-9][a-z0-9_-]{0,80}$/.test(n)) {
    throw new Error(`invalid capability name: ${formatCapabilityField(name)}`);
  }
  return n.replaceAll("_", "-");
}

function normalizeHookEvent(raw: string): {
  codex_event: CodexHookEvent;
  event: string;
  matcher: boolean;
} {
  const key = (raw ?? "").trim().replaceAll("-", "_").toLowerCase();
  const info = CODEX_HOOK_EVENTS[key];
  if (!info) {
    throw new Error(
      `unsupported Codex hook event: ${formatCapabilityField(raw)} (expected known Codex hook event)`,
    );
  }
  return info;
}

function normalizeHookMatcher(
  raw: string | undefined,
  supported: boolean,
  hookName: string,
): string | undefined {
  const matcher = raw?.trim();
  if (!matcher) return undefined;
  if (!supported) {
    throw new Error(`hook capability ${hookName} uses matcher on an event where Codex ignores matchers`);
  }
  if (matcher.length > 200) {
    throw new Error(`hook capability ${hookName} matcher is too long: ${formatCapabilityField(matcher)}`);
  }
  return matcher;
}

function normalizeHookTimeout(raw: number | undefined, hookName: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw <= 0 || raw > 600) {
    throw new Error(`hook capability ${hookName} has invalid timeout: ${formatCapabilityField(raw)}`);
  }
  return Math.floor(raw);
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
  const parsed = readJsonFile<SkillOwnershipFile>(path);
  if (parsed?.version === 1 && isRecord(parsed.skills)) {
    return parsed;
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
  const parsed = readJsonFile<HookOwnershipFile>(path);
  if (parsed?.version === 1 && isRecord(parsed.hooks)) {
    return parsed;
  }
  return { version: 1, hooks: {} };
}

function writeHookOwnership(cwd: string, data: HookOwnershipFile): void {
  const path = join(cwd, DARWIN_DIR, OWNERSHIP_DIR, HOOKS_OWNERSHIP_FILE);
  mkdirSync(dirname(path), { recursive: true });
  atomicJsonWrite(path, data);
}

function readGlobalCapabilities(
  projectId: string,
  home?: string,
): GlobalCapabilitiesFile {
  const path = globalCapabilitiesPath(projectId, home);
  const parsed = readJsonFile<GlobalCapabilitiesFile>(path);
  if (parsed?.version === 1 && isRecord(parsed.capabilities)) {
    return parsed;
  }
  return { version: 1, updated_at: new Date().toISOString(), capabilities: {} };
}

function writeGlobalCapabilities(
  projectId: string,
  data: GlobalCapabilitiesFile,
  home?: string,
): void {
  data.updated_at = new Date().toISOString();
  const path = globalCapabilitiesPath(projectId, home);
  mkdirSync(dirname(path), { recursive: true });
  atomicJsonWrite(path, data);
}

interface NativeHookCommand {
  type?: string;
  command?: string;
  statusMessage?: string;
  timeout?: number;
}

interface NativeHookMatcherGroup {
  matcher?: string;
  hooks?: NativeHookCommand[];
}

interface NativeHooksJson extends Record<string, unknown> {
  hooks?: Record<string, NativeHookMatcherGroup[]>;
}

function upsertNativeDarwinHook(
  config: Record<string, unknown>,
  hook: ValidatedHookCapability,
): void {
  const native = config as NativeHooksJson;
  if (!native.hooks || typeof native.hooks !== "object" || Array.isArray(native.hooks)) {
    native.hooks = {};
  }
  const groups = Array.isArray(native.hooks[hook.codex_event])
    ? native.hooks[hook.codex_event]
    : [];
  native.hooks[hook.codex_event] = groups;

  const matcher = matcherForNativeConfig(hook);
  let group = groups.find((entry) => matcherValuesEqual(entry.matcher, matcher));
  if (!group) {
    group = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] };
    groups.push(group);
  }
  if (!Array.isArray(group.hooks)) group.hooks = [];

  const handler: NativeHookCommand = {
    type: "command",
    command: hook.command,
    statusMessage: hook.description
      ? formatCapabilityField(hook.description)
      : `Darwin ${hook.codex_event}`,
  };
  if (hook.timeout !== undefined) handler.timeout = hook.timeout;

  const existingIdx = group.hooks.findIndex((entry) =>
    entry &&
    typeof entry === "object" &&
    entry.type === "command" &&
    entry.command === hook.command
  );
  if (existingIdx === -1) group.hooks.push(handler);
  else group.hooks[existingIdx] = { ...group.hooks[existingIdx], ...handler };
}

function hasNativeDarwinHook(
  config: Record<string, unknown>,
  record: CapabilityOwnershipRecord,
): boolean {
  const command = record.command;
  if (!command) return false;
  let eventInfo: ReturnType<typeof normalizeHookEvent>;
  try {
    eventInfo = normalizeHookEvent(record.codex_event ?? record.event ?? "");
  } catch {
    return false;
  }
  const native = config as NativeHooksJson;

  const groups = native.hooks?.[eventInfo.codex_event];
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!matcherValuesEqual(group.matcher, record.matcher)) continue;
      if (group.hooks?.some((entry) =>
        entry &&
        typeof entry === "object" &&
        entry.type === "command" &&
        entry.command === command
      )) {
        return true;
      }
    }
  }

  // Backward-compatible check for pre-native Darwin hook files. This lets
  // existing ownership records report active until setup/meta upgrades hooks.
  const legacy = config[eventInfo.event] ?? config[eventInfo.codex_event];
  return legacy === command;
}

function matcherForNativeConfig(hook: ValidatedHookCapability): string | undefined {
  if (!CODEX_HOOK_EVENTS[hook.event]?.matcher) return undefined;
  if (hook.matcher) return hook.matcher;
  return hook.codex_event === "SessionStart" ? "startup|resume|clear" : "*";
}

function matcherValuesEqual(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

function readHooksJson(path: string): Record<string, unknown> {
  const parsed = readJsonFile<Record<string, unknown>>(path);
  return isRecord(parsed) ? parsed : {};
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// Re-export for tests and simple CLI status surfaces.
export { readLocalProject };
