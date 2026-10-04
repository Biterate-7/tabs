import { buildAgentActivityTimeline } from "@/lib/agents/activity/timeline";
import { focusFitsSnapshot, isEmptyFocus } from "@/lib/agents/session-context/focus";
import { agentDisplayName, handoffFingerprint, summarizePreviousResult, workspaceContextOf } from "./handoff";
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { SessionFocus } from "@/lib/agents/session-context/focus";
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot";
import type {
  RuntimeApprovalView,
  RuntimeHandoffPreview,
  RuntimePlanOutcomeView,
  RuntimeSessionView,
  SequencedControlEvent,
} from "@/lib/agents/runtime/protocol";
import type { SessionHandoff } from "./handoff";

/**
 * What a handoff from this session would pass (Hubble 1.4) — the one place it
 * is worked out. The runtime host calls it with its own journal, approvals
 * and the changes the Command Centre reported; the landing page's demo calls
 * it with its deterministic records. Same records in, same preview out.
 *
 *   - **Workspace context**: the snapshot's counts, and the source's focus
 *     only if it still names things in that snapshot.
 *   - **Previous result**: the source's own activity timeline — the builder
 *     Activity uses — reduced to its results.
 *
 * The caller decides beforehand whether a handoff may happen at all (whose
 * session, which workspace, which agent); this only describes it.
 */
export function prepareHandoffPreview(input: {
  session: RuntimeSessionView;
  workspaceId: string;
  events: readonly SequencedControlEvent[];
  knownApprovals?: ReadonlyMap<string, RuntimeApprovalView>;
  changes: readonly AppliedWorkspaceChange[];
  planOutcomes?: readonly RuntimePlanOutcomeView[];
  /** The copy of the source's workspace that would go to the target. Absent: no workspace context can be passed. */
  snapshot?: SessionContextSnapshot;
  focus?: SessionFocus;
  targetProvider: AgentProviderId;
  /** Whether the target can be handed Hubble's workspace tools. */
  contextTools: boolean;
  now: number;
}): { preview: RuntimeHandoffPreview; focus?: SessionFocus } {
  const { session, snapshot } = input;
  const focus =
    snapshot && input.focus && !isEmptyFocus(input.focus) && focusFitsSnapshot(snapshot, input.focus) ? input.focus : undefined;
  const entries = buildAgentActivityTimeline({
    session,
    events: input.events,
    ...(input.knownApprovals ? { knownApprovals: input.knownApprovals } : {}),
    changes: input.changes,
    ...(input.planOutcomes ? { planOutcomes: input.planOutcomes } : {}),
    agentName: agentDisplayName(session.provider),
    ...(snapshot ? { workspaceName: snapshot.workspace.name } : {}),
    now: input.now,
  });
  const context: SessionHandoff["context"] = {
    ...(snapshot ? { workspace: workspaceContextOf(snapshot, focus) } : {}),
    previousResult: summarizePreviousResult(entries, session.status),
  };
  const fingerprint = handoffFingerprint({
    sourceSessionId: session.sessionId,
    targetProvider: input.targetProvider,
    workspaceId: input.workspaceId,
    context,
    contextTools: input.contextTools,
  });
  return {
    preview: {
      sourceSessionId: session.sessionId,
      sourceProvider: session.provider,
      targetProvider: input.targetProvider,
      workspaceId: input.workspaceId,
      context,
      contextTools: input.contextTools,
      fingerprint,
    },
    ...(focus ? { focus } : {}),
  };
}
