import { MAX_DELIVERY_COLLECTION_IDS } from "@/lib/agents/control/events";
import type { AgentAttachedContext } from "@/lib/agents/control/context";
import type { AgentControlEvent, ControlContextDeliveryInfo } from "@/lib/agents/control/events";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { SessionHandoff } from "@/lib/agents/handoff/handoff";
import type { RuntimeSessionView } from "@/lib/agents/runtime/protocol";

/**
 * Context provenance (Hubble 1.5): for one action, what Hubble had given the
 * agent by the time it acted — "why did the agent know this?".
 *
 *     Context used
 *     Research workspace · Workspace brief
 *     Pricing Research collection · 5 tabs
 *     Previous result from Gemini CLI · 2 files
 *     Read the workspace 3 times
 *
 * ## Resource provenance, never reasoning
 *
 * Read only from records the runtime made itself: the `delivery` it put on
 * the message that carried attached context, the handoff record a session
 * was started by, and the reads Hubble's context server measured. Never from
 * what the agent said or thought, never from a protocol payload, and never
 * from what the Command Centre merely had selected — so it answers with what
 * the agent was actually given. Collections are named live by the caller,
 * from their ids; one that has since been deleted is counted, not named.
 *
 * Pure, so the live session, agent history and the landing page's demo all
 * read the same answer from the same records.
 */

export type ContextProvenance = {
  /** One fact per line, in reading order. Never empty when returned. */
  lines: readonly string[];
};

export type ContextProvenanceInput = {
  session: Pick<RuntimeSessionView, "sessionId" | "workspaceId" | "context">;
  events: readonly Pick<AgentControlEvent, "kind" | "sessionId" | "timestamp" | "delivery" | "context" | "handoff">[];
  handoffs?: readonly SessionHandoff[];
  /** The moment of the action: what had been delivered by then. */
  at: number;
  workspaceName?: string;
  collectionName?: (collectionId: string) => string | undefined;
  agentName: (provider: AgentProviderId) => string;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function contextProvenanceOf(input: ContextProvenanceInput): ContextProvenance | undefined {
  const { session } = input;
  const workspaceId = session.workspaceId ?? session.context?.workspaceId;
  if (!workspaceId) return undefined;
  const ownEvents = input.events.filter((event) => event.sessionId === session.sessionId && event.timestamp <= input.at);

  const lines: string[] = [];
  const workspace = input.workspaceName ? `${input.workspaceName} workspace` : "Its workspace";

  // The latest delivery before the action: what the agent had been sent.
  let delivery: AgentControlEvent["delivery"];
  for (const event of ownEvents) {
    if (event.kind === "message_sent" && event.delivery && event.delivery.workspaceId === workspaceId) delivery = event.delivery;
  }

  if (delivery) {
    lines.push(delivery.workspace ? `${workspace} · Workspace brief` : workspace);
    const named: string[] = [];
    let unnamed = 0;
    for (const collectionId of delivery.collectionIds) {
      const name = input.collectionName?.(collectionId);
      if (name) named.push(`${name} collection`);
      else unnamed += 1;
    }
    unnamed += Math.max(0, delivery.collections - delivery.collectionIds.length);
    const selection = [
      ...named,
      ...(unnamed > 0 ? [plural(unnamed, "collection", "collections")] : []),
      ...(delivery.tabs > 0 ? [plural(delivery.tabs, "tab", "tabs")] : []),
    ];
    if (selection.length > 0) lines.push(selection.join(" · "));
  } else {
    lines.push(`${workspace} · Whole workspace`);
  }

  // A session started by a handoff was given what the handoff passed.
  const handoff = input.handoffs?.find(
    (record) => record.targetSessionId === session.sessionId && record.status === "ready" && record.workspaceId === workspaceId && record.createdAt <= input.at
  );
  if (handoff) {
    const result = handoff.context.previousResult;
    if (result) {
      const files = result.files?.length ?? 0;
      lines.push(`Previous result from ${input.agentName(handoff.sourceProvider)}${files > 0 ? ` · ${plural(files, "file", "files")}` : ""}`);
    }
    if (handoff.context.workspace?.focus) {
      const focus = handoff.context.workspace.focus;
      const parts = [
        ...(focus.collections > 0 ? [plural(focus.collections, "collection", "collections")] : []),
        ...(focus.tabs > 0 ? [plural(focus.tabs, "tab", "tabs")] : []),
      ];
      if (parts.length > 0 && !delivery) lines.push(`Handed over · ${parts.join(" · ")}`);
    }
    if (handoff.instruction) lines.push("Your handoff instruction");
  }

  const reads = ownEvents.filter((event) => event.kind === "context_read" && event.context?.ok !== false).length;
  if (reads > 0) lines.push(`Read the workspace ${reads === 1 ? "once" : `${reads} times`}`);

  return { lines };
}

/**
 * What an attached context delivered, as the record a `message_sent`
 * carries: counts by kind and the collections by id. Built from the
 * attachments actually sent — by the runtime host, and by the landing page's
 * demo — so it records what the agent was told, not what was selected.
 */
export function contextDeliveryOf(context: AgentAttachedContext, workspaceId: string): ControlContextDeliveryInfo | undefined {
  if (context.attachments.length === 0) return undefined;
  const count = (kind: AgentAttachedContext["attachments"][number]["kind"]) =>
    context.attachments.filter((attachment) => attachment.kind === kind).length;
  return {
    contextId: context.snapshotId.slice(0, 200),
    workspaceId,
    tabs: count("tab"),
    collections: count("collection"),
    relationships: count("relationship"),
    workspace: context.attachments.some((attachment) => attachment.kind === "workspace" && attachment.id === workspaceId),
    collectionIds: context.attachments
      .filter((attachment) => attachment.kind === "collection")
      .map((attachment) => attachment.id)
      .slice(0, MAX_DELIVERY_COLLECTION_IDS),
  };
}
