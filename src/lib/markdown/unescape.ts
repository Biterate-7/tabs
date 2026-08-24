/**
 * Strips a backslash placed directly in front of a Markdown-syntax
 * character (`*_\`#`) when nothing in Ask TabDump's own pipeline put it
 * there (see route.ts/agent.ts/client.ts — none of them touch backslashes;
 * confirmed by tracing every hop from Gemini's JSON response to this
 * text). Gemini 3 occasionally emits its final tool-calling-turn answer
 * with Markdown syntax pre-escaped (e.g. `\*\*bold\*\*` instead of
 * `**bold**`) — a real, observed quirk of writing a "final answer" turn in
 * the same request shape as a tool-call turn, not something this app's
 * system instructions ask for. Per CommonMark, `\*` is a DELIBERATE escape
 * (a literal, non-emphasis asterisk) — so simply handing that text to a
 * spec-compliant Markdown renderer would faithfully reproduce the exact
 * bug (literal `**` shown to the user) rather than fix it. None of Ask
 * TabDump's system instructions ever ask the model to show a user a
 * literal escaped Markdown character, so unescaping unconditionally here
 * is safe for this app's actual output space.
 */
export function stripSpuriousMarkdownEscapes(text: string): string {
  return text.replace(/\\([*_`#])/g, "$1");
}
