import type { ApprovalAction } from "./approvals";
import type { AgentPermissionScope } from "./permissions";
import type { AgentControlAdapter } from "./types";

/**
 * The broker's action vocabulary, re-exported.
 *
 * An adapter has to name what it wants approval for, and the vocabulary for
 * that is the broker's. But a provider adapter may not import the broker's
 * module - `security.test.ts` fails the build if one does, because an adapter
 * with a route to the broker is an adapter that could mint an approval
 * already granted.
 *
 * Re-exporting the *type* here is what lets an adapter speak the vocabulary
 * without acquiring the route. It is a type and erases at compile time, so
 * there is nothing at runtime to reach; the guard stays exactly as strict as
 * it was, and this module is the one place that holds both halves.
 */
export type { ApprovalAction };

/**
 * What an adapter knows about an approval it has raised.
 *
 * ## Why this is not a member of `AgentControlAdapter`
 *
 * The generic contract stays free of anything an adapter might not have. An
 * adapter whose provider cannot pause on a permission decision - and there is
 * at least one - has nothing to report here, and forcing it to declare a
 * method that always returns `undefined` would make "does this provider do
 * approvals" a question you answer by calling something and looking at what
 * comes back, rather than by reading its capability set.
 *
 * So this is a *structural* accessor, checked before it is used, in exactly
 * the shape the Claude adapter already established for its own detail type.
 * What this module adds is the provider-neutral version, so the control
 * service can collect the detail without importing a provider - which it must
 * not do, and which `security.test.ts` fails the build over.
 *
 * ## Why the detail is not on the event
 *
 * `AgentControlEvent` deliberately has nowhere to put a target list or a
 * reason: it carries identity and already-safe labels and nothing that could
 * hold a payload. The broker's record is where an approval's substance lives,
 * and this is the narrow, typed channel the service uses to fill one in.
 */
export type AdapterApprovalDetails = {
  sessionId: string;
  /** The control run this concerns, when the session has one. */
  runId?: string;
  /**
   * What the agent wants to do, in the broker's closed vocabulary.
   *
   * Optional, and absent is meaningful rather than missing: it is what an
   * adapter reports for an action whose scope needs no per-use approval at
   * all. See `requiresApproval` in ./permissions.ts - a read inside an
   * already-granted project is authorized by the grant, and manufacturing an
   * action for it would produce a dialog that teaches people to click yes.
   */
  action?: ApprovalAction;
  scope: AgentPermissionScope;
  /** Absent when the session has no project, which is itself a reason to refuse. */
  projectId?: string;
  /** Project-relative paths, or a tool label for an action with no path. Never absolute. */
  targets: readonly string[];
  reason?: string;
};

/** An adapter that can be asked about a pending approval. */
export type ApprovalDetailAdapter = AgentControlAdapter & {
  takeApprovalDetails(approvalId: string): AdapterApprovalDetails | undefined;
};

/** Whether this adapter carries the accessor. */
export function hasAdapterApprovalDetails(
  adapter: AgentControlAdapter
): adapter is ApprovalDetailAdapter {
  return typeof (adapter as Partial<ApprovalDetailAdapter>).takeApprovalDetails === "function";
}

/** Reads the detail behind a pending approval, or `undefined` when there is none to read. */
export function readAdapterApprovalDetails(
  adapter: AgentControlAdapter,
  approvalId: string
): AdapterApprovalDetails | undefined {
  if (!hasAdapterApprovalDetails(adapter)) return undefined;
  return adapter.takeApprovalDetails(approvalId);
}
