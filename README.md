# oh-my-darwin

The on-ramp to meta-harness for non-researchers. Turn "I have a task" into an iterative loop, without writing your own propose/evaluate/score machinery.

Built on top of OMX (`oh-my-codex`) and the Codex CLI. Darwin defaults to
`omx --madmax --xhigh` and falls back to Codex yolo mode
(`codex --dangerously-bypass-approvals-and-sandbox`) when OMX is not available. See `darwin_spec.md` for the full design rationale.

## Quick start

```bash
npm install
npm link        # exposes `darwin` and `darwin-hook` on PATH

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

## Commands today

- **`darwin`** — auto-installs `.codex/hooks.json` if missing, then launches the selected agent engine (`omx --madmax --xhigh` by default, fallback to `codex --dangerously-bypass-approvals-and-sandbox` if OMX cannot launch). Every lifecycle event is logged to `.darwin/events.jsonl`.
- **`darwin init`** — adaptive Socratic interview (via the selected engine) that produces `.darwin/meta-spec.md`: task, scorer, constraints, HITL pattern, optimization surface, stop condition. It also registers/chooses a project in `~/.darwin`.
- **`darwin projects`** / **`darwin list`** — list the global `~/.darwin` project registry.
- **`darwin baseline`** — reads the spec, launches the selected engine interactively with the task as the initial prompt, prompts you for a realized score on exit, writes `.darwin/frontier.json`, and appends to `.darwin/evolution.jsonl`.
- **`darwin meta`** — the loop. Each iteration proposes a candidate, executes it, scores the result, and updates the frontier using the active strategy hooks. Two execution modes:
  - **harness-mode (default)** — proposer writes a `harness.mjs` that transforms the task prompt; the selected engine runs the transformed prompt once per attempt. Proposals may include project-scoped Codex `SKILL.md` files and safe `.codex/hooks.json` entries that are auto-promoted for the next iteration.
  - **`darwin meta --goal-mode`** — proposer outputs `{goal, knobs, rationale}` JSON; each attempt sends `/goal <text>` to Codex and lets it run autonomously until quiet (no new tool activity for `--attempt-quiet 60s` after the last stop) or `--attempt-max 30m`. HITL prompt approves each proposed goal before it runs.
- **`darwin status`** — show current project, frontier, evolution count, recent attempts, and active/stale capabilities.
- **`darwin capabilities`** — show active/stale project-scoped skills/hooks.
- **`darwin setup`** — explicit (re)install of `.codex/hooks.json`.
- **`darwin-hook <event>`** — per-event handler invoked by the Codex/OMX hook surface; dispatches to the central event bus. Real hook events captured include `pre_tool_use`, `post_tool_use`, `session_start`, `user_prompt_submit`, and `stop`.

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

The active harness file (`.darwin/harness/harness.mjs`) is also where the
**evolutionary strategy** lives — selection, mutation guidance, acceptance,
and population update are all optional hooks on the same exported object.
Defaults reproduce darwin's greedy single-frontier behavior, so existing
harnesses still work unchanged.

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

`darwin meta` proposers may optionally write `.darwin/proposals/<attempt-id>/capabilities.json`:

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
      "event": "pre_tool_use",
      "command": "darwin-hook pre_tool_use",
      "mode": "observe"
    }
  ]
}
```

Skills must be Codex-compatible `SKILL.md` files and are promoted only
inside the project at `.agents/skills/<name>/SKILL.md`. Hooks are
auto-safe only when they call the stable `darwin-hook <event>`
dispatcher. Promoted capabilities are tracked locally and globally, and
become available to the proposer on the next iteration only.

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

v1 work-in-progress. Hook event names have been verified against Codex 0.130.0 for the current hook surface; OMX support uses the same dispatcher/fallback surface. Zero runtime deps; Node ≥ 20.
