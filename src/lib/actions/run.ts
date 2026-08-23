import { ACTIONS } from "./registry";
import type { ActionDispatchResult, ActionRunContext } from "./types";
import type { WorkspaceStore } from "@/lib/workspace/types";

/**
 * The single entry point Gemini's tool calls are routed through. This is
 * the whole point of the action layer: Gemini only ever gets a `name` +
 * loosely-typed `args` in, and a plain JSON-serializable result out — it
 * never sees or holds a reference to the store itself. `ctx` is likewise
 * never Gemini-controlled — see ActionRunContext.
 */
export function runAction(name: string, rawArgs: unknown, store: WorkspaceStore, ctx?: ActionRunContext): ActionDispatchResult {
  const action = ACTIONS[name];
  if (!action) {
    return { ok: false, name, message: `Unknown action "${name}".` };
  }

  const validated = action.validate(rawArgs);
  if (!validated.ok) {
    return { ok: false, name, message: validated.message };
  }

  const result = action.run(store, validated.args, ctx);
  if (!result.ok) {
    return { ok: false, name, message: result.message };
  }

  return { ok: true, name, args: validated.args, data: result.data, store: result.store ?? store };
}
