export const HOOKS_DIR = ".codex";
export const HOOKS_FILE = "hooks.json";
export const DARWIN_DIR = ".darwin";
export const EVENTS_LOG = "events.jsonl";
export const PLUGINS_DIR = "plugins";

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
