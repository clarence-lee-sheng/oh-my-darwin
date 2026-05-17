/**
 * Public surface for plugin authors. Imported as:
 *   import type { DarwinPlugin } from "oh-my-darwin/sdk";
 */

export type LifecycleEvent =
  | "run_start"
  | "run_end"
  | "pre_tool_use"
  | "post_tool_use"
  | "permission_request"
  | "pre_compact"
  | "post_compact"
  | "session_start"
  | "user_prompt_submit"
  | "stop"
  | "on_stop"
  | (string & {}); // open set; Codex/OMX may add more

export type HookPayload = Record<string, unknown>;

export type HookHandler = (payload: HookPayload) => void | Promise<void>;

export interface DarwinPlugin {
  name: string;
  handlers: Partial<Record<LifecycleEvent, HookHandler>>;
}

export function definePlugin(p: DarwinPlugin): DarwinPlugin {
  return p;
}
