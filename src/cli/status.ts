import { resolveCurrentProject } from "../projects/registry.js";
import { readFrontier } from "../state/frontier.js";
import { readEvolutionSummary, type EvolutionRow } from "../state/history.js";
import { formatCliField, writeCliOutput } from "./display.js";

export async function status(): Promise<void> {
  const cwd = process.cwd();
  const project = resolveCurrentProject(cwd);
  const lines: string[] = [];
  if (project) {
    lines.push(
      `project: ${formatCliField(project.name)} (${formatCliField(project.project_id)})`,
    );
    lines.push(`root_path: ${formatCliField(project.root_path)}`);
  } else {
    lines.push("project: (unregistered; run `darwin init`)");
  }

  const frontier = readFrontier(cwd);
  if (frontier) {
    lines.push(
      `frontier: ${formatCliField(frontier.attempt_id)} score=${frontier.score ?? "null"}`,
    );
  } else {
    lines.push("frontier: (none)");
  }

  const evolution = readEvolutionSummary(cwd, 5);
  lines.push(`evolution_rows: ${evolution.rowCount}`);
  lines.push("", "recent_attempts:");
  lines.push(formatRecentAttempts(evolution.recent));
  lines.push("", "capabilities:");
  if (!project) {
    lines.push("(none)");
    writeCliOutput(lines.join("\n"));
    return;
  }

  const {
    DEFAULT_CAPABILITY_OUTPUT_LIMIT,
    discoverCapabilities,
    formatCapabilitiesForPrompt,
  } = await import("../capabilities/manifest.js");
  lines.push(formatCapabilitiesForPrompt(
    discoverCapabilities(cwd, project, { inspectLimit: DEFAULT_CAPABILITY_OUTPUT_LIMIT }),
  ));
  writeCliOutput(lines.join("\n"));
}

function formatRecentAttempts(rows: EvolutionRow[]): string {
  if (rows.length === 0) return "(none)";
  return rows.map((row) => {
    const score = row.score === null ? "score=null" : `score=${row.score}`;
    const parts = [formatCliField(row.attempt_id), formatCliField(row.outcome), score];
    if (typeof row.delta === "number") parts.push(`delta=${formatSigned(row.delta)}`);
    if (row.exit_reason) parts.push(`exit=${formatCliField(row.exit_reason)}`);
    return `- ${parts.join(" ")}`;
  }).join("\n");
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
