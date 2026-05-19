import { listProjects } from "../projects/registry.js";
import { formatCliField, writeCliOutput } from "./display.js";

export function projects(): void {
  const rows = listProjects();
  if (rows.length === 0) {
    writeCliOutput("darwin: no projects registered");
    return;
  }
  writeCliOutput(rows.map((p) =>
    `${formatCliField(p.project_id)}\t${formatCliField(p.name)}\t${formatCliField(p.root_path)}`,
  ).join("\n"));
}
