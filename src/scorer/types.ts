export interface ScoreResult {
  /** Numeric score, or null if not produced (skipped, parse failure, etc.). */
  score: number | null;
  /** Optional one-line note attached to the evolution row. */
  note?: string;
}
