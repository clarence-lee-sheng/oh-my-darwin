# oh-my-darwin meta-spec — penguins-insights-demo

## Task
Analyze `data/penguins.csv` from the Palmer Penguins dataset and produce a non-code executive analytics artifact at `insights.json`. The artifact must contain exact dataset facts and a concise plain-English summary. Do not modify `data/penguins.csv`, `score.mjs`, `package.json`, or `.darwin/*`.

Required `insights.json` fields:
- `row_count`
- `species_counts`
- `island_counts`
- `most_common_island`
- `year_range`
- `missing_measurement_rows`
- `species_with_highest_mean_body_mass`
- `species_with_longest_mean_flipper`
- `mean_body_mass_g_by_species`
- `executive_summary`

## Scorer
- name: penguins insight completeness
- direction: higher_is_better
- source: test-suite
- threshold_good: 8
- threshold_done: 10
- command: npm test

## Constraints
- HARD: Local-only; no network, package installs, credentials, or external services.
- HARD: The deliverable is an analytics JSON/report, not application code.
- HARD: Do not edit the dataset or scorer files.
- SOFT: Use concise language suitable for a hackathon judge or product stakeholder.

## HITL
- pattern: autonomous
- BEFORE: None for harness-mode demo; the dataset/scorer are preapproved.
- DURING: Stop if the agent tries to install packages, fetch data, or edit the scorer/dataset.
- AFTER: Human verifies with `npm test`, `score-details.json`, `darwin status`, and `.darwin/evolution.jsonl`.

## Surface
- The proposer may vary prompt/harness text only.
- The executor should create or update `insights.json` only.
- No project-scoped skills/hooks are needed for this fixture.

## Capabilities
- skills: disallowed for the live analytics fixture
- hooks: disallowed for the live analytics fixture
- agents: disallowed
- promotion: not needed in this fixture

## Stop condition
Stop when score reaches 10 or after one live iteration during the hackathon demo.

## Hypothesis going in
A small real-world dataset with an exact scorer demonstrates oh-my-darwin beyond code repair: it can optimize repeatable analytics/reporting workflows with measurable quality.
