import { createAttachment, MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/agents/control/context";
import { contextPackId } from "./pack";
import type { AgentAttachedContext, AgentContextAttachment } from "@/lib/agents/control/context";
import { PROJECT_CAPABILITY_AGENT_PHRASES } from "@/lib/agents/project/capabilities";
import { PROJECT_TYPE_LABELS } from "@/lib/agents/project/inspection";
import type { ContextPack, ContextPackProject } from "./pack";

/**
 * A Context Pack, as the agent runtime receives it.
 *
 * The runtime's contract is unchanged: `attach_context` takes the control
 * plane's flat attachments (`control/context.ts`), the runtime checks every
 * reference against the session's workspace, and the adapter renders them
 * into the user turn inside its delimited, provenance-stated block. This is
 * the one projection from the pack into that contract, so what the inspector
 * shows and what the agent is sent are the same pack by construction.
 *
 *   - **workspace** — only when there is something to say beyond what the
 *     session's workspace tools already answer: the user's brief, and agent
 *     changes made in the workspace since. A whole-workspace session with
 *     neither attaches nothing, exactly as before: it reads on request.
 *   - **collections, tabs, relationships** — the selection, with the labels
 *     and redacted addresses the Phase E resolver produced.
 *
 * Previous result and instruction never travel as attachments: a handoff's
 * envelope carries the first, and the person's message is the second.
 *
 * The pack's id (`pack-<fingerprint>`) is the snapshot id the runtime records
 * and reports back as `contextSnapshotId`, which is how the Command Centre
 * knows whether a session has the pack it would be sent now.
 */

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The workspace attachment's one line: the brief, then what changed. Bounded by `createAttachment`. */
export function workspaceAttachmentDetail(pack: ContextPack): string | undefined {
  const parts: string[] = [];
  if (pack.workspace.description) parts.push(`Purpose: ${pack.workspace.description}`);
  if (pack.workspace.focus) parts.push(`Current focus: ${pack.workspace.focus}`);
  if (pack.recentChanges.length > 0) {
    parts.push(`Recent changes: ${pack.recentChanges.map((change) => change.text).join("; ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The project as one line an agent reads (Hubble 1.6): what kind, which Git
 * branch, where it lives, and exactly what it may do there. Never a path.
 */
export function projectAttachmentDetail(project: ContextPackProject): string {
  const parts: string[] = [];
  parts.push(project.type ? `${PROJECT_TYPE_LABELS[project.type]} project` : "Project");
  if (project.repository?.branch) parts.push(`Git branch ${project.repository.branch}${project.repository.head ? ` at ${project.repository.head}` : ""}`);
  else if (project.repository?.head) parts.push(`Git commit ${project.repository.head}`);
  parts.push(project.location === "local" ? "on the person's own machine — your working directory" : "in a sandbox Hubble created");
  const may = project.capabilities.filter((capability) => capability === "read_files" || capability === "write_files" || capability === "run_commands");
  parts.push(may.length > 0 ? `You may ${may.map((capability) => PROJECT_CAPABILITY_AGENT_PHRASES[capability]).join("; ")}` : "You may not touch its files");
  return parts.join(" · ");
}

export function contextPackAttachments(pack: ContextPack): AgentContextAttachment[] {
  const attachments: AgentContextAttachment[] = [];
  const push = (attachment: AgentContextAttachment | null) => {
    if (attachment && attachments.length < MAX_ATTACHMENTS_PER_MESSAGE) attachments.push(attachment);
  };

  const detail = workspaceAttachmentDetail(pack);
  if (detail) {
    push(
      createAttachment({
        kind: "workspace",
        id: pack.workspace.id,
        label: pack.workspace.name,
        detail: `${detail} · ${plural(pack.workspace.tabs, "tab", "tabs")}, ${plural(pack.workspace.collections, "collection", "collections")}`,
      })
    );
  }
  for (const collection of pack.collections) {
    push(createAttachment({ kind: "collection", id: collection.id, label: collection.name, detail: plural(collection.tabs, "tab", "tabs") }));
  }
  for (const tab of pack.tabs) {
    push(createAttachment({ kind: "tab", id: tab.id, label: tab.title, ...(tab.url ?? tab.domain ? { detail: tab.url ?? tab.domain } : {}) }));
  }
  for (const relationship of pack.relationships) {
    push(createAttachment({ kind: "relationship", id: relationship.id, label: relationship.label, detail: "depends on" }));
  }
  // The project and the files the work touched (Hubble 1.6). The runtime refuses a
  // project reference that is not the session's own, and files without one.
  if (pack.project) push(createAttachment({ kind: "project", id: pack.project.id, label: pack.project.name, detail: projectAttachmentDetail(pack.project) }));
  if (pack.project) {
    for (const file of pack.files) {
      const how = file.outside
        ? "changed outside this session since you last edited it"
        : file.change === "created"
          ? "created by earlier work"
          : "edited by earlier work";
      push(createAttachment({ kind: "file", id: file.path, label: file.path, detail: file.state === "missing" ? `${how} · no longer in the project` : how }));
    }
  }
  return attachments;
}

/**
 * What `attach_context` is sent for this pack — or `null` when there is
 * nothing to attach and the session should be detached instead.
 */
export function contextPackAttachedContext(pack: ContextPack, capturedAt: number): AgentAttachedContext | null {
  const attachments = contextPackAttachments(pack);
  if (attachments.length === 0) return null;
  return { snapshotId: contextPackId(pack), capturedAt, attachments };
}
