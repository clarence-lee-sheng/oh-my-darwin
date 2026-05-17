import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENVELOPE_SCHEMA, type Envelope } from "./schema.js";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Single round-trip to the interviewer: serialize the conversation,
 * spawn `codex exec` with the JSON Schema enforced on its output,
 * read the resulting envelope, clean up.
 */
export async function callInterviewer(
  systemPrompt: string,
  history: Turn[],
): Promise<Envelope> {
  const dir = mkdtempSync(join(tmpdir(), "hyp-init-"));
  const schemaPath = join(dir, "schema.json");
  const outPath = join(dir, "out.txt");
  writeFileSync(schemaPath, JSON.stringify(ENVELOPE_SCHEMA));

  const convo = history
    .map((h) => `### ${h.role.toUpperCase()}\n${h.content}`)
    .join("\n\n");
  const fullPrompt = `${systemPrompt}\n\n## Conversation so far\n\n${convo}\n\n## Your turn\n\nReturn the JSON envelope now.`;

  return new Promise<Envelope>((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "exec",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outPath,
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        fullPrompt,
      ],
      // Swallow stdout (Codex echoes the prompt + status banner there);
      // we only care about the file at outPath. Capture stderr so a
      // non-zero exit can surface a meaningful message instead of a
      // bare exit code.
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("exit", (code) => {
      try {
        if (code !== 0) {
          const tail = stderrBuf.trim().slice(-800);
          throw new Error(
            `codex exec exited with code ${code}${tail ? `\n${tail}` : ""}`,
          );
        }
        const raw = readFileSync(outPath, "utf-8").trim();
        if (!raw) throw new Error("codex exec produced empty output");
        const env = JSON.parse(stripCodeFences(raw)) as Envelope;
        resolve(env);
      } catch (e) {
        reject(e);
      } finally {
        cleanup();
      }
    });

    function cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
}

/** Defensive: even with --output-schema, models sometimes wrap in ```json. */
function stripCodeFences(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s;
}
