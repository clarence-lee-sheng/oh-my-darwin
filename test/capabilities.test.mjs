import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { registerProjectForCwd } from "../dist/projects/registry.js";
import {
  discoverCapabilities,
  promoteCapabilities,
  validateCapabilityProposal,
} from "../dist/capabilities/manifest.js";

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("capability manifest promotes project-scoped skill and safe hook", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
  process.env.DARWIN_HOME = home;
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cap-project-"));
  const project = registerProjectForCwd(cwd, home, "Cap Project");
  const proposal = join(cwd, ".darwin", "proposals", "iter-1");

  write(
    join(proposal, "capabilities", "skills", "task-helper", "SKILL.md"),
    `---\nname: task-helper\ndescription: Helps future iterations with this task\n---\n# Task helper\n\nUse project facts.\n`,
  );
  write(
    join(proposal, "capability-manifest.json"),
    JSON.stringify(
      {
        version: 1,
        capabilities: [
          {
            kind: "skill",
            name: "task-helper",
            path: "capabilities/skills/task-helper/SKILL.md",
          },
          {
            kind: "hook",
            name: "pretool-guard",
            event: "pre_tool_use",
            command: "darwin-hook pre_tool_use",
            mode: "block_or_allow",
          },
        ],
      },
      null,
      2,
    ),
  );

  const bundle = validateCapabilityProposal(cwd, proposal, project);
  assert.equal(bundle.skills.length, 1);
  assert.equal(bundle.hooks.length, 1);

  const summary = promoteCapabilities(cwd, bundle, project);
  assert.deepEqual(summary.skipped, []);
  assert.equal(summary.promoted.length, 2);

  const skillPath = join(cwd, ".agents", "skills", "task-helper", "SKILL.md");
  assert.equal(existsSync(skillPath), true);
  const skill = readFileSync(skillPath, "utf-8");
  assert.match(skill, /x-darwin-owned: true/);
  assert.match(skill, new RegExp(`x-darwin-project-id: ${project.project_id}`));

  const hooks = JSON.parse(readFileSync(join(cwd, ".codex", "hooks.json"), "utf-8"));
  assert.equal(hooks.pre_tool_use, "darwin-hook pre_tool_use");

  const localSkills = JSON.parse(
    readFileSync(join(cwd, ".darwin", "ownership", "skills.json"), "utf-8"),
  );
  assert.equal(localSkills.skills["task-helper"].project_id, project.project_id);

  const globalCaps = JSON.parse(
    readFileSync(join(home, "projects", project.project_id, "capabilities.json"), "utf-8"),
  );
  assert.equal(globalCaps.capabilities["skill:task-helper"].kind, "skill");
  assert.equal(globalCaps.capabilities["hook:pre_tool_use"].kind, "hook");

  const discovered = discoverCapabilities(cwd, project);
  assert.equal(discovered.active.length, 2);
  assert.equal(discovered.stale.length, 0);

  writeFileSync(skillPath, skill + "\nmanual edit\n");
  const afterEdit = discoverCapabilities(cwd, project);
  assert.equal(afterEdit.active.length, 1);
  assert.equal(afterEdit.stale.length, 1);
  assert.equal(afterEdit.stale[0].reason, "hash mismatch");
});

test("skill promotion refuses to overwrite user-owned project skills", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
  process.env.DARWIN_HOME = home;
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cap-project-"));
  const project = registerProjectForCwd(cwd, home, "Protected Project");
  const proposal = join(cwd, ".darwin", "proposals", "iter-1");

  write(
    join(cwd, ".agents", "skills", "existing", "SKILL.md"),
    `---\nname: existing\ndescription: User authored\n---\n# Existing\n`,
  );
  write(
    join(proposal, "capabilities", "skills", "existing", "SKILL.md"),
    `---\nname: existing\ndescription: Darwin proposal\n---\n# Existing\n`,
  );
  write(
    join(proposal, "capability-manifest.json"),
    JSON.stringify({
      version: 1,
      capabilities: [
        {
          kind: "skill",
          name: "existing",
          path: "capabilities/skills/existing/SKILL.md",
        },
      ],
    }),
  );

  assert.throws(
    () => validateCapabilityProposal(cwd, proposal, project),
    /refusing to overwrite user-owned project skill/,
  );
});
