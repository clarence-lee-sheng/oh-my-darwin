import { formatErrorSummary } from "../runtime/diagnostics.js";

export type ProposerRunner = "exec" | "interactive";

export function resolveProposerRunner(
  explicit?: ProposerRunner,
  rawRunner = process.env.DARWIN_PROPOSER_RUNNER,
): ProposerRunner {
  const raw = explicit ?? rawRunner;
  if (!raw) return "interactive";
  if (raw === "exec" || raw === "interactive") return raw;
  throw new Error(
    `invalid proposer runner "${formatErrorSummary(raw)}" (expected exec or interactive)`,
  );
}
