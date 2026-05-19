import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import {
  findProjectByExactRoot,
  loadRegistry,
  registerProjectForCwd,
  readLocalProject,
  saveRegistry,
} from "../dist/projects/registry.js";
import {
  formatProjectSelectionMenu,
  formatProjectSelectionOption,
  selectProjectForInit,
} from "../dist/projects/selection.js";

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

test("project registry readers treat missing or corrupt JSON as empty", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-corrupt-"));
  const cwd = mkdtempSync(join(tmpdir(), "darwin-project-corrupt-"));

  assert.deepEqual(loadRegistry(home), { version: 1, projects: [] });
  assert.equal(readLocalProject(cwd), null);

  writeFileSync(join(home, "projects.json"), "{not json");
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "project.json"), "{not json");

  assert.deepEqual(loadRegistry(home), { version: 1, projects: [] });
  assert.equal(readLocalProject(cwd), null);

  writeFileSync(join(home, "projects.json"), JSON.stringify({ version: 1, projects: "bad" }));
  writeFileSync(join(cwd, ".darwin", "project.json"), JSON.stringify({ project_id: "proj_missing_root" }));

  assert.deepEqual(loadRegistry(home), { version: 1, projects: [] });
  assert.equal(readLocalProject(cwd), null);
});

test("project registry readers filter malformed project records", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-malformed-"));
  const cwd = mkdtempSync(join(tmpdir(), "darwin-project-malformed-"));
  const legacyCwd = mkdtempSync(join(tmpdir(), "darwin-project-legacy-"));
  const validProject = {
    project_id: "proj_valid",
    name: "Valid",
    root_path: cwd,
    created_at: "2026-05-19T00:00:00.000Z",
    last_used_at: "2026-05-19T00:00:00.000Z",
  };
  const legacyProject = {
    project_id: "proj_legacy",
    root_path: legacyCwd,
  };

  writeFileSync(join(home, "projects.json"), JSON.stringify({
    version: 1,
    projects: [
      null,
      "bad",
      { ...validProject, project_id: "" },
      { ...validProject, root_path: 42 },
      legacyProject,
      validProject,
    ],
  }));
  mkdirSync(join(cwd, ".darwin"), { recursive: true });
  writeFileSync(join(cwd, ".darwin", "project.json"), JSON.stringify({
    ...validProject,
    root_path: 42,
  }));

  assert.deepEqual(loadRegistry(home), {
    version: 1,
    projects: [
      {
        project_id: legacyProject.project_id,
        name: basename(legacyCwd),
        root_path: legacyCwd,
        created_at: "",
        last_used_at: "",
      },
      validProject,
    ],
  });
  assert.equal(findProjectByExactRoot(cwd, home)?.project_id, validProject.project_id);
  assert.equal(readLocalProject(cwd), null);
});

test("project registry stays independent from CLI display", () => {
  const source = readFileSync(new URL("../src/projects/registry.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\.\.\/cli\/display\.js/);
  assert.doesNotMatch(source, /\bwriteCli(?:Error|Output)\b/);
});

test("selectProjectForInit keeps existing-project messages single-line and bounded", async () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "darwin-project-"));
  const project = {
    project_id: `proj-dirty\n${"p".repeat(180)}`,
    name: `Existing Project\n${"n".repeat(500)}`,
    root_path: cwd,
    created_at: "2026-05-19T00:00:00.000Z",
    last_used_at: "2026-05-19T00:00:00.000Z",
  };
  saveRegistry({ version: 1, projects: [project] }, home);

  const { value, stderr } = await captureStderr(() => selectProjectForInit(cwd, home));

  assert.equal(value.project_id, project.project_id);
  assert.match(stderr, /using existing project Existing Project n+\.\.\. \(proj-dirty p+\.\.\.\)/);
  assert.doesNotMatch(stderr, /Existing Project\nn/);
  assert.doesNotMatch(stderr, /proj-dirty\np/);
  assert.doesNotMatch(stderr, /n{300}|p{170}/);
});

test("project selection menu rows are single-line, bounded, and ASCII", () => {
  const row = formatProjectSelectionOption(
    {
      project_id: `proj-menu\n${"p".repeat(500)}`,
      name: `Menu Project\n${"n".repeat(500)}`,
      root_path: `/tmp/menu-root\n${"r".repeat(500)}`,
      created_at: "2026-05-19T00:00:00.000Z",
      last_used_at: "2026-05-19T00:00:00.000Z",
    },
    2,
  );

  assert.match(row, /^  3\) Menu Project n+\.\.\. - \/tmp\/menu-root r+\.\.\. \(proj-menu p+\.\.\.\)\n$/);
  assert.doesNotMatch(row, /[^\x00-\x7F]/);
  assert.doesNotMatch(row, /Menu Project\nn|menu-root\nr|proj-menu\np/);
  assert.doesNotMatch(row, /n{300}|r{300}|p{300}/);
});

test("project selection menu is batched without blank rows between projects", () => {
  const menu = formatProjectSelectionMenu([
    {
      project_id: "proj_one",
      name: "One",
      root_path: "/tmp/one",
      created_at: "2026-05-19T00:00:00.000Z",
      last_used_at: "2026-05-19T00:00:00.000Z",
    },
    {
      project_id: "proj_two",
      name: "Two",
      root_path: "/tmp/two",
      created_at: "2026-05-19T00:00:00.000Z",
      last_used_at: "2026-05-19T00:00:00.000Z",
    },
  ]);

  assert.match(menu, /^\ndarwin: no project registered/);
  assert.match(menu, /  n\) create new project \(default\)\n  1\) One - \/tmp\/one \(proj_one\)\n  2\) Two - \/tmp\/two \(proj_two\)\n$/);
  assert.doesNotMatch(menu, /proj_one\)\n\n  2\)/);
});

async function captureStderr(fn) {
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk, encodingOrCallback, callback) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (typeof encodingOrCallback === "function") encodingOrCallback();
    if (typeof callback === "function") callback();
    return true;
  };
  try {
    return { value: await fn(), stderr };
  } finally {
    process.stderr.write = originalWrite;
  }
}
