import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * TabDump content, reduced to something an agent runtime can be given.
 *
 * ## The boundary this draws
 *
 * A provider adapter must never learn what a TabDump workspace *is*. It does
 * not know about tabs, collections, dependencies, sections, categories,
 * duplicate detection or the relationship graph, and it must not gain a
 * reason to: the moment an adapter imports `lib/workspace`, adding a provider
 * stops being an adapter problem.
 *
 * So resolution happens on TabDump's side. `@workspace`, `@tab`,
 * `@collection` and `@project` are resolved by the application into these
 * flat, provider-neutral records, and the adapter receives only these.
 *
 * ## Phase B scope
 *
 * The *shape* is here and is used by `sendMessage`. The resolvers that turn a
 * workspace id into attachments are **not** — that is the workspace→agent
 * bridge, and it belongs to its own phase. Nothing in this file reads
 * TabDump's domain, and `security.test.ts` asserts that.
 */

export type AgentContextKind =
  | "workspace"
  | "tab"
  | "collection"
  | "relationship"
  | "project"
  | "file";

export const AGENT_CONTEXT_KINDS: readonly AgentContextKind[] = [
  "workspace",
  "tab",
  "collection",
  "relationship",
  "project",
  "file",
] as const;

export function isAgentContextKind(value: unknown): value is AgentContextKind {
  return typeof value === "string" && (AGENT_CONTEXT_KINDS as readonly string[]).includes(value);
}

/** Caps, for the same reason every other provider-facing string here has one. */
export const MAX_ATTACHMENT_LABEL_LENGTH = 200;
export const MAX_ATTACHMENT_DETAIL_LENGTH = 500;
export const MAX_ATTACHMENTS_PER_MESSAGE = 200;

/**
 * One piece of attached context.
 *
 * Deliberately flat and deliberately small. `label` is what the agent is told
 * this thing is called; `detail` is an optional one-line elaboration (a URL,
 * a relative path, a note excerpt). There is no field for page content, no
 * field for file contents, and no nesting — an attachment is a *reference*,
 * and a provider that wants the bytes behind one has to be given a project
 * scope and read it itself, under permissions.
 */
export type AgentContextAttachment = {
  kind: AgentContextKind;
  /** TabDump's own id for the thing. Opaque to the adapter. */
  id: string;
  label: string;
  detail?: string;
};

function bound(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

/**
 * Builds an attachment, or returns null for one that cannot be expressed.
 *
 * Returns null rather than throwing: a tab with an empty title is ordinary,
 * and a resolver should drop it rather than fail the whole message.
 */
export function createAttachment(input: {
  kind: AgentContextKind;
  id: string;
  label: string;
  detail?: string;
}): AgentContextAttachment | null {
  if (!isAgentContextKind(input.kind)) return null;
  if (!input.id) return null;

  const label = bound(input.label, MAX_ATTACHMENT_LABEL_LENGTH);
  if (!label) return null;

  const attachment: AgentContextAttachment = { kind: input.kind, id: input.id, label };

  if (input.detail) {
    const detail = bound(input.detail, MAX_ATTACHMENT_DETAIL_LENGTH);
    if (detail) attachment.detail = detail;
  }

  return attachment;
}

/**
 * Everything a message carries besides its text.
 *
 * `attachments` is capped so that "attach this workspace" on a workspace with
 * four thousand tabs cannot produce a single unbounded payload. The resolver
 * decides what to keep; this type guarantees it decided.
 */
export type AgentMessageContext = {
  attachments: readonly AgentContextAttachment[];
  /** The project this message is scoped to, when one applies. */
  projectId?: string;
  /** The TabDump workspace the message came from. */
  workspaceId?: string;
};

export const EMPTY_CONTEXT: AgentMessageContext = { attachments: [] };

/** Whether a context is within its bounds and internally well-formed. */
export function isWellFormedContext(context: AgentMessageContext): boolean {
  if (!Array.isArray(context.attachments)) return false;
  if (context.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) return false;

  return context.attachments.every(
    (attachment) =>
      isAgentContextKind(attachment.kind) &&
      Boolean(attachment.id) &&
      attachment.label.length > 0 &&
      attachment.label.length <= MAX_ATTACHMENT_LABEL_LENGTH &&
      (attachment.detail === undefined ||
        attachment.detail.length <= MAX_ATTACHMENT_DETAIL_LENGTH)
  );
}

/**
 * A message as it enters the control plane.
 *
 * Note what is absent: no provider name, no model, no CLI flag, no permission
 * mode, no session-resume token. Those are an adapter's business, and putting
 * any of them here is the failure mode the contract exists to prevent —
 * see the note on `AgentControlAdapter`.
 */
export type AgentMessageInput = {
  sessionId: string;
  /** What the user typed. The one genuinely free-form string in the control plane. */
  text: string;
  context: AgentMessageContext;
};

/** Cap on a single message. Large enough for a real instruction, bounded against a paste of a database. */
export const MAX_MESSAGE_LENGTH = 100_000;

export function isWellFormedMessage(message: AgentMessageInput): boolean {
  if (!message.sessionId) return false;
  if (typeof message.text !== "string") return false;
  if (message.text.trim().length === 0) return false;
  if (message.text.length > MAX_MESSAGE_LENGTH) return false;
  return isWellFormedContext(message.context);
}

/**
 * A message that has been delivered, for the session record.
 *
 * `provider` is stamped at the boundary so a transcript reconstructed later
 * says who it went to, without the message input having had to name one.
 */
export type AgentMessageRecord = {
  id: string;
  sessionId: string;
  provider: AgentProviderId;
  role: "user" | "agent" | "system";
  /** Bounded at the boundary. May be absent for a record that is only a marker. */
  text?: string;
  attachments: readonly AgentContextAttachment[];
  createdAt: number;
};
