import type { AgentVisualTone } from "@/lib/agents/visual/types";

/**
 * Tone → class, in one place.
 *
 * Five roles, and every agent surface in the product resolves colour through
 * this table rather than picking a class inline. That is what keeps a run
 * drawn as failing in the sidebar from being drawn as merely quiet in the
 * world: there is one answer to "what colour is a bad agent", and it lives
 * here.
 *
 * Every class resolves to a theme token, so the whole system re-colours with
 * the user's theme and none of it has to know which theme is active.
 */
export const AGENT_TONE_TEXT_CLASS: Record<AgentVisualTone, string> = {
  live: "text-accent-text",
  idle: "text-muted-foreground",
  good: "text-success",
  bad: "text-destructive",
  muted: "text-tertiary",
};

/**
 * The colour a mark is drawn in.
 *
 * The rule: an identity's accent colours the mark for every state *except*
 * the two that are judgements — a finished run is drawn in the success tone
 * and a broken one in the error tone, whatever provider it belongs to.
 *
 * Both halves matter. Keeping the accent for live and resting states is what
 * makes a provider recognisable at a glance, which is the whole point of
 * §5; overriding it for success and error is what stops a brand colour from
 * being able to make a failed run look fine.
 */
export function markColor(accentColor: string, tone: AgentVisualTone): string {
  if (tone === "good") return "var(--success)";
  if (tone === "bad") return "var(--destructive)";
  return accentColor;
}
