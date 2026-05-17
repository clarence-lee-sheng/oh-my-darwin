import { listProjects } from "../projects/registry.js";

export function projects(): void {
  const rows = listProjects();
  if (rows.length === 0) {
    console.log("darwin: no projects registered");
    return;
  }
  for (const p of rows) {
    console.log(`${p.project_id}\t${p.name}\t${p.root_path}`);
  }
}
