// Codex and OMX both consume Codex's native hook surface. OMX is launched as a
// wrapper CLI, but its lifecycle hooks are still registered through .codex.
export const HOOKS_DIR = ".codex";
export const HOOKS_FILE = "hooks.json";
export const AGENTS_DIR = ".agents";
export const DARWIN_DIR = ".darwin";
export const EVENTS_LOG = "events.jsonl";
export const PLUGINS_DIR = "plugins";
export const PROJECT_FILE = "project.json";

// Project-scoped Codex skills.
export const SKILLS_DIR = "skills";
export const SKILL_FILE = "SKILL.md";

// Darwin-owned capability tracking. Ownership is stored both locally
// (inside the repo) and globally (inside ~/.darwin/projects/<id>).
export const OWNERSHIP_DIR = "ownership";
export const SKILLS_OWNERSHIP_FILE = "skills.json";
export const HOOKS_OWNERSHIP_FILE = "hooks.json";

// `darwin init` artifacts.
export const META_SPEC_FILE = "meta-spec.md";
export const INIT_DIR = "init";
export const TRANSCRIPT_FILE = "transcript.jsonl";

// `darwin baseline` / `darwin meta` artifacts.
export const FRONTIER_FILE = "frontier.json";
export const EVOLUTION_FILE = "evolution.jsonl";
export const RUNS_DIR = "runs";
export const BASELINE_RUN_ID = "baseline";

// `darwin meta` Tier 5 harness artifacts.
// The harness is loaded at runtime via dynamic import; Node only understands
// .mjs/.js, not .ts, so the file ships as ESM JavaScript with JSDoc types.
export const HARNESS_DIR = "harness";
export const HARNESS_FILE = "harness.mjs";
export const PROPOSALS_DIR = "proposals";
export const CAPABILITY_MANIFEST_FILE = "capability-manifest.json";
export const CAPABILITIES_DIR = "capabilities";
