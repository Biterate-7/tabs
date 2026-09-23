import type { AgentIdentity } from "./roster";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type {
  RuntimeApprovalView,
  RuntimeSessionView,
  SequencedControlEvent,
} from "@/lib/agents/runtime/protocol";

/**
 * The unified agent session, and the conversation it holds (Phase J).
 *
 * ## One model for every provider
 *
 * Claude over its SDK and Gemini, Codex and Grok over ACP all arrive as the
 * same `SequencedControlEvent` stream — that is the control plane's whole
 * job. This module turns that stream into what a chat surface renders: turns
 * of conversation, with what the agent did in between, and the approvals it is
 * waiting on. Nothing here branches on the provider.
 *
 * ## Streaming, honestly
 *
 * A reply arrives as `message_delta` pieces sharing a `messageId`, then as one
 * `message_received` carrying the whole text. The transcript shows the pieces
 * joined, marked `streaming`, until the whole message lands and replaces them.
 * A provider that does not stream (Claude over the SDK, today) simply never
 * sends a delta, and its reply appears whole. There is no typewriter
 * animation: text on screen is text the agent has actually produced.
 *
 * Pure and synchronous, so it is re-derived from the event window on every
 * render and cannot hold a stale copy of the conversation.
 */

export type TranscriptItem =
  | {
      type: "message";
      id: string;
      role: "user" | "agent";
      text: string;
      /** Still arriving. */
      streaming: boolean;
      timestamp: number;
    }
  | { type: "event"; id: string; event: SequencedControlEvent };

export function buildTranscript(events: readonly SequencedControlEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  /** Open streaming messages, by messageId, pointing into `items`. */
  const open = new Map<string, number>();
  /** Messages already stated whole. A late delta for one is ignored. */
  const whole = new Set<string>();

  for (const event of events) {
    switch (event.kind) {
      case "message_sent":
        items.push({
          type: "message",
          id: event.id,
          role: "user",
          text: event.text ?? event.summary,
          streaming: false,
          timestamp: event.timestamp,
        });
        break;

      case "message_delta": {
        const messageId = event.messageId;
        if (!messageId || whole.has(messageId)) break;
        const at = open.get(messageId);
        if (at === undefined) {
          open.set(messageId, items.length);
          items.push({
            type: "message",
            id: messageId,
            role: "agent",
            text: event.text ?? "",
            streaming: true,
            timestamp: event.timestamp,
          });
        } else {
          const item = items[at];
          if (item.type === "message") items[at] = { ...item, text: item.text + (event.text ?? "") };
        }
        break;
      }

      case "message_received": {
        const text = event.text ?? event.summary;
        const messageId = event.messageId;
        const at = messageId ? open.get(messageId) : undefined;
        if (messageId) {
          whole.add(messageId);
          open.delete(messageId);
        }
        const item: TranscriptItem = {
          type: "message",
          id: messageId ?? event.id,
          role: "agent",
          text,
          streaming: false,
          timestamp: event.timestamp,
        };
        // The whole message replaces its pieces where they stood, so the
        // conversation does not jump when streaming ends.
        if (at !== undefined) items[at] = item;
        else items.push(item);
        break;
      }

      default:
        items.push({ type: "event", id: event.id, event });
    }
  }

  // A run that ended without its final message (cancelled, crashed) leaves
  // its pieces standing, no longer marked as arriving.
  const ended = events.some((event) => event.kind === "run_cancelled" || event.kind === "error");
  if (ended) {
    const lastTerminal = Math.max(
      ...events
        .filter((event) => event.kind === "run_cancelled" || event.kind === "error")
        .map((event) => event.sequence)
    );
    for (const [messageId, at] of open) {
      const item = items[at];
      const started = events.find((event) => event.messageId === messageId);
      if (item.type === "message" && started && started.sequence < lastTerminal) {
        items[at] = { ...item, streaming: false };
      }
    }
  }

  return items;
}

/* ------------------------------------------------------------------ *
 * The unified session
 * ------------------------------------------------------------------ */

/**
 * One agent session, whoever the provider is.
 *
 * Joins the three things a surface needs and that live in three places: the
 * runtime's view of the session, the connected agent it belongs to, and the
 * conversation. `workspaceId` is the TabDump workspace the session is
 * associated with — the one its context was drawn from — and `agent` is
 * absent for a session started before its agent was in the roster.
 */
export type AgentSessionModel = {
  sessionId: string;
  provider: AgentProviderId;
  agent?: AgentIdentity;
  workspaceId?: string;
  view: RuntimeSessionView;
  transcript: TranscriptItem[];
  approvals: readonly RuntimeApprovalView[];
  activity: string;
};

export function buildSessionModel(input: {
  view: RuntimeSessionView;
  events: readonly SequencedControlEvent[];
  approvals: readonly RuntimeApprovalView[];
  agent?: AgentIdentity;
}): AgentSessionModel {
  const workspaceId = input.view.workspaceId ?? input.agent?.workspaceId;
  return {
    sessionId: input.view.sessionId,
    provider: input.view.provider,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    view: input.view,
    transcript: buildTranscript(input.events),
    approvals: input.approvals,
    activity: liveActivity(input.view, input.events),
  };
}

/**
 * The one line a roster shows under an agent's name.
 *
 * Derived from the session status and the newest event, in that order: the
 * status decides whether anything is happening at all, and only then does the
 * last event say what. Never a guess — an idle agent says "Idle", not
 * "Ready to help".
 */
export function liveActivity(
  view: RuntimeSessionView | undefined,
  events: readonly SequencedControlEvent[] = []
): string {
  if (!view) return "No session";
  switch (view.status) {
    case "waiting_for_approval":
      return "Waiting for your approval";
    case "waiting_for_input":
      return "Waiting for you";
    case "failed":
      return "Stopped with an error";
    case "cancelled":
      return "Cancelled";
    case "disconnected":
      return "Disconnected";
    case "completed":
      return "Finished";
    case "connecting":
    case "created":
      return "Starting…";
    case "ready":
      return "Idle";
    case "running":
      break;
  }

  const last = [...events].reverse().find((event) => event.kind !== "message_sent");
  switch (last?.kind) {
    case "message_delta":
      return "Replying…";
    case "thinking":
      return "Thinking…";
    case "tool_started":
    case "command_started":
      return last.tool?.description ?? "Working…";
    case "file_modified":
    case "file_created":
      return "Editing files…";
    case "file_read":
      return "Reading files…";
    default:
      return "Working…";
  }
}
