/**
 * JSON Schema for the per-turn envelope returned by the interviewer.
 * Passed to `codex exec --output-schema <file>` so Codex enforces the
 * shape — no scraping, no markers, no brittle parsing.
 */
export const ENVELOPE_SCHEMA = {
  type: "object",
  // OpenAI structured outputs require every property listed in `required`.
  // Model returns empty string / empty array for fields it has nothing to say.
  required: [
    "next_question",
    "ambiguity",
    "spec_draft",
    "done",
    "reasoning",
    "safety_notes",
  ],
  additionalProperties: false,
  properties: {
    next_question: {
      type: "string",
      description:
        "The one question to ask the user next. Empty string if done is true.",
    },
    ambiguity: {
      type: "object",
      required: ["task", "scorer", "constraints", "hitl", "surface", "stop"],
      additionalProperties: false,
      properties: {
        task: { type: "number", minimum: 0, maximum: 1 },
        scorer: { type: "number", minimum: 0, maximum: 1 },
        constraints: { type: "number", minimum: 0, maximum: 1 },
        hitl: { type: "number", minimum: 0, maximum: 1 },
        surface: { type: "number", minimum: 0, maximum: 1 },
        stop: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    spec_draft: {
      type: "string",
      description:
        "Full markdown of the meta-spec.md as understood so far. Replaced each turn.",
    },
    done: {
      type: "boolean",
      description:
        "True when the spec is complete enough to finalize. Set when ambiguity is low or user has signaled completion.",
    },
    reasoning: {
      type: "string",
      description: "Brief internal note on why this question was chosen.",
    },
    safety_notes: {
      type: "array",
      items: { type: "string" },
      description:
        "Concerns to flag before any execution: real money, identity actions, irreversible side effects. Empty if none.",
    },
  },
} as const;

export interface Envelope {
  next_question: string;
  ambiguity: {
    task: number;
    scorer: number;
    constraints: number;
    hitl: number;
    surface: number;
    stop: number;
  };
  spec_draft: string;
  done: boolean;
  reasoning?: string;
  safety_notes?: string[];
}

export function meanAmbiguity(a: Envelope["ambiguity"]): number {
  const vals = [a.task, a.scorer, a.constraints, a.hitl, a.surface, a.stop];
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
