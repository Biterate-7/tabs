import { UNKNOWN_AGENT_NAME, platformProvider } from "@/lib/agents/platform/catalog";
import { agentVisualIdentity } from "./app-identities";
import { hasAgentVisualIdentity } from "./registry";
import type { PlatformFeature } from "@/lib/agents/platform/catalog";
import type { AgentMarkComponent } from "./types";

/**
 * Who an agent is, on screen — the one answer every surface asks for.
 *
 *     AgentDisplayIdentity
 *     ├── providerId     "openai-codex"   (never shown)
 *     ├── displayName    "Codex"
 *     ├── shortName      "Codex"
 *     ├── brandName      "OpenAI"
 *     ├── icon           <CodexMark/>
 *     └── capabilities   chat · sessions · features
 *
 * The session list, the session header, the activity timeline, the handoff
 * dialog, agent history, the Action Inspector, Connect Agent and the landing
 * page's demo all name an agent through here, so "Codex" in one place cannot
 * be "OpenAI / Codex" in the next.
 *
 * ## Nothing is restated
 *
 * The names, brand and capabilities are the platform catalog's
 * (`platform/catalog.ts`, the provider registry); the mark and accent are the
 * visual registry's (`./app-identities.ts`), which reads its own names from
 * the same catalog. This module joins the two and adds no provider of its
 * own — adding a provider is still a catalog entry and a mark.
 *
 * ## An unknown provider is never shown by its id
 *
 * A session recorded by a build that knew a provider this one does not
 * arrives with an id like `cursor-agent`. That id is an internal key, so it
 * is not printed: the agent reads as "Unknown agent" with the generic mark,
 * and everything around it keeps working.
 *
 * A provider the catalog does not ship but a host registered a visual
 * identity for (`registerAgentVisualIdentity`, the extensibility seam) is
 * named by that registration — its own words, chosen on purpose.
 */
export type AgentDisplayIdentity = {
  /** The stored provider id. A key for lookups and marks — never rendered as text. */
  providerId: string;
  /** What the agent is called on every normal product surface. */
  displayName: string;
  /** The name where only a word fits — a logo strip, a compact chip. */
  shortName: string;
  /** The company behind it, for a secondary line ("OpenAI"). Empty when unknown. */
  brandName: string;
  icon: AgentMarkComponent;
  accentColor: string;
  capabilities: {
    /** Hubble can hold a conversation with it. */
    chat: boolean;
    /** Hubble will start sessions with it (and so can hand off to it). */
    sessions: boolean;
    features: readonly PlatformFeature[];
  };
  /** Whether this build ships the provider. */
  known: boolean;
};

export { UNKNOWN_AGENT_NAME };

export function agentIdentity(provider: string | undefined | null): AgentDisplayIdentity {
  const visual = agentVisualIdentity(provider);
  const spec = provider ? platformProvider(provider as Parameters<typeof platformProvider>[0]) : undefined;
  if (!spec) {
    const name = agentDisplayName(provider);
    return {
      providerId: provider ?? "",
      displayName: name,
      shortName: name,
      brandName: "",
      icon: visual.icon,
      accentColor: visual.accentColor,
      capabilities: { chat: false, sessions: false, features: [] },
      known: Boolean(provider && hasAgentVisualIdentity(provider)),
    };
  }
  return {
    providerId: spec.provider,
    displayName: spec.displayName,
    shortName: spec.shortName,
    brandName: spec.vendor,
    icon: visual.icon,
    accentColor: visual.accentColor,
    capabilities: { chat: spec.chat, sessions: spec.sessions.available, features: spec.features },
    known: true,
  };
}

/** The agent's name, as every product surface says it. Never a provider id. */
export function agentDisplayName(provider: string | undefined | null): string {
  const spec = provider ? platformProvider(provider as Parameters<typeof platformProvider>[0]) : undefined;
  if (spec) return spec.displayName;
  // A host-registered identity names itself; anything else is the registry's "Unknown agent".
  return provider && hasAgentVisualIdentity(provider) ? agentVisualIdentity(provider).displayName : UNKNOWN_AGENT_NAME;
}
