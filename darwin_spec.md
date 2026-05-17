# oh-my-darwin — Spec

## One-sentence framing

**oh-my-darwin lets anyone set up a meta-harness loop for their specific task without having to design the loop themselves.**

The Stanford meta-harness pattern (propose harness variant → validate → evaluate → keep frontier → repeat) is powerful but inaccessible — using it today requires writing `meta_harness.py` from scratch, designing a benchmark, and wiring an evaluator. oh-my-darwin's product is the **on-ramp**: a guided interview turns "I have a task" into a runnable meta-loop spec, then a small set of commands drives the loop and surfaces progress.

oh-my-darwin is built as a wrapper around **OMX (`oh-my-codex`)** and the **Codex CLI**, structurally inspired by `oh-my-codex` (hook bridge, dispatcher, plugin SDK). The default execution engine is `omx --madmax --xhigh`, with automatic fallback to plain `codex` when OMX cannot launch; oh-my-darwin is the on-ramp and the loop driver on top.

## Who uses this and why

A user with a specific task they wish an LLM could do well, who:

- Doesn't want to babysit prompts forever to make it work
- Isn't going to read the meta-harness paper or write the loop themselves
- Will type `darwin init` if it promises to set the whole thing up

Personas include indie hackers running recurring tasks, researchers wanting to apply meta-harness to their benchmark without reimplementing, power users hitting Codex's ceiling, and domain experts whose tasks Codex/OMX *almost* solves reliably.

## Two example tasks that anchor the design

The interview and loop must handle both gracefully. If they only fit one, the abstraction is overfit.

### Project A — `earn-5-dollars/`

```
Task:        Make money. Budget $5. Time limit 1h wall-clock.
Scorer:      Human-confirmed net dollars settled in account X.
Constraints: HARD - no crypto/gambling/identity signup/ToS violations.
             HARD - kill at 60min; pause if spend > $3 of $5.
HITL:        Approve strategy before run; pause mid-run on spend trigger;
             user reports realized outcome.
Surface:     Strategy + system prompt + tool set + approval cadence.
```

### Project B — `autoresearch-fusion/`

```
Task:        2000-word brief on whether magnetic mirror confinement is a
             viable path to net-positive fusion.
Scorer:      LLM-judge rubric (factual accuracy, source diversity,
             reasoning, calibration of uncertainty).
Constraints: HARD - every claim source-cited; URLs must resolve.
             SOFT - prefer primary literature.
HITL:        None during iterations. User picks final artifact from
             `artifacts/iter-N.md`.
Surface:     Search strategy + synthesis structure + depth/breadth +
             uncertainty expression.
```

These two are deliberately far apart: real-world side effects vs. pure information work, human-in-loop vs. autonomous, dollar-scored vs. rubric-scored. They define the required generality of `meta-spec.md`, the interviewer, and the loop driver.

## Multi-project model

Per-project state, no global anything (except an optional registry).

```
/any/project/.darwin/
├── meta-spec.md          # human-readable spec produced by `darwin init`
├── frontier.json         # current best attempt + score + lineage
├── evolution.jsonl       # append-only history of every attempt
├── events.jsonl          # raw lifecycle events (built-in observer)
├── strategies/           # proposer outputs (Phase 1 plans, when applicable)
├── runs/<run-id>/        # per-execution trajectories, artifacts, receipts
├── plugins/              # opt-in user/community plugins (rarely needed)
└── (agent hook config lives in sibling .codex/hooks.json)

~/.darwin/
└── projects.json         # optional convenience index; rebuildable from FS
```

Rules:

- **Atomic unit is the task.** One task per project directory. Two tasks in one repo? Make two directories or use `.darwin/tasks/<id>/`.
- **Walk-up resolution.** `darwin <cmd>` finds the nearest `.darwin/` walking up from `cwd`. (Mirrors `git`.)
- **No global state with privacy implications.** Cross-project insight is opt-in only, deferred to v2+.
- **Everything is plain-text.** Markdown + JSON + JSONL. `git add .darwin/` works. No daemon, no database.

## What oh-my-darwin will implement (build sequence)

Five new commands, in priority order. Each ships independently useful behavior.

### 1. `darwin init` — the interviewer  *(first deliverable, ~70% of product value)*

Conducts an **adaptive Socratic interview** (Ouroboros-inspired) that produces `.darwin/meta-spec.md`. Uses the selected engine — `omx --madmax --xhigh` by default, `codex` on fallback or explicit request — to dogfood the bridge.

**Behavior:**

1. Scan the project (cwd): list files, read README, `package.json`/`pyproject.toml`, last 10 git commits if a repo. Pass as context to the interviewer.
2. Spawn the selected engine with the interviewer system prompt + brownfield context.
3. Conduct an adaptive interview across these dimensions, until each is "clear enough":
   - **Task** — what does the user want done; what does success concretely look like?
   - **Scorer** — how does an iteration get a number? Human-reported / command-output-parsed / LLM-judge / test-pass.
   - **Constraints** — hard limits (budget, time, off-limits behaviors) vs. soft preferences.
   - **HITL pattern** — when (if ever) is the user pulled into the loop?
   - **Surface** — what is the proposer allowed to change between iterations?
   - **Stop condition** — score threshold, iteration cap, or both.
4. Interviewer writes/updates `.darwin/meta-spec.md` incrementally; finalizes when ambiguity is acceptable or user types "done."
5. End with a safety reflection: "Is this safe to execute as described?" — model flags concerns; user resolves before any execution command runs.

**Deliberately not built:** a fixed question list. The interview is adaptive; a canned script would mangle either the earn task (needs budget/ToS questions) or the research task (needs rubric/source questions).

### 2. `darwin baseline` — run the spec once with default config

Executes the task as-described, with no proposer in play. Records:
- Trajectory under `runs/baseline/`
- Outcome in `frontier.json` as initial frontier
- One row in `evolution.jsonl`

If the scorer is human-reported, prompts the user at end of run.

### 3. `darwin meta` (or `darwin meta`) — drive the loop

Single command that orchestrates the full propose → validate → execute → score → record cycle. For each iteration:

1. Read `frontier.json` + recent `evolution.jsonl` + tail of `events.jsonl`.
2. Build proposer prompt (slots: metric, frontier, history, hypothesis-ask).
3. Invoke proposer harness (selected engine initially) — outputs one candidate manifest to `.darwin/proposals/<name>.json`.
4. Validate manifest (schema; respects spec constraints).
5. **If HITL pattern includes pre-execution approval:** show user the proposal; wait for approval/edit/reject.
6. Execute the candidate against the task. Enforce hard constraints (budget kill, time kill).
7. Score the outcome via the spec-declared scorer.
8. Append full row to `evolution.jsonl`; if score beats frontier, atomically replace `frontier.json`.

Stops on: score-threshold hit, iteration cap, user `^C`, or proposer recycling identical proposals.

### 4. `darwin status` — visibility surface

Prints: current frontier (score + lineage), last N attempts with deltas, what's queued, total resources consumed (time, tokens, dollars where applicable). Read-only.

Supports `--project <path>` to inspect any project without `cd`.

### 5. `darwin list` — multi-project index

Lists known projects from `~/.darwin/projects.json` (lazily updated on `init`/`run`). Shows path, task one-liner, last activity. Regeneratable by `darwin list --rescan ~/`.

## Architecture (already built, unchanged)

The wrapping mechanism is identical to what we already have. Five new commands plug into the same substrate.

```
oh-my-darwin/
├── package.json                  # bin: darwin, darwin-hook
├── tsconfig.json
├── README.md
├── darwin_spec.md              # this file
├── templates/
│   └── hooks.json                # copied into user's .codex/ on first run
└── src/
    ├── cli/
    │   ├── index.ts              # entry: routes subcommands
    │   ├── setup.ts              # ensureHooks() + setup()
    │   ├── run.ts                # passthrough launch of selected engine
    │   ├── hook.ts               # invoked by .codex/hooks.json
    │   ├── constants.ts
    │   ├── init.ts               # NEW — Socratic interviewer
    │   ├── baseline.ts           # NEW — one-shot baseline run
    │   ├── meta.ts               # NEW — the loop driver
    │   ├── status.ts             # NEW — read-only visibility
    │   └── list.ts               # NEW — multi-project index
    ├── runtime/
    │   ├── bridge.ts             # spawn selected engine; today inherit-stdio
    │   └── run-loop.ts           # lifecycle owner; emits events
    ├── hooks/extensibility/
    │   ├── dispatcher.ts         # single fan-out; built-in JSONL observer
    │   ├── loader.ts             # .darwin/plugins/*.mjs discovery
    │   └── sdk.ts                # plugin SDK types
    ├── spec/                     # NEW — meta-spec read/write/validate
    │   ├── schema.ts             # parsed shape of meta-spec.md
    │   ├── parse.ts              # markdown ↔ structured representation
    │   └── safety.ts             # constraint enforcement helpers
    ├── interview/                # NEW — interviewer prompt + scoring
    │   ├── prompt.ts             # the system prompt template
    │   ├── ambiguity.ts          # ambiguity scoring across dimensions
    │   └── brownfield.ts         # project scanning for context
    ├── proposer/                 # NEW — meta-loop proposer
    │   ├── prompt.ts             # proposer prompt template
    │   └── parse.ts              # extract candidate manifest from output
    ├── scorer/                   # NEW — pluggable scorer adapters
    │   ├── human.ts              # human-reported number
    │   ├── command.ts            # parse output of a shell command
    │   ├── llm-judge.ts          # rubric-based LLM scoring
    │   └── test-suite.ts         # pass-rate from npm test / pytest / etc.
    └── state/                    # NEW — frontier + history I/O
        ├── frontier.ts
        ├── history.ts
        ├── registry.ts           # ~/.darwin/projects.json
        └── paths.ts              # walk-up cwd resolution
```

Roughly 25 new files. The existing 8 are unchanged. Total ~33 files for the full v1.

## Spec file format (`meta-spec.md`)

Markdown with structured sections. Human writes/edits freely; parser extracts structured fields where needed.

Required sections:

- `# oh-my-darwin meta-spec — <slug>`
- `## Task` — prose description + concrete success criterion
- `## Scorer` — fields: `name`, `direction` (higher/lower), `source` (human|command|llm-judge|test-suite), `threshold_good`, `threshold_done`, plus type-specific fields
- `## Constraints` — `HARD:` / `SOFT:` prefixed bullets
- `## HITL` — `BEFORE`/`DURING`/`AFTER` checkpoints
- `## Surface` — bullet list of what proposer can vary
- `## Hypothesis going in` — user's initial guess, captured for later comparison

Optional:

- `## Stop condition`
- `## Open questions`

The parser is permissive: missing optional sections are fine, extra prose is ignored, the file remains human-readable at all times.

## Interview vs. proposer — what each is evaluated on

A separation that's easy to muddy and load-bearing to keep clear:

| Component       | Role         | Runs when      | Fitness signal                 | Inputs              | Output             |
|-----------------|--------------|----------------|--------------------------------|---------------------|--------------------|
| **Interview** (`darwin init`) | Scoping infrastructure | Once per project | None — it's not optimized inside the loop | User answers + brownfield scan | `meta-spec.md`     |
| **Proposer** (`darwin meta`)  | Optimization driver    | Each iteration   | The **task's** scalar score (per `meta-spec.md`) | Spec + frontier + evolution log + raw traces | Candidate file     |

The interview is *upstream* of the meta-loop. It produces the spec; the loop consumes it. The proposer never sees how the spec was produced and has no opinion about interview quality — it operates on whatever spec exists on disk.

This means three things in practice:

1. **The interview is optional.** A user who knows what they want can write `meta-spec.md` by hand and skip `darwin init` entirely. Same for editing a generated spec — the loop just reads what's on disk.
2. **The proposer's fitness signal is the task, not the spec.** When `darwin meta` scores a candidate, it asks "did this attempt do better at the task?" — never "did the interview produce a better spec?" Those are different optimization problems with different time horizons.
3. **Self-modification of the interview is a separate concern, deferred.** Improving the interview requires a fitness signal like "do the produced specs lead to successful meta-loops?" — measurable only after running complete loops on multiple tasks. Different cycle length, different infrastructure, out of scope for v1's self-mod design.

When this spec talks about "self-modifying darwin" or "meta-fitness," the *target is the proposer and its surrounding machinery* (`src/proposer/`, `src/scorer/`, candidate schema, validation), not the interview (`src/interview/`). The interview is treated as fixed scoping infrastructure unless and until a separate effort with its own fitness story is built.

## Loop invariants (enforced, not aspirational)

These are the rules the system must hold regardless of task:

1. **Spec is the source of truth.** Every loop decision (what to propose, what to execute, what to score, when to stop) reads from `meta-spec.md` or its derived state.
2. **The proposer is evaluated on the task, never on the spec.** Fitness comes from the scorer declared in the spec, applied to candidate execution outputs. Spec quality is upstream and not part of the loop's measurement.
3. **HARD constraints are enforced by oh-my-darwin, not by the proposer's good intentions.** Budget kills, time kills, off-limits-action checks happen in the runtime, not in prompt text.
4. **No execution without HITL approval if the spec declares it.** Skipping HITL is a bug, not an optimization.
5. **Frontier is updated atomically.** Crash during write must not corrupt; use temp-file + rename.
6. **Evolution log is append-only.** Failed proposals, rejected candidates, and aborted runs all get a row.
7. **One scalar per scorer.** A scorer returning a tuple is a configuration error.
8. **Every event flows through the dispatcher.** No `console.log` bypassing the event bus.

## What we are deliberately NOT building (v1)

To stay scoped:

- No tmux panes, no HUD, no visual dashboards
- No MCP server, no persistent shared memory across sessions
- No multi-agent teams (parallel agent sessions coordinating)
- No skill DSL, prompt library, or workflow templates
- No multi-harness adapters beyond Codex and OMX launch selection (Claude Code etc. remain out of scope)
- No plugin marketplace, no community plugin catalog
- No cross-project intelligence (each project is isolated)
- No team mode, no auth, no cloud
- No code-generation by the proposer (Option D from earlier discussion: proposer composes existing knobs, doesn't write code)
- No self-modification of the interview. The interview is fixed scoping infrastructure; improving it requires a separate fitness story (does the produced spec lead to successful loops?) with a much longer feedback cycle than task-level meta-loops. Deferred.

Some of these are good v2 candidates. None are needed for the on-ramp value prop.

## Build order (concrete)

| # | Deliverable                          | Why this order                                                 |
|---|--------------------------------------|----------------------------------------------------------------|
| 1 | `src/spec/` + `meta-spec.md` schema  | Both `init` and the loop need to read/write this; define first |
| 2 | `src/interview/` + `cli/init.ts`     | The 70% command. Test on both example tasks before moving on   |
| 3 | `src/scorer/` adapters (all 4)       | Needed before any execution can record a score                 |
| 4 | `src/state/` (frontier, history, registry) | Loop has nowhere to write without these                  |
| 5 | `cli/baseline.ts`                    | Smallest path to "I ran my task end-to-end"                    |
| 6 | `src/proposer/`                      | Generates candidates; cheap to add once spec exists            |
| 7 | `cli/meta.ts` (the loop driver)      | Composes proposer + scorer + state                             |
| 8 | `cli/status.ts`, `cli/list.ts`       | Visibility; useful after loop is running                       |

Each step is independently shippable. After step 2, the user can produce a meta-spec for any task. After step 5, they can run it once. After step 7, the loop iterates. After step 8, multi-project becomes ergonomic.

## Validation criteria (per deliverable)

The build is "done enough to move on" when:

- **Step 2:** running `darwin init` on both example tasks produces a `meta-spec.md` that a stranger could read and understand the task in under two minutes.
- **Step 5:** `darwin baseline` on the research task produces a real brief; `darwin baseline` on the earn task at minimum proposes a strategy and asks for approval before doing anything irreversible.
- **Step 7:** running `darwin meta --iterations 3` on the research task produces three distinct attempts with measurable score progression (or honest "no improvement" rows).
- **Step 8:** `darwin list` finds both projects; `darwin status --project <path>` works without `cd`.

## Open questions (resolve during build)

- Real Codex/OMX hook event names — verify `pre_tool_use` / `post_tool_use` / `on_stop` against actual docs before relying on them in `events.jsonl`.
- Whether to switch `runtime/bridge.ts` from `stdio: "inherit"` to piped IO (needed for plugin-based steering; not needed for the v1 on-ramp).
- Where the proposer harness lives long-term. v1 uses the selected Codex/OMX engine (already wired). Some tasks may benefit from Claude Code as proposer with Codex/OMX as executor; defer until felt.
- Whether `meta-spec.md` should be immutable after first creation (Ouroboros style) or freely editable (oh-my-darwin default). Leaning editable for the on-ramp audience.
- Budget tracking for tasks that spend real money: relies on user honesty in v1 (they report spend); proper integration with Stripe/etc. is v2+.
