import { resolve } from "node:path";
import { writeCliError, writeCliOutput } from "../cli/display.js";
import { formatErrorSummary } from "../runtime/diagnostics.js";
import {
  darwinHome,
  type DarwinProject,
  findProjectByExactRoot,
  loadRegistry,
  registerProjectForCwd,
  upsertProject,
  writeLocalProject,
} from "./registry.js";

/**
 * `darwin init` project selection:
 * - exact root_path match is auto-selected;
 * - otherwise, interactive users may choose an existing project or create one;
 * - non-interactive users get a new project for cwd.
 *
 * Selecting an existing project intentionally re-points its root_path to cwd.
 */
export async function selectProjectForInit(
  cwd: string = process.cwd(),
  home: string = darwinHome(),
): Promise<DarwinProject> {
  const exact = findProjectByExactRoot(cwd, home);
  if (exact) {
    const selected = upsertProject(exact, home);
    writeLocalProject(cwd, selected);
    writeCliError(
      `darwin: using existing project ${formatProjectSelectionField(selected.name)} (${formatProjectSelectionField(selected.project_id)})`,
    );
    return selected;
  }

  const registry = loadRegistry(home);
  if (!process.stdin.isTTY || registry.projects.length === 0) {
    const created = registerProjectForCwd(cwd, home);
    writeCliError(
      `darwin: registered new project ${formatProjectSelectionField(created.name)} (${formatProjectSelectionField(created.project_id)})`,
    );
    return created;
  }

  writeCliOutput(formatProjectSelectionMenu(registry.projects));

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = (await rl.question("> ")).trim().toLowerCase();
    const choice = Number(raw);
    if (Number.isInteger(choice) && choice >= 1 && choice <= registry.projects.length) {
      const selected = {
        ...registry.projects[choice - 1],
        root_path: resolve(cwd),
      };
      const saved = upsertProject(selected, home);
      writeLocalProject(cwd, saved);
      writeCliError(
        `darwin: attached existing project ${formatProjectSelectionField(saved.name)} (${formatProjectSelectionField(saved.project_id)}) to ${formatProjectSelectionField(saved.root_path)}`,
      );
      return saved;
    }
  } finally {
    rl.close();
  }

  const created = registerProjectForCwd(cwd, home);
  writeCliError(
    `darwin: registered new project ${formatProjectSelectionField(created.name)} (${formatProjectSelectionField(created.project_id)})`,
  );
  return created;
}

function formatProjectSelectionField(value: unknown): string {
  return formatErrorSummary(value);
}

export function formatProjectSelectionOption(
  project: DarwinProject,
  index: number,
): string {
  return `  ${index + 1}) ${formatProjectSelectionField(project.name)} - ${formatProjectSelectionField(project.root_path)} (${formatProjectSelectionField(project.project_id)})\n`;
}

export function formatProjectSelectionMenu(projects: DarwinProject[]): string {
  return `\ndarwin: no project registered for this exact root_path.
Choose an existing project to attach here, or create a new one:
  n) create new project (default)
${projects.map(formatProjectSelectionOption).join("")}`;
}
