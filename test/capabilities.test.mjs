import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { registerProjectForCwd } from "../dist/projects/registry.js";
import {
  discoverCapabilities,
  formatCapabilitiesForPrompt,
  promoteCapabilities,
  sha256File,
  validateCapabilityProposal,
} from "../dist/capabilities/manifest.js";

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("capability manifest promotes project-scoped skill and safe hook", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
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
            event: "PreToolUse",
            matcher: "Bash",
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

  const summary = promoteCapabilities(cwd, bundle, project, { home });
  assert.deepEqual(summary.skipped, []);
  assert.equal(summary.promoted.length, 2);

  const skillPath = join(cwd, ".agents", "skills", "task-helper", "SKILL.md");
  assert.equal(existsSync(skillPath), true);
  const skill = readFileSync(skillPath, "utf-8");
  assert.match(skill, /x-darwin-owned: true/);
  assert.match(skill, new RegExp(`x-darwin-project-id: ${project.project_id}`));

  const hooks = JSON.parse(readFileSync(join(cwd, ".codex", "hooks.json"), "utf-8"));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, "Bash");
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, "darwin-hook pre_tool_use");

  const localSkills = JSON.parse(
    readFileSync(join(cwd, ".darwin", "ownership", "skills.json"), "utf-8"),
  );
  assert.equal(localSkills.skills["task-helper"].project_id, project.project_id);

  const globalCaps = JSON.parse(
    readFileSync(join(home, "projects", project.project_id, "capabilities.json"), "utf-8"),
  );
  assert.equal(globalCaps.capabilities["skill:task-helper"].kind, "skill");
  assert.equal(globalCaps.capabilities["hook:PreToolUse"].kind, "hook");

  const discovered = discoverCapabilities(cwd, project);
  assert.equal(discovered.active.length, 2);
  assert.equal(discovered.stale.length, 0);

  writeFileSync(skillPath, skill + "\nmanual edit\n");
  const afterEdit = discoverCapabilities(cwd, project);
  assert.equal(afterEdit.active.length, 1);
  assert.equal(afterEdit.stale.length, 1);
  assert.equal(afterEdit.stale[0].reason, "hash mismatch");
});

test("capability promotion treats corrupt state JSON as empty", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-corrupt-caps-"));
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cap-corrupt-state-"));
  const project = registerProjectForCwd(cwd, home, "Corrupt State Project");
  const proposal = join(cwd, ".darwin", "proposals", "iter-1");

  write(join(cwd, ".darwin", "ownership", "skills.json"), "{not json");
  write(join(cwd, ".darwin", "ownership", "hooks.json"), JSON.stringify({ version: 1, hooks: [] }));
  write(join(cwd, ".codex", "hooks.json"), "{not json");
  write(
    join(home, "projects", project.project_id, "capabilities.json"),
    JSON.stringify({ version: 1, capabilities: [] }),
  );

  write(
    join(proposal, "capabilities", "skills", "state-helper", "SKILL.md"),
    `---\nname: state-helper\ndescription: Repairs corrupt state\n---\n# State helper\n`,
  );
  write(
    join(proposal, "capability-manifest.json"),
    JSON.stringify({
      version: 1,
      capabilities: [
        {
          kind: "skill",
          name: "state-helper",
          path: "capabilities/skills/state-helper/SKILL.md",
        },
        {
          kind: "hook",
          name: "stop-observer",
          event: "Stop",
          mode: "observe",
        },
      ],
    }),
  );

  const bundle = validateCapabilityProposal(cwd, proposal, project);
  const summary = promoteCapabilities(cwd, bundle, project, { home });
  assert.equal(summary.promoted.length, 2);

  const hooks = JSON.parse(readFileSync(join(cwd, ".codex", "hooks.json"), "utf-8"));
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, "darwin-hook stop");

  const discovered = discoverCapabilities(cwd, project);
  assert.equal(discovered.active.length, 2);
  assert.equal(discovered.stale.length, 0);
});

test("skill promotion refuses to overwrite user-owned project skills", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
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

test("capability prompt formatting keeps stored fields single-line and bounded", () => {
  const formatted = formatCapabilitiesForPrompt({
    active: [
      {
        kind: "skill",
        name: `helper\n${"x".repeat(1000)}`,
        capability_id: "cap-skill",
        project_id: "proj",
        path: `.agents/skills/helper/SKILL.md\n${"p".repeat(1000)}`,
        updated_at: "2026-05-19T00:00:00.000Z",
      },
      {
        kind: "hook",
        name: "hooky",
        capability_id: "cap-hook",
        project_id: "proj",
        event: "pre_tool_use",
        codex_event: "PreToolUse",
        matcher: "Bash",
        command: `darwin-hook pre_tool_use\n${"c".repeat(1000)}`,
        mode: "observe",
        updated_at: "2026-05-19T00:00:00.000Z",
      },
    ],
    stale: [
      {
        kind: "skill",
        name: "dirty",
        capability_id: "cap-dirty",
        project_id: "proj",
        reason: `hash mismatch\n${"r".repeat(1000)}`,
        updated_at: "2026-05-19T00:00:00.000Z",
      },
    ],
  });

  assert.match(formatted, /skill helper x+/);
  assert.match(formatted, /\.agents\/skills\/helper\/SKILL\.md p+/);
  assert.match(formatted, /PreToolUse matcher=Bash -> darwin-hook pre_tool_use c+/);
  assert.match(formatted, /hash mismatch r+/);
  assert.doesNotMatch(formatted, /helper\nx/);
  assert.doesNotMatch(formatted, /SKILL\.md\np/);
  assert.doesNotMatch(formatted, /pre_tool_use\nc/);
  assert.doesNotMatch(formatted, /mismatch\nr/);
  assert.doesNotMatch(formatted, /[^\x00-\x7F]/);
  assert.doesNotMatch(formatted, /x{180}|p{180}|c{180}|r{180}/);
});

test("capability prompt formatting caps active and stale entry counts", () => {
  const active = Array.from({ length: 4 }, (_, i) => ({
    kind: "skill",
    name: `skill-${i + 1}`,
    capability_id: `cap-${i + 1}`,
    project_id: "proj",
    path: `.agents/skills/skill-${i + 1}/SKILL.md`,
    updated_at: "2026-05-19T00:00:00.000Z",
  }));
  const stale = Array.from({ length: 3 }, (_, i) => ({
    kind: "skill",
    name: `dirty-${i + 1}`,
    capability_id: `dirty-${i + 1}`,
    project_id: "proj",
    reason: "hash mismatch",
    updated_at: "2026-05-19T00:00:00.000Z",
  }));

  const formatted = formatCapabilitiesForPrompt({ active, stale }, { limit: 2 });

  assert.match(formatted, /skill skill-1/);
  assert.match(formatted, /skill skill-2/);
  assert.doesNotMatch(formatted, /skill-3/);
  assert.match(formatted, /\.\.\. 2 more active capabilities omitted/);
  assert.match(formatted, /skill dirty-1: hash mismatch/);
  assert.match(formatted, /skill dirty-2: hash mismatch/);
  assert.doesNotMatch(formatted, /dirty-3/);
  assert.match(formatted, /\.\.\. 1 more stale capabilities omitted/);
});

test("discoverCapabilities can cap inspected project records", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cap-inspect-limit-"));
  const project = registerProjectForCwd(cwd, home, "Limited Project");
  const skills = {};

  try {
    for (let i = 1; i <= 3; i++) {
      const name = `skill-${i}`;
      const path = `.agents/skills/${name}/SKILL.md`;
      const content = `---\nname: ${name}\ndescription: helper ${i}\n---\n# Helper ${i}\n`;
      write(join(cwd, path), content);
      skills[name] = {
        kind: "skill",
        name,
        capability_id: `skill:${name}`,
        project_id: project.project_id,
        path,
        hash: sha256(content),
        updated_at: "2026-05-19T00:00:00.000Z",
      };
    }

    const otherProjectContent = "---\nname: ignored\ndescription: ignored\n---\n# Ignored\n";
    write(join(cwd, ".agents", "skills", "ignored", "SKILL.md"), otherProjectContent);
    skills.ignored = {
      kind: "skill",
      name: "ignored",
      capability_id: "skill:ignored",
      project_id: "other-project",
      path: ".agents/skills/ignored/SKILL.md",
      hash: sha256(otherProjectContent),
      updated_at: "2026-05-19T00:00:00.000Z",
    };

    write(
      join(cwd, ".darwin", "ownership", "skills.json"),
      JSON.stringify({ version: 1, skills }, null, 2),
    );

    const discovered = discoverCapabilities(cwd, project, { inspectLimit: 2 });
    assert.deepEqual(discovered.active.map((cap) => cap.name), ["skill-1", "skill-2"]);
    assert.equal(discovered.stale.length, 0);
    assert.equal(discovered.omitted, 1);

    const formatted = formatCapabilitiesForPrompt(discovered);
    assert.match(formatted, /1 capability record\(s\) not inspected in this summary/);
    assert.doesNotMatch(formatted, /skill-3/);
    assert.doesNotMatch(formatted, /ignored/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("sha256File hashes files without requiring string reads", () => {
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cap-hash-"));
  const path = join(cwd, "large-skill.md");
  const content = `---\nname: large\ndescription: large\n---\n${"x".repeat(200_000)}`;

  try {
    writeFileSync(path, content);
    assert.equal(sha256File(path), sha256(content));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("discoverCapabilities marks unreadable skill paths stale instead of throwing", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cap-unreadable-"));
  const project = registerProjectForCwd(cwd, home, "Unreadable Project");
  const proposal = join(cwd, ".darwin", "proposals", "iter-1");

  try {
    write(
      join(proposal, "capabilities", "skills", "task-helper", "SKILL.md"),
      `---\nname: task-helper\ndescription: Helps future iterations with this task\n---\n# Task helper\n`,
    );
    write(
      join(proposal, "capability-manifest.json"),
      JSON.stringify({
        version: 1,
        capabilities: [
          {
            kind: "skill",
            name: "task-helper",
            path: "capabilities/skills/task-helper/SKILL.md",
          },
        ],
      }),
    );

    const bundle = validateCapabilityProposal(cwd, proposal, project);
    promoteCapabilities(cwd, bundle, project, { home });

    const skillPath = join(cwd, ".agents", "skills", "task-helper", "SKILL.md");
    rmSync(skillPath, { force: true });
    mkdirSync(skillPath);

    const discovered = discoverCapabilities(cwd, project);
    assert.equal(discovered.active.length, 0);
    assert.equal(discovered.stale.length, 1);
    assert.match(discovered.stale[0].reason, /^hash read failed:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("capability validation errors keep manifest fields single-line and bounded", () => {
  const home = mkdtempSync(join(tmpdir(), "darwin-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "darwin-cap-validation-"));
  const project = registerProjectForCwd(cwd, home, "Validation Project");
  const proposal = join(cwd, ".darwin", "proposals", "iter-1");

  try {
    writeManifest(proposal, {
      version: 1,
      capabilities: [
        {
          kind: "skill",
          name: `Bad Skill\n${"n".repeat(1000)}`,
        },
      ],
    });
    assert.throws(
      () => validateCapabilityProposal(cwd, proposal, project),
      (err) => {
        assert.match(err.message, /^invalid capability name: Bad Skill n+/);
        assert.doesNotMatch(err.message, /Bad Skill\nn/);
        assert.doesNotMatch(err.message, /n{180}/);
        assert.ok(err.message.length <= "invalid capability name: ".length + 160);
        return true;
      },
    );

    writeManifest(proposal, {
      version: 1,
      capabilities: [
        {
          kind: "skill",
          name: "missing-skill",
          path: `capabilities/skills/missing-skill/SKILL.md\n${"p".repeat(1000)}`,
        },
      ],
    });
    assert.throws(
      () => validateCapabilityProposal(cwd, proposal, project),
      (err) => {
        assert.match(err.message, /missing file: capabilities\/skills\/missing-skill\/SKILL\.md p+/);
        assert.doesNotMatch(err.message, /SKILL\.md\np/);
        assert.doesNotMatch(err.message, /p{180}/);
        assert.ok(err.message.length <= "skill capability missing-skill missing file: ".length + 160);
        return true;
      },
    );

    writeManifest(proposal, {
      version: 1,
      capabilities: [
        {
          kind: "hook",
          name: "bad-hook",
          event: `bad event\n${"e".repeat(1000)}`,
        },
      ],
    });
    assert.throws(
      () => validateCapabilityProposal(cwd, proposal, project),
      (err) => {
        assert.match(err.message, /unsupported Codex hook event: bad event e+/);
        assert.doesNotMatch(err.message, /bad event\ne/);
        assert.doesNotMatch(err.message, /e{180}/);
        assert.ok(err.message.length <= "unsupported Codex hook event: ".length + 160 + " (expected known Codex hook event)".length);
        return true;
      },
    );

    writeManifest(proposal, {
      version: 1,
      capabilities: [
        {
          kind: "hook",
          name: "bad-mode",
          event: "stop",
          mode: `weird\n${"m".repeat(1000)}`,
        },
      ],
    });
    assert.throws(
      () => validateCapabilityProposal(cwd, proposal, project),
      (err) => {
        assert.match(err.message, /invalid mode: weird m+/);
        assert.doesNotMatch(err.message, /weird\nm/);
        assert.doesNotMatch(err.message, /m{180}/);
        assert.ok(err.message.length <= "hook capability bad-mode has invalid mode: ".length + 160);
        return true;
      },
    );

    writeManifest(proposal, {
      version: 1,
      capabilities: [
        {
          kind: "hook",
          name: "bad-matcher",
          event: "Stop",
          matcher: "Bash",
        },
      ],
    });
    assert.throws(
      () => validateCapabilityProposal(cwd, proposal, project),
      /uses matcher on an event where Codex ignores matchers/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

function writeManifest(proposal, manifest) {
  write(join(proposal, "capability-manifest.json"), JSON.stringify(manifest, null, 2));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
