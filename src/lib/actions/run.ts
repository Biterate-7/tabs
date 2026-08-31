import { ACTIONS } from "./registry";
import type { ActionDispatchResult } from "./types";
import type { WorkspaceStore } from "@/lib/workspace/types";

/**
 * The single entry point Auto-Organize's apply step is routed through (see
 * src/lib/organize/apply.ts) — dispatches a named, pre-validated mutation
 * against `store` without the caller needing to know each action's own
 * validate/run shape.
 */
export function runAction(name: string, rawArgs: unknown, store: WorkspaceStore): ActionDispatchResult {
  const action = ACTIONS[name];
  if (!action) {
    return { ok: false, name, message: `Unknown action "${name}".` };
  }

  const validated = action.validate(rawArgs);
  if (!validated.ok) {
    return { ok: false, name, message: validated.message };
  }

  const result = action.run(store, validated.args);
  if (!result.ok) {
    return { ok: false, name, message: result.message };
  }

  return { ok: true, name, args: validated.args, data: result.data, store: result.store ?? store };
}
