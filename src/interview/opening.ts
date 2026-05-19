import type { Envelope } from "./schema.js";

const UNKNOWN = "<unknown>";

/**
 * Cheap local first turn for `darwin init`.
 *
 * The adaptive interviewer still handles the real Socratic loop after the
 * user's first answer, but asking the initial task question locally avoids
 * spending a full agent round-trip before Darwin says anything useful.
 */
export function createOpeningEnvelope(): Envelope {
  return {
    next_question: "What concrete task should Darwin iterate on?",
    ambiguity: {
      task: 0.9,
      scorer: 0.9,
      constraints: 0.9,
      hitl: 0.9,
      surface: 0.9,
      stop: 0.9,
    },
    spec_draft: openingSpecDraft(),
    done: false,
    reasoning:
      "Fast local opener: collect the user's task before invoking the adaptive interviewer.",
    safety_notes: [],
  };
}

function openingSpecDraft(): string {
  return `# oh-my-darwin meta-spec - draft

## Task
The first user answer has not been captured yet.

Task: ${UNKNOWN}
Success criteria: ${UNKNOWN}

## Scorer
- name: ${UNKNOWN}
- direction: ${UNKNOWN}
- source: ${UNKNOWN}
- threshold_good: ${UNKNOWN}
- threshold_done: ${UNKNOWN}

## Constraints
- HARD: ${UNKNOWN}
- SOFT: ${UNKNOWN}

## HITL
- pattern: ${UNKNOWN}
- BEFORE: ${UNKNOWN}
- DURING: ${UNKNOWN}
- AFTER: ${UNKNOWN}

## Surface
- ${UNKNOWN}

## Capabilities
- skills: ${UNKNOWN}
- hooks: ${UNKNOWN}
- agents: disallowed
- promotion: auto-promote validated Darwin-owned skills/hooks; available next iteration

## Stop condition
${UNKNOWN}

## Hypothesis going in
${UNKNOWN}
`;
}
