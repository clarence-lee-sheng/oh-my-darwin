import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverCapabilities, formatCapabilitiesForPrompt } from "../capabilities/manifest.js";
import { DARWIN_DIR, EVOLUTION_FILE } from "./constants.js";
import { resolveCurrentProject } from "../projects/registry.js";
import { readFrontier } from "../state/frontier.js";

export function status(): void {
  const cwd = process.cwd();
  const project = resolveCurrentProject(cwd);
  if (project) {
    console.log(`project: ${project.name} (${project.project_id})`);
    console.log(`root_path: ${project.root_path}`);
  } else {
    console.log("project: (unregistered; run `darwin init`)");
  }

  const frontier = readFrontier(cwd);
  if (frontier) {
    console.log(`frontier: ${frontier.attempt_id} score=${frontier.score ?? "null"}`);
  } else {
    console.log("frontier: (none)");
  }

  const evolutionPath = join(cwd, DARWIN_DIR, EVOLUTION_FILE);
  if (existsSync(evolutionPath)) {
    const count = readFileSync(evolutionPath, "utf-8").split("\n").filter(Boolean).length;
    console.log(`evolution_rows: ${count}`);
  } else {
    console.log("evolution_rows: 0");
  }

  console.log("\ncapabilities:");
  console.log(formatCapabilitiesForPrompt(discoverCapabilities(cwd, project)));
}
