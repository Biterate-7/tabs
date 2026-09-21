import {
  createAttachment,
  isWellFormedContext,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@/lib/agents/control/context";
import type {
  AgentContextAttachment,
  AgentContextKind,
  AgentMessageContext,
} from "@/lib/agents/control/context";
import type { AgentContextItem, AgentContextSnapshot } from "./types";

/**
 * The one place a context snapshot becomes something the control plane can
 * carry.
 *
 * ## Why a projection rather than the snapshot itself
 *
 * A snapshot is TabDump's record: it has scope, limits, omissions, a capture
 * time and a provenance chain. An attachment is what crosses the boundary to
 * a provider adapter, and it is deliberately four flat fields.
 *
 * Handing an adapter the snapshot would give it the scope object — which
 * names every workspace and project the user authorized — and the omission
 * list, which names entities the user specifically did *not* attach. Neither
 * is the adapter's business, and an adapter that could read them would be
 * one refactor away from acting on them.
 *
 * So the projection is lossy on purpose, and it loses exactly the
 * security-relevant parts.
 *
 * ## The invariant this file exists to hold
 *
 * The bridge's `maxItems` and the control plane's
 * `MAX_ATTACHMENTS_PER_MESSAGE` are two numbers describing one thing. If the
 * bridge could resolve more items than the control plane will accept, a
 * snapshot that passed every one of its own limits would be silently cut a
 * second time at the boundary — and the second cut would produce no
 * omission record, which is the failure mode the whole omission system
 * exists to prevent. `attach.test.ts` asserts they cannot drift.
 */

/**
 * Snapshot source types map one-to-one onto attachment kinds.
 *
 * Written as an exhaustive record rather than a cast, so adding a source
 * type is a type error here until someone decides what a provider should be
 * told it is.
 */
const KIND_OF_SOURCE: Record<AgentContextItem["sourceType"], AgentContextKind> = {
  workspace: "workspace",
  tab: "tab",
  collection: "collection",
  relationship: "relationship",
  graph: "graph",
  project: "project",
  agent_activity: "agent_activity",
};

/**
 * The one-line elaboration an attachment carries beside its label.
 *
 * Each is a *reference or a shape*, never content: a redacted URL, a member
 * count, a hop count. There is no branch here that reads a file, a page body
 * or a project's contents, because there is no such field on an item to
 * read — see `types.ts`.
 */
function detailOf(item: AgentContextItem): string | undefined {
  switch (item.sourceType) {
    case "workspace":
      return `${item.tabCount} tabs, ${item.collectionCount} collections`;
    case "tab":
      return item.url ?? item.domain;
    case "collection":
      return item.membersTruncated
        ? `${item.tabIds.length} of ${item.memberCount} tabs`
        : `${item.memberCount} tabs`;
    case "relationship":
      return item.kind ? `depends on (${item.kind})` : "depends on";
    case "graph":
      return `${item.nodes.length} related tabs, ${item.edges.length} links, depth ${item.depth}`;
    case "project":
      // `root` is absent on a hosted runtime. Saying so is more useful than
      // an attachment that looks like it has no path at all.
      return item.root ?? (item.rootWithheld ? "path not available here" : undefined);
    case "agent_activity":
      return `${item.agentName} — ${item.status}`;
  }
}

/**
 * Projects a snapshot into attachments.
 *
 * An item that cannot be expressed as a well-formed attachment is dropped
 * rather than throwing — `createAttachment` already returns null for that
 * case, and one unrenderable tab must not fail a message carrying thirty
 * good ones.
 */
export function snapshotToAttachments(
  snapshot: AgentContextSnapshot
): readonly AgentContextAttachment[] {
  const attachments: AgentContextAttachment[] = [];

  for (const item of snapshot.items) {
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;

    const attachment = createAttachment({
      kind: KIND_OF_SOURCE[item.sourceType],
      id: item.sourceId,
      label: item.label,
      detail: detailOf(item),
    });

    if (attachment) attachments.push(attachment);
  }

  return attachments;
}

/**
 * The full message context for a snapshot.
 *
 * `workspaceId` is filled only when the snapshot's scope names exactly one.
 * A multi-workspace snapshot has no single answer, and picking the first
 * would be a guess the rest of the system would then treat as a fact.
 */
export function snapshotToMessageContext(
  snapshot: AgentContextSnapshot,
  options: { projectId?: string } = {}
): AgentMessageContext {
  const context: AgentMessageContext = {
    attachments: snapshotToAttachments(snapshot),
  };

  if (snapshot.scope.workspaceIds.length === 1) {
    return options.projectId
      ? { ...context, workspaceId: snapshot.scope.workspaceIds[0], projectId: options.projectId }
      : { ...context, workspaceId: snapshot.scope.workspaceIds[0] };
  }

  return options.projectId ? { ...context, projectId: options.projectId } : context;
}

/** Whether a projected context satisfies the control plane's own contract. */
export function isAttachableSnapshot(snapshot: AgentContextSnapshot): boolean {
  return isWellFormedContext(snapshotToMessageContext(snapshot));
}
