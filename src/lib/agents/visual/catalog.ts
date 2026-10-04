import { platformProvider } from "@/lib/agents/platform/catalog";
import {
  ClaudeCodeMark,
  CodexMark,
  CustomAgentMark,
  GeminiMark,
  GrokMark,
} from "./marks";
import type { AgentVisualIdentity } from "./types";

/**
 * Which providers Hubble ships a visual identity for.
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
 * Every `displayName` below is read from the platform catalog — the provider
 * registry every product surface names agents from (see ./identity.ts) —
 * rather than written out again. Two independently-typed copies of a name
 * drift the first time one is edited: this file once read "OpenAI / Codex"
 * from a second table while the session list said "Codex".
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
/** The catalog's name for a provider Hubble ships. */
function nameOf(provider: Parameters<typeof platformProvider>[0]): string {
  return platformProvider(provider)?.displayName ?? provider;
}

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
      displayName: nameOf("claude-code"),
      icon: ClaudeCodeMark,
      accentColor: ACCENTS.claudeCode,
    },
    {
      id: "openai-codex",
      displayName: nameOf("openai-codex"),
      icon: CodexMark,
      accentColor: ACCENTS.codex,
    },
    {
      id: "gemini",
      displayName: nameOf("gemini"),
      icon: GeminiMark,
      accentColor: ACCENTS.gemini,
    },
    {
      id: "grok",
      displayName: nameOf("grok"),
      icon: GrokMark,
      accentColor: ACCENTS.grok,
    },
    {
      id: "custom",
      displayName: nameOf("custom"),
      icon: CustomAgentMark,
      // No accent of its own: a custom agent belongs to whoever brought it,
      // and inventing a brand colour for someone else's integration would be
      // the one piece of this system that was decoration rather than
      // identification.
      accentColor: "var(--graph-node)",
    },
  ];
}
