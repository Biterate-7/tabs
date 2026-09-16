import {
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CUSTOM_DESCRIPTOR,
  GEMINI_DESCRIPTOR,
  GROK_DESCRIPTOR,
} from "@/lib/agents/connectors/catalog";
import {
  ClaudeCodeMark,
  CodexMark,
  CustomAgentMark,
  GeminiMark,
  GrokMark,
} from "./marks";
import type { AgentVisualIdentity } from "./types";

/**
 * Which providers TabDump ships a visual identity for.
 *
 * **The only provider-aware module in the visual layer**, and the mirror of
 * `connectors/catalog.ts` in every respect: the registry, the animation
 * engine, the components, the world engine and the settings UI all work
 * against whatever they are handed, and this file is the one place that names
 * Claude Code, Codex, Gemini, Grok and Custom.
 *
 * That is the property brief §23 asks for. Adding a provider means a new mark
 * and a new entry here. It does not mean touching the Agent World, the
 * activity feed, the execution UI, the agent cards or the settings UI, and
 * `visual/extensibility.test.ts` holds that claim to a mechanical check
 * rather than to good intentions.
 *
 * ## Display names are not restated here
 *
 * Every `displayName` below is read from the connector descriptor rather than
 * written out again. Two independently-typed copies of "OpenAI / Codex" would
 * drift the first time one was edited, and the settings page and the world
 * would then disagree about what the same agent is called.
 *
 * ## Identities exist for providers that cannot be observed yet
 *
 * Codex, Gemini and Grok are registered, `NO_CAPABILITIES`, and honestly
 * unavailable. They still get full identities, because an identity is not a
 * claim that something is working — it is how the settings list, the
 * connector picker and the empty states name a provider the user can read
 * about and choose. What they never get is *data*, and no amount of visual
 * identity invents any: a provider that has observed nothing renders no runs,
 * no characters and no counts.
 */

/**
 * Accent colours.
 *
 * Mid-saturation on purpose, so each one holds up against both the dark
 * default theme and the light ones without a per-theme table. They are
 * identity hints and never status: `AgentIcon` draws a failing agent in the
 * error tone whatever accent its identity carries, because a brand colour
 * must not be able to make a broken run look fine.
 */
const ACCENTS = {
  claudeCode: "#d0784f",
  codex: "#4fae8f",
  gemini: "#5b8dee",
  grok: "#9b7fe0",
} as const;

export function defaultAgentVisualCatalog(): AgentVisualIdentity[] {
  return [
    {
      id: "claude-code",
      displayName: CLAUDE_CODE_DESCRIPTOR.displayName,
      icon: ClaudeCodeMark,
      accentColor: ACCENTS.claudeCode,
      // The only provider with a real reader behind it, so it is the only one
      // whose animations were tuned against actual observed sessions rather
      // than against a mock.
      animations: {
        working: { keyframes: "agent-work", durationMs: 1600, iterations: "infinite" },
        thinking: { keyframes: "agent-think", durationMs: 2600, iterations: "infinite" },
      },
      character: { silhouette: "beacon", scale: 1, accessory: "terminal" },
    },
    {
      id: "openai-codex",
      displayName: CODEX_DESCRIPTOR.displayName,
      icon: CodexMark,
      accentColor: ACCENTS.codex,
      animations: {
        working: { keyframes: "agent-work-lattice", durationMs: 2200, iterations: "infinite" },
      },
      character: { silhouette: "prism", scale: 1, accessory: "spark" },
    },
    {
      id: "gemini",
      displayName: GEMINI_DESCRIPTOR.displayName,
      icon: GeminiMark,
      accentColor: ACCENTS.gemini,
      animations: {
        working: { keyframes: "agent-work-twin", durationMs: 2000, iterations: "infinite" },
      },
      character: { silhouette: "prism", scale: 0.98, accessory: "lens" },
    },
    {
      id: "grok",
      displayName: GROK_DESCRIPTOR.displayName,
      icon: GrokMark,
      accentColor: ACCENTS.grok,
      animations: {
        working: { keyframes: "agent-work-climb", durationMs: 1900, iterations: "infinite" },
      },
      character: { silhouette: "chevron", scale: 0.96, accessory: "spark" },
    },
    {
      id: "custom",
      displayName: CUSTOM_DESCRIPTOR.displayName,
      icon: CustomAgentMark,
      // No accent of its own: a custom agent belongs to whoever brought it,
      // and inventing a brand colour for someone else's integration would be
      // the one piece of this system that was decoration rather than
      // identification.
      accentColor: "var(--graph-node)",
      character: { silhouette: "orb", scale: 0.94, accessory: "none" },
    },
  ];
}
