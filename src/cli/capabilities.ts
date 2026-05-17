import { discoverCapabilities, formatCapabilitiesForPrompt } from "../capabilities/manifest.js";
import { resolveCurrentProject } from "../projects/registry.js";

export function capabilities(): void {
  const project = resolveCurrentProject();
  if (!project) {
    console.log("darwin: no project registered for this directory. Run `darwin init` first.");
    return;
  }
  console.log(`project: ${project.name} (${project.project_id})`);
  console.log(formatCapabilitiesForPrompt(discoverCapabilities(process.cwd(), project)));
}
