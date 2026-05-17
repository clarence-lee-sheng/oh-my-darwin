export type EngineName = "codex" | "omx";

export const DEFAULT_ENGINE: EngineName = "omx";
export const DEFAULT_OMX_ARGS = ["--madmax", "--xhigh"] as const;
export const DEFAULT_CODEX_ARGS = [
  "--dangerously-bypass-approvals-and-sandbox",
] as const;

export interface EngineSelection {
  engine: EngineName;
  args: string[];
  engineArgs: string[];
}

function parseEngineName(raw: string | undefined): EngineName {
  const value = (raw ?? process.env.DARWIN_ENGINE ?? DEFAULT_ENGINE)
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
 *   darwin --codex --sandbox read-only
 *   darwin --omx --high baseline
 *   DARWIN_ENGINE=omx darwin baseline
 *
 * If no engine is selected, Darwin defaults to `omx --madmax --xhigh`.
 * If OMX cannot be launched, call sites fall back to Codex's yolo-equivalent
 * `codex --dangerously-bypass-approvals-and-sandbox`.
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

export function defaultEngineArgs(engine: EngineName): string[] {
  return engine === "omx" ? [...DEFAULT_OMX_ARGS] : [...DEFAULT_CODEX_ARGS];
}

export function resolveEngineArgs(
  engine: EngineName,
  explicitArgs: string[] = [],
): string[] {
  return explicitArgs.length > 0 ? explicitArgs : defaultEngineArgs(engine);
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

/**
 * Args to run the selected engine in non-interactive exec mode. OMX's launch
 * shorthands (for example --madmax/--xhigh) are not valid after `omx exec`,
 * so translate the common defaults into Codex exec flags.
 */
export function engineExecArgs(
  engine: EngineName,
  engineArgs: string[],
  execArgs: string[] = [],
): string[] {
  const normalized = engine === "omx"
    ? omxLaunchArgsToCodexArgs(engineArgs)
    : engineArgs;
  return ["exec", ...normalized, ...execArgs];
}

/**
 * Args to run the selected engine interactively for `/goal` injection. OMX must
 * be direct (not detached tmux) so Darwin can observe process lifetime and feed
 * stdin, but otherwise keep launch-level OMX flags intact.
 */
export function engineInteractiveArgs(
  engine: EngineName,
  engineArgs: string[],
  interactiveArgs: string[] = [],
): string[] {
  if (engine !== "omx") return [...engineArgs, ...interactiveArgs];

  return ["--direct", ...stripOmxLaunchPolicyArgs(engineArgs), ...interactiveArgs];
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

export function fallbackEngine(engine: EngineName): EngineName | null {
  return engine === "omx" ? "codex" : null;
}

export function isEngineLaunchError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES";
}

export function fallbackNotice(
  engine: EngineName,
  fallback: EngineName,
  err: unknown,
): string {
  const code = err && typeof err === "object"
    ? (err as NodeJS.ErrnoException).code
    : undefined;
  const detail = code ? ` (${code})` : "";
  return `darwin: ${engineCommand(engine)} could not launch${detail}; falling back to ${formatEngineCommand(fallback, resolveEngineArgs(fallback))}\n`;
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

function omxLaunchArgsToCodexArgs(args: string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--madmax":
      case "--yolo":
        out.push("--dangerously-bypass-approvals-and-sandbox");
        continue;

      case "--madmax-spark":
        out.push("--dangerously-bypass-approvals-and-sandbox");
        continue;

      case "--xhigh":
        out.push("-c", 'model_reasoning_effort="xhigh"');
        continue;

      case "--high":
        out.push("-c", 'model_reasoning_effort="high"');
        continue;

      // OMX launch-only controls do not make sense for `omx exec`.
      case "--direct":
      case "--tmux":
      case "--detached-tmux":
      case "--spark":
      case "--notify-temp":
      case "--discord":
      case "--slack":
      case "--telegram":
        continue;

      case "--custom":
      case "-w":
      case "--worktree":
        i++; // skip value
        continue;

      default:
        if (arg.startsWith("--custom=") || arg.startsWith("--worktree=")) {
          continue;
        }
        out.push(arg);
    }
  }

  return out;
}

function stripOmxLaunchPolicyArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      arg === "--direct" ||
      arg === "--tmux" ||
      arg === "--detached-tmux" ||
      arg.startsWith("--launch-policy=")
    ) {
      continue;
    }
    if (arg === "--launch-policy") {
      i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function shellQuoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
