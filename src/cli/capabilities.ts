import { resolveCurrentProject } from "../projects/registry.js";
import { formatCliField, writeCliOutput } from "./display.js";

export async function capabilities(): Promise<void> {
  const project = resolveCurrentProject();
  if (!project) {
    writeCliOutput("darwin: no project registered for this directory. Run `darwin init` first.");
    return;
  }
  const {
    DEFAULT_CAPABILITY_OUTPUT_LIMIT,
    discoverCapabilities,
    formatCapabilitiesForPrompt,
  } = await import("../capabilities/manifest.js");
  writeCliOutput([
    `project: ${formatCliField(project.name)} (${formatCliField(project.project_id)})`,
    formatCapabilitiesForPrompt(
      discoverCapabilities(process.cwd(), project, { inspectLimit: DEFAULT_CAPABILITY_OUTPUT_LIMIT }),
    ),
  ].join("\n"));
}
