import { cleanBody } from "./clean";
import { CONVERSATION_LIMITS } from "./types";
import type { ConversationRole, ConversationTurn } from "@/lib/resources/types";

/**
 * A pasted conversation, split into turns when its labels say who spoke.
 *
 * Recognised labels, at the start of a line (any case, optional bold or a
 * Markdown heading around them, "said" optional):
 *
 *   person   You · User · Me · Human · Question · Q
 *   AI       ChatGPT · Claude · Gemini · Perplexity · Assistant · AI · Answer · A · Model
 *
 * So "You said:" / "ChatGPT said:" (ChatGPT's own copied text), "User:" /
 * "Assistant:", "## User" / "## Assistant" and "**Q:**" / "**A:**" all
 * split. A paste with no labels — or with only one side labelled — is not
 * guessed at: it is kept whole as text, and the result says so.
 */

export type ParsedText = {
  turns: ConversationTurn[];
  /** The whole text, when it could not be split into turns. */
  text?: string;
  /** Whether turns were recognised. */
  structured: boolean;
};

const PERSON = ["you", "user", "me", "human", "question", "q"];
const AI = ["chatgpt", "claude", "gemini", "perplexity", "assistant", "ai", "answer", "a", "model", "copilot", "grok"];

const LABEL = new RegExp(
  String.raw`^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(${[...PERSON, ...AI].join("|")})(?:\s+said)?\s*(?:\*\*|__)?\s*(:)?\s*(?:\*\*|__)?\s*(.*)$`,
  "i"
);

function roleOf(label: string): ConversationRole {
  return PERSON.includes(label.toLowerCase()) ? "user" : "assistant";
}

export function parseConversationText(input: string): ParsedText {
  const body = cleanBody(input, CONVERSATION_LIMITS.totalChars);
  if (!body) return { turns: [], structured: false };

  const lines = body.split("\n");
  const turns: { role: ConversationRole; lines: string[] }[] = [];
  let preamble: string[] = [];
  for (const line of lines) {
    const match = LABEL.exec(line);
    // A label counts when it ends in a colon, or is a heading/bold line on its own ("## User").
    const isHeading = match && (/^\s*#{1,6}\s/.test(line) || /^\s*(\*\*|__)/.test(line)) && !match[3];
    if (match && (match[2] || isHeading)) {
      turns.push({ role: roleOf(match[1]!), lines: match[3] ? [match[3]] : [] });
      continue;
    }
    if (turns.length === 0) preamble.push(line);
    else turns[turns.length - 1]!.lines.push(line);
  }

  const parsed = turns
    .map((turn) => ({ role: turn.role, text: cleanBody(turn.lines.join("\n")) }))
    .filter((turn) => turn.text.length > 0)
    .slice(0, CONVERSATION_LIMITS.turns);
  const bothSides = parsed.some((turn) => turn.role === "user") && parsed.some((turn) => turn.role === "assistant");
  // Text before the first label is kept with the first turn rather than lost.
  preamble = preamble.filter((line) => line.trim().length > 0);
  if (!bothSides || parsed.length < 2) return { turns: [], text: body, structured: false };
  if (preamble.length > 0) parsed[0] = { ...parsed[0]!, text: cleanBody(`${preamble.join("\n")}\n\n${parsed[0]!.text}`) };
  return { turns: parsed, structured: true };
}
