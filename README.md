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
- **`darwin init`** — adaptive Socratic interview (via the selected engine) that produces `.darwin/meta-spec.md`: task, scorer, constraints, HITL pattern, optimization surface, stop condition.
- **`darwin projects`** — list the global `~/.darwin` project registry.
- **`darwin baseline`** — reads the spec, launches the selected engine interactively with the task as the initial prompt, prompts you for a realized score on exit, writes `.darwin/frontier.json` and appends to `.darwin/evolution.jsonl`.
- **`darwin meta`** — propose → validate → execute → score → repeat. Proposals may include project-scoped Codex `SKILL.md` files and safe `.codex/hooks.json` entries that are auto-promoted for the next iteration.
- **`darwin status`** — show current project, frontier, evolution count, and active/stale capabilities.
- **`darwin capabilities`** — show active/stale project-scoped skills/hooks.
- **`darwin setup`** — explicit (re)install of `.codex/hooks.json`.
- **`darwin-hook <event>`** — per-event handler invoked by the Codex/OMX hook surface; dispatches to the central event bus.

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
    ├── evolution.jsonl         # append-only history of all attempts
    ├── events.jsonl            # raw agent lifecycle events
    ├── ownership/*.json        # Darwin-owned skills/hooks metadata
    ├── proposals/<attempt-id>/ # staged harness + optional capability manifest
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

## Capability manifests

`darwin meta` proposers may optionally write:

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

v1 work-in-progress. Hook capture event names (`pre_tool_use` etc.) are placeholders pending verification against Codex/OMX hook behavior. Zero runtime deps; Node ≥ 20.
