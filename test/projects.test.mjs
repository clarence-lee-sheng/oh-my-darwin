import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findProjectByExactRoot,
  loadRegistry,
  registerProjectForCwd,
  readLocalProject,
} from "../dist/projects/registry.js";

test("project registry uses stable ids and exact root_path matching", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "darwin-project-"));
  const subdir = join(cwd, "src");
  mkdirSync(subdir);

  const project = registerProjectForCwd(cwd, home, "Example Project");

  assert.match(project.project_id, /^proj_/);
  assert.equal(project.name, "Example Project");
  assert.equal(project.root_path, cwd);

  assert.equal(findProjectByExactRoot(cwd, home)?.project_id, project.project_id);
  assert.equal(findProjectByExactRoot(subdir, home), null);

  const registry = loadRegistry(home);
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].project_id, project.project_id);

  const local = readLocalProject(cwd);
  assert.equal(local?.project_id, project.project_id);

  const globalProject = JSON.parse(
    readFileSync(join(home, "projects", project.project_id, "project.json"), "utf-8"),
  );
  assert.equal(globalProject.project_id, project.project_id);
});
