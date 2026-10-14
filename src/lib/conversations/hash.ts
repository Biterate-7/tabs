import type { ConversationTurn } from "@/lib/resources/types";

/**
 * A short fingerprint of a conversation's (or note's) text: what tells "saved
 * again, nothing new" from "saved again, it grew". Whitespace runs and case
 * are folded so a re-render that reflowed a paragraph is not a change; roles
 * and turn order are kept so an edited turn is.
 *
 * Two independent FNV-1a passes, 16 hex characters. Equality, not secrecy.
 */
export function contentHash(input: { turns?: readonly ConversationTurn[]; text?: string }): string {
  const parts: string[] = [];
  for (const turn of input.turns ?? []) parts.push(`${turn.role}:${normalize(turn.text)}`);
  if (input.text) parts.push(`text:${normalize(input.text)}`);
  // A separator no cleaned text can contain, so two turns never read as one.
  const text = parts.join("\n\u0001\n");
  let a = 0x811c9dc5;
  let b = 0x9e3779b9 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
