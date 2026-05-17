# oh-my-darwin

The on-ramp to meta-harness for non-researchers. Turn "I have a task" into an iterative loop, without writing your own propose/evaluate/score machinery.

Built on top of the Codex CLI. See `darwin_spec.md` for the full design rationale.

## Quick start

```bash
npm install
npm link        # exposes `darwin` and `darwin-hook` on PATH

cd ~/your/project
darwin init     # interview produces .darwin/meta-spec.md
darwin baseline # run task once, capture starting score
darwin meta     # iterative loop; may stage/promote safe project capabilities
```

## Commands today

- **`darwin`** — auto-installs `.codex/hooks.json` if missing, then launches Codex (passthrough args). Every Codex lifecycle event is logged to `.darwin/events.jsonl`.
- **`darwin init`** — adaptive Socratic interview (via Codex) that produces `.darwin/meta-spec.md`: task, scorer, constraints, HITL pattern, optimization surface, stop condition.
- **`darwin projects`** — list the global `~/.darwin` project registry.
- **`darwin baseline`** — reads the spec, launches Codex interactively with the task as the initial prompt, prompts you for a realized score on exit, writes `.darwin/frontier.json` and appends to `.darwin/evolution.jsonl`.
- **`darwin meta`** — propose → validate → execute → score → repeat. Proposals may include project-scoped Codex `SKILL.md` files and safe `.codex/hooks.json` entries that are auto-promoted for the next iteration.
- **`darwin status`** — show current project, frontier, evolution count, and active/stale capabilities.
- **`darwin capabilities`** — show active/stale project-scoped skills/hooks.
- **`darwin setup`** — explicit (re)install of `.codex/hooks.json`.
- **`darwin-hook <event>`** — per-event handler invoked by Codex's hook system; dispatches to the central event bus.

## File layout in a darwin-managed project

```
your-project/
├── .codex/hooks.json           # auto-installed; tells Codex to call darwin-hook
├── .agents/skills/*/SKILL.md   # project-scoped Codex skills owned by Darwin
└── .darwin/
    ├── project.json            # selected global ~/.darwin project id
    ├── meta-spec.md            # the spec (from `darwin init`)
    ├── frontier.json           # current best attempt
    ├── evolution.jsonl         # append-only history of all attempts
    ├── events.jsonl            # raw Codex lifecycle events
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

v1 work-in-progress. Hook capture event names (`pre_tool_use` etc.) are placeholders pending verification against Codex's actual hook docs. Zero runtime deps; Node ≥ 20.
