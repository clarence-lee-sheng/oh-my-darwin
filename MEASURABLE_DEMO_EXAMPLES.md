# Clear oh-my-darwin demo examples with measurable outcomes

Use these as menu options in the hackathon. Each demo has a visible before/after, a command to run, and a concrete metric.

## Demo 1 — Deterministic code repair loop (main live demo)

**Story:** Darwin turns a vague agent task into a scored improvement loop: baseline fails, one iteration repairs code, frontier improves.

**Setup:** `demo/tiny-js-repair/` has a seeded `.darwin/frontier.json` with score `0` and a tiny bug in `src/slugify.js`.

**Commands:**

```bash
cd demo/tiny-js-repair
npm test
node ../../dist/cli/index.js status
node ../../dist/cli/index.js --omx meta --iterations 1 --duration 8m
npm test
node ../../dist/cli/index.js status
cat .darwin/evolution.jsonl
```

**Measurable outcome:**

| Metric | Before | After target |
|---|---:|---:|
| `npm test` score | `score: 0` | `score: 1` |
| Frontier score | `0` | `1` |
| Evolution rows | `1` | `2` |
| Changed implementation files | `0` | `src/slugify.js` only |

**Differentiator shown:** generic agents “fix code”; Darwin records a scored frontier and durable evolution evidence.

---

## Demo 2 — Tamper-resistant scorer guard

**Story:** Darwin can use objective local scorers, and the scorer can make cheating visible.

**Commands:**

```bash
cd demo/tiny-js-repair
cp check.mjs /tmp/check.backup.mjs
printf '\n// tamper\n' >> check.mjs
npm test
mv /tmp/check.backup.mjs check.mjs
npm test
```

**Measurable outcome:**

| Metric | Tampered | Restored |
|---|---:|---:|
| Check hash validity | invalid | valid |
| Score | `0` | current fixture score, initially `0`; after real repair `1` |
| Scorer behavior | refuses edited check | runs checks normally |

**Differentiator shown:** Darwin’s loop can be grounded in trusted artifacts, not vibes or a human “looks good.”

---

## Demo 3 — Capability promotion safety

**Story:** Darwin can let the meta-loop create future project capabilities, but only through safe, validated paths.

**Command:**

```bash
npm test -- test/capabilities.test.mjs
```

**Measurable outcome:**

| Metric | Expected |
|---|---:|
| Skills promoted | `1` |
| Hooks promoted | `1` |
| User-owned skill overwrite attempts | rejected |
| Active capabilities after promotion | `2` |
| Stale capability detected after manual edit | `1` |
| Test result | pass |

**Differentiator shown:** unlike a prompt-only harness, Darwin can evolve the project’s agent environment through auditable, project-scoped skills/hooks.

---

## Demo 4 — Strategy templates as visible evolutionary policy

**Story:** Darwin is not one hard-coded loop. The harness can choose how to explore: greedy, tournament, novelty, or MAP-Elites.

**Commands:**

```bash
ls templates/strategies
sed -n '1,140p' templates/strategies/greedy.mjs
sed -n '1,180p' templates/strategies/map-elites.mjs
```

Optional live switch in any Darwin project:

```bash
cp templates/strategies/map-elites.mjs demo/tiny-js-repair/.darwin/harness/harness.mjs
cd demo/tiny-js-repair
node ../../dist/cli/index.js status
```

**Measurable outcome:**

| Strategy | Measured artifact |
|---|---|
| Greedy | frontier replaced only when score improves |
| Tournament | parent selection varies across scored attempts |
| Novelty | parent selection favors textually different goals |
| MAP-Elites | `.darwin/niches.json` records best attempt per `sandbox × model` niche |

**Differentiator shown:** Darwin exposes the optimization policy as code/artifacts instead of hiding it in a black-box agent runner.

---

## Demo 5 — Spec/scorer parser correctness

**Story:** A non-researcher can write a plain Markdown spec, and Darwin extracts a runnable scorer from it.

**Command:**

```bash
npm test -- test/spec-scorer.test.mjs
```

**Measurable outcome:**

| Metric | Expected |
|---|---:|
| Verification alias parsed as `test-suite` | pass |
| Command scorer infers from `command:` field | pass |
| Numeric command output parsed | `42` |
| Test-suite pass score | `1` |
| Test-suite fail score | `0` |
| LLM-judge fallback to human | does **not** happen |

**Differentiator shown:** Darwin has explicit scorer contracts and avoids silently turning automated evaluation into subjective human scoring.

---

## Demo 6 — Hook/event visibility

**Story:** Darwin records lifecycle evidence locally as JSONL, so the loop can use traces later.

**Commands:**

```bash
cd demo/tiny-js-repair
node ../../dist/cli/index.js setup
ls .codex/hooks.json
# After a Darwin/Codex/OMX run:
tail -20 .darwin/events.jsonl 2>/dev/null || echo 'events appear after an agent run'
```

**Measurable outcome:**

| Metric | Expected |
|---|---|
| Hook config installed | `.codex/hooks.json` exists |
| Event log path | `.darwin/events.jsonl` |
| Event format | JSONL records with `event` and timestamp |

**Differentiator shown:** Darwin has a local evidence bus; later iterations can learn from actual tool/run history.

---

## Demo 7 — Existing dataset analytics report (non-code main option)

**Story:** Darwin is not just for code repair. It can optimize a repeatable analytics/reporting workflow over a real public dataset.

**Dataset:** Palmer Penguins, 344 observations, CC0. Local copy: `demo/penguins-insights/data/penguins.csv`.

**Commands:**

```bash
cd demo/penguins-insights
npm test
node ../../dist/cli/index.js status
node ../../dist/cli/index.js --omx meta --iterations 1 --duration 8m
npm test
cat score-details.json
node ../../dist/cli/index.js status
cat .darwin/evolution.jsonl
```

**Measurable outcome:**

| Metric | Before | After target |
|---|---:|---:|
| Analytics completeness score | `0/10` | `10/10` |
| Frontier score | `0` | `10` |
| Required artifact | missing `insights.json` | valid `insights.json` |
| Exact dataset checks | `0` pass | `10` pass |

**The 10 checks:** row count, species counts, island counts, most common island, year range, missing measurement rows, highest mean body-mass species, longest mean-flipper species, mean body mass by species, and a concise executive summary mentioning all species.

**Differentiator shown:** Darwin can improve a non-code deliverable with an objective scorer, not just ask an LLM for a subjective report.

---

## More non-code dataset demo ideas

| Demo | Existing dataset | Output artifact | Metric | Why it is hackathon-safe |
|---|---|---|---|---|
| SMS triage | UCI SMS Spam Collection | `labels.csv` with ham/spam labels + rationales | accuracy %, precision/recall | Easy text classification; familiar business story |
| Iris data card | UCI Iris | `data_card.json` + short stakeholder memo | exact stats + schema score | Tiny, classic, no network during demo |
| Cars insight brief | Vega cars dataset | `brief.md` / `insights.json` | exact top/bottom stats + correlation tolerance | Business-style analytics with public example data |
| Support-ticket routing | Any labeled intent dataset subset, e.g. Banking77/CLINC style | routing CSV | top-1 accuracy | Shows operations automation, not coding |
| Product-review QA | Public reviews subset | issue taxonomy JSON | coverage of expected categories | Good product-manager demo; scorer checks taxonomy coverage |

Best non-code live option: **Palmer Penguins insights** because it is real, small, CC0, and the scorer can validate exact facts without an LLM judge.

# Recommended hackathon sequence

If you only have 5 minutes:

1. **Demo 7** if you want non-code: show `0/10 → 10/10` on a real dataset analytics report.
2. **Demo 1** if you want code repair: show `score: 0 → score: 1` and frontier update.
3. **Demo 3** — run the capability test and say “Darwin can safely evolve future agent context.”
4. **Demo 4** — show strategy templates and say “the loop policy itself is swappable.”

If the live agent stalls, still show measurable outcomes with:

```bash
npm test
npm test -- test/capabilities.test.mjs
npm test -- test/spec-scorer.test.mjs
(cd demo/penguins-insights && npm test; true)
(cd demo/tiny-js-repair && npm test; true)
cd demo/penguins-insights && node ../../dist/cli/index.js status
```

The dataset and code fixtures are expected to fail before repair/report creation; those `score: 0` failures are the visible baselines.
