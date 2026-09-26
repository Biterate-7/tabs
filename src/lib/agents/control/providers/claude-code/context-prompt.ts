/**
 * Claude's context rendering is the shared one.
 *
 * The `<hubble-context>` block was written for Claude in Phase E, but
 * nothing in it is Claude's: it is how Hubble states attached context to any
 * agent, in the user turn, delimited and labelled as untrusted page text.
 * Phase J moved it to ../context-prompt.ts so the ACP adapter states context
 * exactly the same way rather than growing a second, drifting renderer.
 */
export { renderContextBlock, withContext } from "../context-prompt";
