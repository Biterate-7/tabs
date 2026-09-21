import { createUnimplementedControlAdapter } from "../unimplemented";
import type { AgentControlAdapter } from "../types";

/**
 * The Codex control seam.
 *
 * ## What this is in Phase B
 *
 * An unimplemented adapter, exactly like the Claude Code one — and unlike it,
 * Codex is not observable either. TabDump can currently say nothing at all
 * about Codex, and this is the file that says so.
 *
 * ## Why there is no mapping table here
 *
 * The Claude Code seam beside this one carries a detailed flag-by-flag plan,
 * because that CLI is installed on the development machine and every
 * mechanism in that table was checked against `--help` on the actual version.
 *
 * **Codex is not installed here.** Writing an equivalent table would mean
 * transcribing documentation into a plan, and a plan built from documentation
 * that was not verified is the same mistake as a connector built from a
 * guessed schema: it looks like progress and produces confident nonsense the
 * first time reality differs.
 *
 * `connectors/catalog.ts` already holds this line for the observation plane —
 * Codex, Gemini and Grok are registered, honest and capability-free because
 * their local formats have not been verified against a real installation.
 * The control plane keeps the same standard.
 *
 * ## What Phase D has to establish first
 *
 * Against a real installation, in this order:
 *
 *   1. Which integration surface actually exists on the installed version —
 *      an app-server protocol, an SDK, or a print-mode CLI.
 *   2. Whether a conversation persists across turns, and what identifies it.
 *      That decides whether `resumeSession` is implementable at all.
 *   3. Whether tool calls can be intercepted for a decision, or only
 *      pre-authorized by mode. That decides `approvals`, and it is the same
 *      question that made the Agent SDK a requirement for Claude Code.
 *   4. How working directory and additional directories are expressed.
 *   5. What the event stream emits, so it can be mapped to
 *      `AgentControlEvent` rather than a new event type being invented.
 *
 * Each answer turns into one declared capability. Anything unanswered stays
 * undeclared, and the adapter keeps refusing that operation.
 */

export const CODEX_CONTROL_DETAIL =
  "TabDump cannot reach Codex from this environment. The control boundary is in place; what is missing is a verified way to drive Codex locally.";

export function createCodexControlAdapter(): AgentControlAdapter {
  return createUnimplementedControlAdapter({
    provider: "openai-codex",
    detail: CODEX_CONTROL_DETAIL,
  });
}
