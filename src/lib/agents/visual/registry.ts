import { GenericAgentMark } from "./marks";
import type { AgentVisualIdentity, WorldCharacterConfig } from "./types";

/**
 * Who has a visual identity, and how anything else asks for one.
 *
 * The mechanism, not the contents. This file names no provider: it holds a
 * map, a fallback and a lookup, and `./catalog.ts` is the one module that
 * says which providers TabDump ships identities for — exactly mirroring the
 * split between `connectors/registry.ts` and `connectors/catalog.ts`, and for
 * exactly the same reason. A surface that wants to draw an agent asks here
 * and gets an identity; whether TabDump has ever heard of that provider is
 * not the caller's problem.
 *
 * ## The lookup never fails
 *
 * `getAgentVisualIdentity` takes a `string`, not an `AgentProviderId`, and
 * that is deliberate. The agent domain stores `Agent.provider` as an opaque
 * string it never interprets, so a run persisted by a build that knew about a
 * provider this build does not will arrive here as an unrecognised value.
 * Throwing on it would take down the panel that was trying to render a piece
 * of the user's real history. Instead it resolves to the fallback identity —
 * a plain mark and the provider's own id as its name — and the surrounding UI
 * carries on. Brief §31: a missing visual identity degrades to a static icon,
 * and agent functionality is unaffected.
 */

/**
 * The character an identity gets when it has not described one.
 *
 * The plainest of the four silhouettes at neutral scale with no tool. An
 * identity that says nothing about how it should look in the world still
 * appears in it — which is what makes `character` genuinely optional rather
 * than optional-until-you-open-the-world.
 */
export const DEFAULT_WORLD_CHARACTER: WorldCharacterConfig = {
  silhouette: "orb",
  scale: 1,
  accessory: "none",
};

/**
 * The identity used for anything unrecognised.
 *
 * Not an error state and not styled like one. An unknown provider is a
 * perfectly ordinary thing for a local-first app whose state outlives its
 * builds; it gets a neutral mark and its id for a name, and nothing about the
 * rendering suggests something has gone wrong.
 */
export const FALLBACK_VISUAL_IDENTITY: AgentVisualIdentity = {
  // `custom` is the catalogue's own name for "an agent TabDump did not ship",
  // which is what an unrecognised provider is.
  id: "custom",
  displayName: "Agent",
  icon: GenericAgentMark,
  // The app's own graph-node colour rather than a colour of its own: an
  // unknown provider has no brand to express, and inventing one would make
  // two different unknown providers look like the same product.
  accentColor: "var(--graph-node)",
  character: DEFAULT_WORLD_CHARACTER,
};

const identities = new Map<string, AgentVisualIdentity>();

/**
 * Adds or replaces one identity.
 *
 * Idempotent by id, so a catalogue that is seeded twice — which happens
 * whenever a test resets the registry between cases — produces one entry
 * rather than two. Replacing rather than rejecting is what allows a host
 * application to override a shipped identity without forking this file.
 */
export function registerAgentVisualIdentity(identity: AgentVisualIdentity): void {
  identities.set(identity.id, identity);
}

/**
 * Empties the registry.
 *
 * Exists for tests, which need to prove that an empty registry still renders
 * — the fallback path is a promise this layer makes, so it has to be
 * reachable. Not called by the application.
 */
export function clearAgentVisualIdentities(): void {
  identities.clear();
}

/**
 * The identity for a provider, always.
 *
 * `undefined`, an empty string and an unknown id all resolve to the fallback,
 * because all three are the same situation from a renderer's point of view:
 * there is an agent to draw and no identity for it.
 */
export function getAgentVisualIdentity(provider: string | undefined | null): AgentVisualIdentity {
  if (!provider) return FALLBACK_VISUAL_IDENTITY;
  const found = identities.get(provider);
  if (found) return found;

  // Carry the id through as the display name so an unrecognised provider is
  // still *identified* on screen. Falling back to the word "Agent" for
  // everything would make two unknown providers indistinguishable, which is
  // worse than showing a raw id.
  return { ...FALLBACK_VISUAL_IDENTITY, displayName: provider };
}

/** Whether this build ships an identity for a provider. Used by tests and by the settings legend. */
export function hasAgentVisualIdentity(provider: string): boolean {
  return identities.has(provider);
}

/** Every registered identity, in registration order. */
export function listAgentVisualIdentities(): AgentVisualIdentity[] {
  return [...identities.values()];
}
