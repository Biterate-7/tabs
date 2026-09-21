import { createUnimplementedControlAdapter } from "../../unimplemented";
import type { AgentControlAdapter } from "../../types";

/**
 * What the shipped catalogue registers for Claude Code control.
 *
 * ## Why this is its own module rather than part of ./index.ts
 *
 * `connectors/catalog.ts` is evaluated in the **browser**, and it is the only
 * thing that needs the seam. Importing it from the barrel would drag in
 * `./adapter`, `./normalize` and `./permissions` behind it — the entire
 * driving implementation — for a browser that must never drive anything.
 *
 * That is dead weight in the bundle, and it quietly undermines the claim this
 * file exists to make: the code that can run an agent should not be in the
 * page that cannot. A separate module keeps the import graph honest.
 *
 * ## Why the seam declares nothing
 *
 * A browser cannot spawn a Claude Code process and must not be able to. So
 * the registration is a truthful "not drivable from here": no capabilities,
 * every operation refused, no code path that emits an event.
 *
 * That is not a placeholder standing in for missing work — it stays true
 * after Phase C. Driving Claude Code requires a Node context that has passed
 * the runtime boundary, and the browser is never that context.
 *
 * The real adapter is built by a caller that already has a server context;
 * see ./index.ts for how.
 */
export const CLAUDE_CODE_CONTROL_DETAIL =
  "Claude Code runs on your machine. TabDump can drive it from a local server, not from this page.";

export function createClaudeCodeControlSeam(): AgentControlAdapter {
  return createUnimplementedControlAdapter({
    provider: "claude-code",
    detail: CLAUDE_CODE_CONTROL_DETAIL,
  });
}
