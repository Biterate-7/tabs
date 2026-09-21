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
 * `connectors/catalog.ts` in every respect: the registry, the
 * components and the settings UI all work
 * against whatever they are handed, and this file is the one place that names
 * Claude Code, Codex, Gemini, Grok and Custom.
 *
 * Adding a provider means a new mark
 * and a new entry here. It does not mean touching the activity feed, the
 * agent cards or the settings UI, and
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
 * identity invents any: a provider that has observed nothing renders no runs
 * and no counts.
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
    },
    {
      id: "openai-codex",
      displayName: CODEX_DESCRIPTOR.displayName,
      icon: CodexMark,
      accentColor: ACCENTS.codex,
    },
    {
      id: "gemini",
      displayName: GEMINI_DESCRIPTOR.displayName,
      icon: GeminiMark,
      accentColor: ACCENTS.gemini,
    },
    {
      id: "grok",
      displayName: GROK_DESCRIPTOR.displayName,
      icon: GrokMark,
      accentColor: ACCENTS.grok,
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
    },
  ];
}
