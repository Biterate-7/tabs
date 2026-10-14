import { z } from "zod";
import { conversationUrlFor } from "@/lib/providers/registry";
import { cleanBody, cleanLine, titleFromText } from "./clean";
import { CONVERSATION_LIMITS } from "./types";
import type { ConversationInput } from "./types";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ConversationTurn } from "@/lib/resources/types";

/**
 * Conversations from an AI app's own data export.
 *
 * Two formats are read, and only because they are documented by what the
 * apps themselves produce and Hubble's fixtures are shaped like them:
 *
 *   ChatGPT  conversations.json — an array of conversations, each a tree of
 *            messages (\`mapping\`) whose visible thread is the path from
 *            \`current_node\` back to the root.
 *   Claude   conversations.json — an array of conversations, each with a flat
 *            \`chat_messages\` list (sender "human" | "assistant").
 *
 * Anything else is refused with a reason, never half-read: an unknown shape
 * is not "imported with 0 conversations". Gemini (Google Takeout) and
 * Perplexity have no conversation export Hubble can read — see the provider
 * registry — and a file from them is reported as unsupported.
 *
 * Every string is cleaned (lib/conversations/clean.ts) and bounded; tool
 * calls, system messages, hidden messages and attachments are left out —
 * what is kept is what the person and the AI visibly said.
 */

export type ExportFormat = "chatgpt" | "claude";

export type ExportParse =
  | { ok: true; format: ExportFormat; provider: AiProviderId; conversations: ConversationInput[]; skipped: number; truncated: boolean }
  | { ok: false; reason: "malformed-json" | "unknown-format" | "empty" };

const time = (seconds: unknown): number | undefined =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;

const isoTime = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
};

/* ------------------------------------------------------------------ *
 * ChatGPT
 * ------------------------------------------------------------------ */

const chatGptMessage = z
  .object({
    author: z.object({ role: z.string() }).loose(),
    content: z
      .object({
        content_type: z.string(),
        parts: z.array(z.unknown()).optional(),
        text: z.string().optional(),
      })
      .loose()
      .optional(),
    create_time: z.number().nullable().optional(),
    recipient: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const chatGptNode = z
  .object({
    message: chatGptMessage.nullable().optional(),
    parent: z.string().nullable().optional(),
  })
  .loose();

const chatGptConversation = z
  .object({
    title: z.string().nullable().optional(),
    create_time: z.number().nullable().optional(),
    update_time: z.number().nullable().optional(),
    mapping: z.record(z.string(), chatGptNode),
    current_node: z.string().nullable().optional(),
    conversation_id: z.string().optional(),
    id: z.string().optional(),
  })
  .loose();

type ChatGptConversation = z.infer<typeof chatGptConversation>;

function chatGptText(message: z.infer<typeof chatGptMessage>): string {
  const content = message.content;
  if (!content) return "";
  if (content.content_type !== "text" && content.content_type !== "multimodal_text") return "";
  const parts = (content.parts ?? []).filter((part): part is string => typeof part === "string");
  return cleanBody(parts.length > 0 ? parts.join("\n\n") : (content.text ?? ""));
}

function chatGptTurns(conversation: ChatGptConversation): ConversationTurn[] {
  const { mapping } = conversation;
  // The visible thread: current_node back to the root. Without one, the newest leaf.
  let cursor = conversation.current_node ?? undefined;
  if (!cursor || !mapping[cursor]) {
    cursor = Object.entries(mapping)
      .filter(([, node]) => node.message)
      .sort((a, b) => (a[1].message?.create_time ?? 0) - (b[1].message?.create_time ?? 0))
      .pop()?.[0];
  }
  const path: z.infer<typeof chatGptNode>[] = [];
  const seen = new Set<string>();
  while (cursor && mapping[cursor] && !seen.has(cursor) && path.length < CONVERSATION_LIMITS.turns * 4) {
    seen.add(cursor);
    path.push(mapping[cursor]!);
    cursor = mapping[cursor]!.parent ?? undefined;
  }
  const turns: ConversationTurn[] = [];
  for (const node of path.reverse()) {
    const message = node.message;
    if (!message) continue;
    const role = message.author.role;
    if (role !== "user" && role !== "assistant") continue;
    // Tool calls are addressed to a tool, not the person; hidden messages were never shown.
    if (message.recipient && message.recipient !== "all") continue;
    if (message.metadata?.is_visually_hidden_from_conversation === true) continue;
    const text = chatGptText(message);
    if (!text) continue;
    const at = time(message.create_time);
    turns.push({ role, text, ...(at !== undefined ? { at } : {}) });
  }
  return turns;
}

function looksLikeChatGpt(entry: unknown): boolean {
  return Boolean(entry && typeof entry === "object" && "mapping" in entry && typeof (entry as { mapping: unknown }).mapping === "object");
}

/* ------------------------------------------------------------------ *
 * Claude
 * ------------------------------------------------------------------ */

const claudeMessage = z
  .object({
    sender: z.string(),
    text: z.string().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).optional(),
    created_at: z.string().optional(),
  })
  .loose();

const claudeConversation = z
  .object({
    uuid: z.string(),
    name: z.string().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    chat_messages: z.array(claudeMessage),
  })
  .loose();

function claudeTurns(conversation: z.infer<typeof claudeConversation>): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of conversation.chat_messages) {
    const role = message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    const blocks = (message.content ?? []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text!);
    const text = cleanBody(blocks.length > 0 ? blocks.join("\n\n") : (message.text ?? ""));
    if (!text) continue;
    const at = isoTime(message.created_at);
    turns.push({ role, text, ...(at !== undefined ? { at } : {}) });
  }
  return turns;
}

function looksLikeClaude(entry: unknown): boolean {
  return Boolean(entry && typeof entry === "object" && "chat_messages" in entry && Array.isArray((entry as { chat_messages: unknown }).chat_messages));
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

/** Turns bounded in number and in total size; whether anything was cut. */
function bound(turns: ConversationTurn[]): { turns: ConversationTurn[]; truncated: boolean } {
  let left: number = CONVERSATION_LIMITS.totalChars;
  const kept: ConversationTurn[] = [];
  for (const turn of turns.slice(0, CONVERSATION_LIMITS.turns)) {
    if (left <= 0) break;
    const text = turn.text.slice(0, left);
    kept.push({ ...turn, text });
    left -= text.length;
  }
  return { turns: kept, truncated: kept.length < turns.length || kept.some((turn, index) => turn.text.length < turns[index]!.text.length) };
}

/** Reads an export file's text. Pure: no clock, no storage. */
export function parseConversationExport(raw: string): ExportParse {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed-json" };
  }
  // Some exports wrap the list; accept { conversations: [...] } too.
  const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { conversations?: unknown }).conversations) ? (data as { conversations: unknown[] }).conversations : undefined;
  if (!list) return { ok: false, reason: "unknown-format" };
  if (list.length === 0) return { ok: false, reason: "empty" };

  const format: ExportFormat | undefined = list.some(looksLikeChatGpt) ? "chatgpt" : list.some(looksLikeClaude) ? "claude" : undefined;
  if (!format) return { ok: false, reason: "unknown-format" };

  const provider: AiProviderId = format;
  const conversations: ConversationInput[] = [];
  let skipped = 0;
  let truncated = list.length > CONVERSATION_LIMITS.importConversations;

  for (const entry of list.slice(0, CONVERSATION_LIMITS.importConversations)) {
    if (format === "chatgpt") {
      const parsed = chatGptConversation.safeParse(entry);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const all = chatGptTurns(parsed.data);
      if (all.length === 0) {
        skipped += 1;
        continue;
      }
      const { turns, truncated: cut } = bound(all);
      truncated ||= cut;
      const conversationId = parsed.data.conversation_id ?? parsed.data.id;
      const url = conversationId ? conversationUrlFor("chatgpt", conversationId) : undefined;
      const createdAt = time(parsed.data.create_time);
      const updatedAt = time(parsed.data.update_time);
      conversations.push({
        provider,
        title: cleanLine(parsed.data.title ?? "") || titleFromText(turns[0]!.text, "ChatGPT conversation"),
        ...(url ? { url, conversationId } : {}),
        turns,
        method: "export",
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      });
    } else {
      const parsed = claudeConversation.safeParse(entry);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const all = claudeTurns(parsed.data);
      if (all.length === 0) {
        skipped += 1;
        continue;
      }
      const { turns, truncated: cut } = bound(all);
      truncated ||= cut;
      const url = conversationUrlFor("claude", parsed.data.uuid);
      const createdAt = isoTime(parsed.data.created_at);
      const updatedAt = isoTime(parsed.data.updated_at);
      conversations.push({
        provider,
        title: cleanLine(parsed.data.name ?? "") || titleFromText(turns[0]!.text, "Claude conversation"),
        ...(url ? { url, conversationId: parsed.data.uuid } : {}),
        turns,
        method: "export",
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      });
    }
  }

  if (conversations.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, format, provider, conversations, skipped, truncated };
}
