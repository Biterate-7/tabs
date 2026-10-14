import { z } from "zod";
import { conversationRefOf } from "@/lib/providers/registry";
import { cleanBody, cleanLine, titleFromText } from "./clean";
import { CONVERSATION_LIMITS } from "./types";
import type { ConversationInput } from "./types";
import type { ConversationTurn } from "@/lib/resources/types";

/**
 * A conversation Hubble for Chrome read from the page the person was on,
 * re-read here before anything is saved.
 *
 * The extension is a transport, never a trust boundary: the page that sent
 * this could have been changed by the AI app, by another extension, or by
 * the conversation's own text. So:
 *
 *   - the provider is decided by the conversation's **address**, never by
 *     what the payload claims, and an address that is not one AI-app
 *     conversation is refused (\`not-a-conversation\`);
 *   - turns are a closed shape — a role of "user" or "assistant" and text —
 *     anything else in the payload is dropped;
 *   - text is cleaned and bounded the same way an export or a paste is.
 *
 * A capture with no readable turns is refused (\`empty\`) rather than saved
 * as an empty conversation.
 */

const turnSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() }).loose();

const captureSchema = z
  .object({
    url: z.string().max(4000),
    title: z.string().max(2000).optional(),
    turns: z.array(turnSchema).max(CONVERSATION_LIMITS.turns * 2),
  })
  .loose();

export type CaptureRefusal = "invalid" | "not-a-conversation" | "empty";

export type CaptureRead = { ok: true; conversation: ConversationInput; truncated: boolean } | { ok: false; reason: CaptureRefusal };

/**
 * Provider titles look like "Topic - Claude" or "ChatGPT - Topic"; keep the
 * topic. "ChatGPT: …" is the app's own site title (what a signed-out
 * conversation shows, seen live 2026-10-14), never a topic: it is dropped, and
 * the conversation is titled from its first question instead.
 */
function topicOf(title: string): string {
  if (/^\s*(ChatGPT|Claude|Gemini|Google Gemini|Perplexity)\s*:/i.test(title)) return "";
  return cleanLine(title.replace(/^\s*(ChatGPT|Claude|Gemini|Google Gemini|Perplexity)\s*[-–|]\s*/i, "").replace(/\s*[-–|]\s*(ChatGPT|Claude|Gemini|Google Gemini|Perplexity)\s*$/i, ""));
}

export function readConversationCapture(raw: unknown): CaptureRead {
  const parsed = captureSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const ref = conversationRefOf(parsed.data.url);
  if (!ref) return { ok: false, reason: "not-a-conversation" };

  let left: number = CONVERSATION_LIMITS.totalChars;
  let truncated = parsed.data.turns.length > CONVERSATION_LIMITS.turns;
  const turns: ConversationTurn[] = [];
  for (const turn of parsed.data.turns.slice(0, CONVERSATION_LIMITS.turns)) {
    if (left <= 0) {
      truncated = true;
      break;
    }
    const room = Math.min(CONVERSATION_LIMITS.turnText, left);
    const text = cleanBody(turn.text, room);
    if (!text) continue;
    if (turn.text.trim().length > room) truncated = true;
    turns.push({ role: turn.role, text });
    left -= text.length;
  }
  if (turns.length === 0) return { ok: false, reason: "empty" };

  const fallback = `${ref.provider === "chatgpt" ? "ChatGPT" : ref.provider === "claude" ? "Claude" : ref.provider === "gemini" ? "Gemini" : "Perplexity"} conversation`;
  const title = topicOf(parsed.data.title ?? "");
  return {
    ok: true,
    truncated,
    conversation: {
      provider: ref.provider,
      title: title && !/^(ChatGPT|Claude|Gemini|Google Gemini|Perplexity|New chat)$/i.test(title) ? title : titleFromText(turns[0]!.text, fallback),
      url: ref.url,
      conversationId: ref.conversationId,
      turns,
      method: "page",
    },
  };
}
