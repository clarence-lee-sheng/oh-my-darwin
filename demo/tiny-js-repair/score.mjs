import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const EXPECTED_CHECK_SHA256 = "e4840d6659199c1cf80caeb8412b603a73aa826a6af8ce2d0396f8a8c8c604ea";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

let score = 0;
if (sha256("check.mjs") !== EXPECTED_CHECK_SHA256) {
  console.error("check.mjs changed; this demo scores zero if the verification target is edited");
} else {
  const result = spawnSync(process.execPath, ["check.mjs"], { stdio: "inherit" });
  score = result.status === 0 ? 1 : 0;
}

console.log(`score: ${score}`);
process.exit(score === 1 ? 0 : 1);
