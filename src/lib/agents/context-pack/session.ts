import { workspaceContext, withinWorkspace } from "@/lib/agents/command-centre/working-context";
import { buildContextPack, contextPackFingerprint, contextPackId, isContextPackId } from "./pack";
import { contextPackAttachedContext } from "./attach";
import type { AgentContextWorld } from "@/lib/agents/context/world";
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity";
import type { WorkingContext } from "@/lib/agents/command-centre/working-context";
import type { AgentControlEvent } from "@/lib/agents/control/events";
import type { SessionHandoff } from "@/lib/agents/handoff/handoff";
import type { RuntimeSessionView } from "@/lib/agents/runtime/protocol";
import type { ContextPack, ContextPackFile, ContextPackResult } from "./pack";
import type { ProjectDescriptor } from "@/lib/agents/project/describe";
import type { ContextDeliveryState } from "./present";

/**
 * A session's Context Pack (Hubble 1.5) — the one recipe for the pack a
 * session is sent and the pack the inspector shows, so the two are the same
 * by construction and comparing their ids is meaningful.
 *
 *   - **selection**: what the runtime says the session is pointed at (its
 *     focus), else the whole workspace — never what is merely ticked.
 *   - **recent changes**: agent changes in the workspace, minus the
 *     session's own (it made them, so it knows).
 *   - **previous result**: what the handoff that started the session passed.
 */
export function sessionContextPack(input: {
  world: AgentContextWorld;
  workspaceId: string;
  /** The session's selection; `null` or absent is the whole workspace. */
  selection?: WorkingContext | null;
  /** Absent for a session that does not exist yet. */
  sessionId?: string;
  changes?: readonly AppliedWorkspaceChange[];
  /** The ready handoff this session was started by, if any. */
  handoffFrom?: SessionHandoff;
  /** The person's latest words to the agent. Shown; never part of the fingerprint. */
  instruction?: string;
  /** The workspace's project, as the runtime found it (Hubble 1.6). */
  project?: ProjectDescriptor;
  /** Project files this work changed, as Hubble measured them (Hubble 1.6). */
  projectFiles?: readonly ContextPackFile[];
}): ContextPackResult {
  const selection = input.selection && input.selection.workspaceId === input.workspaceId ? input.selection : workspaceContext(input.workspaceId);
  const previousResult = input.handoffFrom?.context.previousResult;
  return buildContextPack({
    world: input.world,
    selection: withinWorkspace(selection, input.world).context,
    changes: input.changes ?? [],
    ...(input.sessionId ? { excludeChangesOf: input.sessionId } : {}),
    ...(previousResult ? { previousResult } : {}),
    files: [...(previousResult?.files ?? []), ...(input.projectFiles ?? [])],
    ...(input.project ? { project: input.project } : {}),
    ...(input.instruction ? { instruction: input.instruction } : {}),
  });
}

/** The handoff a session was started by, from the explicit records. */
export function handoffThatStarted(sessionId: string, handoffs: readonly SessionHandoff[] | undefined): SessionHandoff | undefined {
  return handoffs?.find((handoff) => handoff.targetSessionId === sessionId && handoff.status === "ready");
}

/**
 * The person's latest words to the agent: the last message they sent, else
 * the instruction of the handoff that started the session. Their own words,
 * shown back to them — never the agent's.
 */
export function latestInstruction(
  events: readonly Pick<AgentControlEvent, "kind" | "sessionId" | "summary" | "text" | "handoff">[],
  sessionId: string,
  handoffFrom?: SessionHandoff
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.sessionId !== sessionId || event.kind !== "message_sent") continue;
    // The message that delivered a handoff is Hubble's envelope, not the person's words.
    if (event.handoff) break;
    const words = (event.text ?? event.summary).trim();
    if (words) return words;
  }
  return handoffFrom?.instruction;
}

/**
 * Where the session's context stands against the pack it would be sent now.
 * `reads`: nothing attached and nothing to attach — the session reads its
 * workspace on request.
 */
export function contextDeliveryState(
  view: Pick<RuntimeSessionView, "contextSnapshotId" | "contextDelivered" | "focus">,
  pack: ContextPack
): ContextDeliveryState {
  const wouldAttach = contextPackAttachedContext(pack, 0) !== null;
  const attached = view.contextSnapshotId;
  if (!attached) {
    // A focus the runtime reports without a context id predates packs: it is what the agent has.
    if (view.focus) return view.focus.delivered ? "delivered" : "pending";
    return wouldAttach ? "changed" : "reads";
  }
  // Context attached before 1.5 was not a pack; it is what the agent has.
  if (!isContextPackId(attached)) return view.contextDelivered === false ? "pending" : "delivered";
  if (attached !== contextPackId(pack)) return "changed";
  return view.contextDelivered === false ? "pending" : "delivered";
}

/**
 * What changed between the pack an agent received and the current one, when
 * only the project did (Hubble 1.6): its Git state, or a file it names changed
 * outside the session. `undefined` when anything else changed too, or when the
 * delivered pack is not known here (another page built it) — then it is
 * simply "changed".
 */
export function contextChangeOf(delivered: ContextPack | undefined, current: ContextPack): "project" | undefined {
  if (!delivered || delivered.fingerprint === current.fingerprint) return undefined;
  const withoutProject = (pack: ContextPack) => {
    const body: Omit<ContextPack, "fingerprint"> & { fingerprint?: string } = {
      ...pack,
      // A file changed outside the session is project drift too.
      files: pack.files.filter((file) => !file.outside).map((file) => ({ path: file.path, change: file.change })),
    };
    delete body.project;
    delete body.fingerprint;
    return contextPackFingerprint(body);
  };
  return withoutProject(delivered) === withoutProject(current) ? "project" : undefined;
}
