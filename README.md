# oh-my-darwin

oh-my-darwin turns "I have a task" into a runnable meta-harness loop:
interview the user, write a task spec, run a baseline, propose better
attempts, score them, and keep the frontier — without asking you to build
that propose/evaluate/score machinery yourself.

Built on top of OMX (`oh-my-codex`) and the Codex CLI. Darwin defaults to
`omx --madmax --xhigh` and falls back to Codex yolo mode
(`codex --dangerously-bypass-approvals-and-sandbox`) when OMX is not available. See `darwin_spec.md` for the full design rationale.

## What Darwin gives you

- **Guided setup** — `darwin init` asks the first task question locally,
  scans the project, then runs an adaptive Socratic interview that writes
  `.darwin/meta-spec.md`.
- **Baseline and frontier tracking** — `darwin baseline` records the initial
  run, score, trajectory, `.darwin/frontier.json`, and append-only
  `.darwin/evolution.jsonl`.
- **Goal-mode meta loop by default** — `darwin meta` proposes `{goal, knobs,
  rationale}` JSON, launches the selected engine with a real `/goal` prompt,
  waits for quiet/completion, scores the result, and updates the frontier.
  `harness.mjs` remains central: each iteration first proposes a candidate
  harness, calls `buildPrompt(task)` to shape the goal proposal and attempt
  context, then promotes that harness when the attempt becomes the frontier.
- **Harness-mode compatibility** — `darwin meta --harness-mode` still supports
  the earlier harness-transform workflow when you want a generated
  `harness.mjs` to reshape each attempt prompt.
- **Project-scoped capabilities** — proposals can stage Codex Agent Skills and
  safe Codex hook entries, which Darwin validates and promotes into the
  current project only.
- **Plain-text observability** — events, transcripts, proposals, runs,
  capability ownership, and strategy state are all Markdown/JSON/JSONL files
  under `.darwin/`.
- **Zero runtime dependencies** — the package runs on Node ≥ 20 and keeps
  runtime state local to the target project plus the optional `~/.darwin`
  registry.

## Quick start

From this repository:

```bash
npm install
npm link        # exposes `darwin` and `darwin-hook` on PATH
```

Then from the project you want Darwin to optimize:

```bash
cd ~/your/project
darwin init     # uses omx --madmax --xhigh; produces .darwin/meta-spec.md
darwin baseline # uses omx --madmax --xhigh; captures starting score
darwin meta     # iterative loop; may stage/promote safe project capabilities
```

To force Codex instead (also yolo by default):

```bash
darwin --codex baseline
DARWIN_ENGINE=codex darwin meta
# override yolo by providing explicit Codex flags:
darwin --codex --sandbox read-only baseline
```

## Typical workflow

1. **Describe the task** with `darwin init`; Darwin captures the task, scorer,
   constraints, HITL pattern, optimization surface, and stop condition.
2. **Get a starting point** with `darwin baseline`; the first score becomes the
   initial frontier.
3. **Let the loop search** with `darwin meta`; bounded runs can use
   `--iterations N` or `--duration 30m`, while unbounded runs prompt before
   each proposed goal.
4. **Inspect progress** with `darwin status`, `.darwin/evolution.jsonl`, and
   `.darwin/runs/<attempt-id>/`.
5. **Promote reusable help** through capability manifests when a successful
   iteration discovers a project-scoped skill or hook that should influence the
   next iteration.

## CLI reference

- **`darwin`** — auto-installs `.codex/hooks.json` if missing, then launches the selected agent engine (`omx --madmax --xhigh` by default, fallback to `codex --dangerously-bypass-approvals-and-sandbox` if OMX cannot launch). Every lifecycle event is logged to `.darwin/events.jsonl`.
- **`darwin init`** — asks the first task question locally before scanning or invoking the selected engine, then runs the adaptive Socratic interview that produces `.darwin/meta-spec.md`: task, scorer, constraints, HITL pattern, optimization surface, stop condition. It also registers/chooses a project in `~/.darwin`.
- **`darwin projects`** / **`darwin list`** — list the global `~/.darwin` project registry.
- **`darwin baseline`** — reads the spec, launches the selected engine interactively with the task as the initial prompt, prompts you for a realized score on exit, writes `.darwin/frontier.json`, and appends to `.darwin/evolution.jsonl`.
- **`darwin meta`** — the loop. Each iteration proposes a candidate harness, executes a candidate attempt, scores it, and updates the frontier using the active strategy hooks. Two execution modes:
  - **goal-mode (default)** — proposer writes `.darwin/proposals/iter-N/harness.mjs`, Darwin loads it and calls `buildPrompt(task)`, then the goal proposer outputs `{goal, knobs, rationale}` JSON from that harness-shaped context. Attempts default to launching the interactive engine with a short initial `/goal ...` prompt that points at `.darwin/runs/iter-N/goal.md`, so Codex's real goal machinery is active while Darwin can still advance multi-iteration runs automatically after quiet. Use `--goal-runner exec` for the non-slash automation path, or `--goal-runner slash` for legacy post-start TUI `/goal` injection. Attempts run until quiet (no new tool activity for `--attempt-quiet 60s` after the last stop) or `--attempt-max 30m`. HITL prompt approves each proposed goal before it runs when the run is unbounded or `--interactive` is set. If the attempt improves the frontier, Darwin promotes the candidate harness to `.darwin/harness/harness.mjs`.
  - **`darwin meta --harness-mode`** — proposer writes a `harness.mjs` that transforms the task prompt; the selected engine runs the transformed prompt once per attempt. Proposals may include project-scoped Codex `SKILL.md` files and safe `.codex/hooks.json` entries that are auto-promoted for the next iteration.
- **`darwin status`** — show current project, frontier, evolution count, recent attempts, and active/stale capabilities.
- **`darwin capabilities`** — show active/stale project-scoped skills/hooks.
- **`darwin setup`** — explicit (re)install of `.codex/hooks.json`.
- **`darwin hook <event>`** / **`darwin-hook <event>`** — per-event handler invoked by the Codex/OMX hook surface; dispatches to the central event bus. Native Codex events captured include `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, and `Stop` (stored internally as snake_case aliases).
- **`darwin --help`** — print usage, engine-selection defaults, and current meta-loop options.

## Engine selection

OMX is the default:

```bash
darwin "fix the failing tests"      # omx --madmax --xhigh
darwin baseline                     # omx --madmax --xhigh
```

Codex can be selected per invocation or through the environment. With no explicit engine args, Codex uses its yolo-equivalent bypass flag:

```bash
darwin --codex "fix the failing tests"
darwin --engine codex baseline
DARWIN_ENGINE=codex darwin init
```

For subcommands that spawn agents internally (`init`, `baseline`, `meta`),
prepend engine launch flags either before the subcommand or with
`DARWIN_ENGINE_ARGS`. If you provide no engine args, Darwin uses
`--madmax --xhigh` for OMX and `--dangerously-bypass-approvals-and-sandbox` for Codex:

```bash
darwin --omx --madmax --xhigh baseline
DARWIN_ENGINE=omx DARWIN_ENGINE_ARGS="--madmax --xhigh" darwin meta
```

When using OMX, Darwin defaults `OMX_LAUNCH_POLICY=direct` for child processes so
`baseline`/`meta` can wait for the interactive agent to exit and then ask for the
score. Explicit OMX flags such as `--tmux` still override that default. If the
`omx` executable is missing or cannot be launched, Darwin retries with Codex yolo mode
and does not pass OMX-only flags to the fallback.

## Operational bounds

Quiet automation paths have conservative caps so the parent terminal does not sit
behind a stuck child process forever. Values are milliseconds unless noted.

| Variable | Default | Applies to |
|----------|---------|------------|
| `DARWIN_PROPOSER_TIMEOUT_MS` | `120000` | harness-mode proposal generation |
| `DARWIN_GOAL_PROPOSER_TIMEOUT_MS` | `120000` | goal-mode proposal generation |
| `DARWIN_INTERVIEWER_TIMEOUT_MS` | `120000` | `darwin init` interviewer turns |
| `DARWIN_SCORER_TIMEOUT_MS` | `1800000` | command and test-suite scorers |
| `DARWIN_SCORER_PARSE_BUFFER_CHARS` | `1000000` chars | in-memory scorer parse head/tail buffers; stdout/stderr artifacts still receive full output |
| `DARWIN_HOOK_STDIN_LIMIT_CHARS` | `64000` chars | maximum hook stdin kept in memory and written to `.darwin/events.jsonl`; oversized payloads are marked truncated |
| `DARWIN_HOOK_PLUGIN_TIMEOUT_MS` | `2000` | per-plugin hook handler timeout; timed-out handlers are logged and skipped |
| `DARWIN_EVENT_LOG_STRING_LIMIT_CHARS` | `8000` chars | per-string cap applied only to `.darwin/events.jsonl`; plugin payloads keep original values |

## File layout in a darwin-managed project

```
your-project/
├── .codex/hooks.json           # auto-installed; tells Codex/OMX to call darwin-hook
├── .agents/skills/*/SKILL.md   # project-scoped Codex skills owned by Darwin
└── .darwin/
    ├── project.json            # selected global ~/.darwin project id
    ├── meta-spec.md            # the spec (from `darwin init`)
    ├── frontier.json           # current best attempt
    ├── niches.json             # MAP-Elites grid (only if that strategy is used)
    ├── evolution.jsonl         # append-only history of all attempts
    ├── events.jsonl            # raw agent lifecycle events
    ├── ownership/*.json        # Darwin-owned skills/hooks metadata
    ├── proposals/<attempt-id>/ # staged harness + optional capability manifest
    ├── harness/harness.mjs     # active harness — also carries the strategy hooks
    ├── runs/<attempt-id>/      # per-attempt trajectories + artifacts
    ├── init/transcript.jsonl   # interview transcript
    └── plugins/*.mjs           # opt-in user plugins (rarely needed)
```

Global project registry:

```
~/.darwin/
├── projects.json
└── projects/<project-id>/
    ├── project.json
    └── capabilities.json
```

`darwin init` auto-selects a project only when the current working
directory exactly matches a registered `root_path`. Otherwise it offers
to attach an existing project or create a new one.

## Evolutionary strategies

The active harness file (`.darwin/harness/harness.mjs`) is Darwin's
evolutionary artifact in both execution modes. In default goal-mode,
`buildPrompt(task)` creates the harness-shaped context used by the goal
proposer and included in the final `/goal` attempt. In `--harness-mode`,
`buildPrompt(task)` is the attempt prompt sent directly to the selected
engine. The same file can also provide **evolutionary strategy** hooks. If a
hook is absent, defaults reproduce Darwin's greedy single-frontier behavior.

| Hook                        | Decides                                              | Default                          |
|-----------------------------|------------------------------------------------------|----------------------------------|
| `selectParents(ctx)`        | Which prior attempts the proposer sees this iter     | Last 5 history rows              |
| `mutationDirective(ctx)`    | Free-form steering string injected into the prompt   | `""` (no extra steering)         |
| `acceptCandidate(c, ctx)`   | Whether to execute the candidate (post-propose)      | Always accept                    |
| `updatePopulation(a, p, c)` | New frontier + optional niche grid after each attempt | Replace frontier if score better |

`ctx` is read-only and includes the iteration number, mode (`harness` or
`goal`), the current frontier, recent history, the spec, and a
deterministic RNG. Failing hooks log a warning and fall back to defaults —
the loop never crashes from a bad strategy.

Four reference strategies live in `templates/strategies/`:

- **greedy.mjs** — default behavior, made explicit. Always mutates against
  the frontier.
- **tournament.mjs** — sample 3 random prior attempts, pick the best, mutate
  against it. Diversifies parent selection vs pure greedy.
- **novelty.mjs** — bias toward attempts whose goal text is most distant
  (token-Jaccard) from the frontier. Encourages exploration.
- **map-elites.mjs** — maintain a grid of best-per-niche
  (`sandbox × model`). Proposer sees a random niche elite each iter.
  Writes `.darwin/niches.json` alongside `frontier.json`.

To use one: copy it to `.darwin/harness/harness.mjs` before running
`darwin meta`. (Or let the proposer evolve its own strategy hooks over
iterations — they're just methods on the harness object.)

## Capability manifests

`darwin meta` proposers may optionally write `.darwin/proposals/<attempt-id>/capability-manifest.json`:

```json
{
  "version": 1,
  "capabilities": [
    {
      "kind": "skill",
      "name": "task-helper",
      "path": "capabilities/skills/task-helper/SKILL.md"
    },
    {
      "kind": "hook",
      "name": "pretool-guard",
      "event": "PreToolUse",
      "matcher": "Bash",
      "mode": "block_or_allow"
    }
  ]
}
```

Skills must be Codex Agent Skills: a directory containing `SKILL.md`
with YAML `name` and `description`, plus optional `scripts/`,
`references/`, and `assets/`. Darwin promotes them only inside the
project at `.agents/skills/<name>/SKILL.md`, which Codex scans as a
repo-scoped skill location.

Hooks are written as native Codex `.codex/hooks.json` entries under the
top-level `hooks` object. Manifest hook events may use canonical Codex
names (`SessionStart`, `PreToolUse`, `PermissionRequest`,
`PostToolUse`, `UserPromptSubmit`, `Stop`) or Darwin's snake_case
aliases. The actual command is always the safe dispatcher
`darwin-hook <snake_case_event>`; custom hook behavior belongs in
`.darwin/plugins/*.mjs`. Promoted capabilities are tracked locally and
globally, and become available to the proposer on the next iteration
only.

## Plugin SDK (preview)

Drop a file into `.darwin/plugins/echo.mjs`:

```js
export default {
  name: "echo",
  handlers: {
    pre_tool_use: (p) => console.error("[echo]", JSON.stringify(p)),
  },
};
```

Auto-loaded on the next hook invocation.

## Status

v1 work-in-progress. Hook event names have been verified against Codex 0.130.0 for the current hook surface; OMX support uses the same dispatcher/fallback surface. The current default meta loop is goal-mode; harness-mode remains available for compatibility. Node ≥ 20.
