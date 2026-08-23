/**
 * Cheap, deterministic pre-check for whether a question is plausibly an
 * Auto-Organize request — used client-side (src/hooks/use-ask-tabdump.ts)
 * to decide whether it's worth paying for computeSemanticClusterHints'
 * IndexedDB scan before sending the request at all (AGENTS.md section 17:
 * "avoid unnecessary data," "remain responsive"). This is only a
 * performance gate, not the actual intent decision — Gemini still decides
 * whether to call propose_auto_organize (see AGENT_SYSTEM_INSTRUCTION), so
 * a false negative here just means clustering falls back to
 * domain/keyword-only signals, not that the feature stops working.
 */
const ORGANIZE_PATTERNS: RegExp[] = [
  /\borganize\b/i,
  /\bclean(?:\s|-)?up\b/i,
  /\btidy\b/i,
  /\bdeclutter\b/i,
  /\bsort\b[\s\S]*\b(tabs?|workspaces?)\b/i,
  /\bgroup\b[\s\S]*\btabs?\b/i,
];

export function looksLikeAutoOrganizeIntent(question: string): boolean {
  return ORGANIZE_PATTERNS.some((pattern) => pattern.test(question));
}
