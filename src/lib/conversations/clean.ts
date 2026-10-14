import { UNSAFE_ANY, UNSAFE_KEEP_LINES } from "@/lib/integrations/text";
import { CONVERSATION_LIMITS } from "./types";

/**
 * Text from a page, a file or a paste, made safe to store and show: control,
 * zero-width and bidirectional-override characters removed (they can hide or
 * reorder what a person reads), line endings normalized, runs of blank lines
 * collapsed. Words are never rewritten — this is not a summary.
 */
export function cleanBody(value: unknown, max: number = CONVERSATION_LIMITS.turnText): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_KEEP_LINES, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** A one-line label (a title): every control character becomes a space, runs of space collapse. */
export function cleanLine(value: unknown, max: number = CONVERSATION_LIMITS.title): string {
  if (typeof value !== "string") return "";
  return value.replace(UNSAFE_ANY, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A title from the start of some text, when nothing better is known. */
export function titleFromText(text: string, fallback: string): string {
  const first = cleanLine(text.split("\n").find((line) => line.trim().length > 0) ?? "", 90);
  if (!first) return fallback;
  return first.length >= 90 ? `${first.slice(0, 87).trimEnd()}…` : first;
}
