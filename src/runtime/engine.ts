export type EngineName = "codex" | "omx";

export interface EngineSelection {
  engine: EngineName;
  args: string[];
  engineArgs: string[];
}

function parseEngineName(raw: string | undefined): EngineName {
  const value = (raw ?? process.env.DARWIN_ENGINE ?? "codex")
    .trim()
    .toLowerCase();

  if (value === "codex" || value === "omx") return value;

  throw new Error(
    `unsupported engine "${raw}". Expected "codex" or "omx".`,
  );
}

/**
 * Pull Darwin's engine selector out of an argv vector while leaving the
 * remaining tokens in their original order for subcommand/passthrough parsing.
 *
 * Supported forms:
 *   darwin --engine omx init
 *   darwin init --engine=omx
 *   darwin --omx --high
 *   DARWIN_ENGINE=omx darwin baseline
 */
export function extractEngineSelection(argv: string[]): EngineSelection {
  let explicitEngine: string | undefined;
  const engineArgs: string[] = process.env.DARWIN_ENGINE_ARGS
    ? splitArgs(process.env.DARWIN_ENGINE_ARGS)
    : [];
  const args: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--engine") {
      const value = argv[i + 1];
      if (!value) throw new Error("--engine requires a value: codex or omx");
      explicitEngine = value;
      i++;
      continue;
    }

    if (arg.startsWith("--engine=")) {
      explicitEngine = arg.slice("--engine=".length);
      continue;
    }

    if (arg === "--engine-arg") {
      const value = argv[i + 1];
      if (!value) throw new Error("--engine-arg requires a value");
      engineArgs.push(value);
      i++;
      continue;
    }

    if (arg.startsWith("--engine-arg=")) {
      engineArgs.push(arg.slice("--engine-arg=".length));
      continue;
    }

    if (arg === "--engine-args") {
      const value = argv[i + 1];
      if (!value) throw new Error("--engine-args requires a value");
      engineArgs.push(...splitArgs(value));
      i++;
      continue;
    }

    if (arg.startsWith("--engine-args=")) {
      engineArgs.push(...splitArgs(arg.slice("--engine-args=".length)));
      continue;
    }

    if (arg === "--omx") {
      explicitEngine = "omx";
      continue;
    }

    if (arg === "--codex") {
      explicitEngine = "codex";
      continue;
    }

    args.push(arg);
  }

  return { engine: parseEngineName(explicitEngine), args, engineArgs };
}

export function engineCommand(engine: EngineName): string {
  return engine;
}

export function engineLabel(engine: EngineName): string {
  return engine === "omx" ? "OMX" : "Codex";
}

export function engineExecLabel(engine: EngineName): string {
  return `${engineCommand(engine)} exec`;
}

export function formatEngineCommand(
  engine: EngineName,
  engineArgs: string[] = [],
): string {
  const parts = [engineCommand(engine), ...engineArgs];
  return parts.map(shellQuoteIfNeeded).join(" ");
}

/**
 * OMX can default to a detached tmux launch in interactive terminals. Darwin
 * needs child-process lifetime semantics for baseline/meta scoring, so default
 * OMX launches to direct mode unless the caller/user already selected a policy.
 * CLI flags such as `--tmux` still override this environment default inside OMX.
 */
export function engineEnv(engine: EngineName): NodeJS.ProcessEnv {
  if (engine !== "omx" || process.env.OMX_LAUNCH_POLICY) {
    return process.env;
  }

  return {
    ...process.env,
    OMX_LAUNCH_POLICY: "direct",
  };
}

function splitArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of raw) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) current += "\\";
  if (current.length > 0) args.push(current);
  return args;
}

function shellQuoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
