import { defaultAgentVisualCatalog } from "./catalog";
import {
  getAgentVisualIdentity,
  hasAgentVisualIdentity,
  listAgentVisualIdentities,
  registerAgentVisualIdentity,
} from "./registry";
import type { AgentVisualIdentity } from "./types";

/**
 * The application's one seeded registry.
 *
 * The same shape as `connectors/app-manager.ts`: a lazy singleton that wires
 * the shipped catalogue into the generic registry the first time anything
 * asks for an identity. Every component goes through here, so there is no
 * ordering problem to get wrong — no provider needs an import side effect, no
 * surface has to remember to seed before it renders, and a test that wants an
 * empty registry can simply use `registry.ts` directly.
 *
 * Seeding is idempotent: `registerAgentVisualIdentity` replaces by id, so
 * running it twice produces one entry per provider rather than two.
 */

let seeded = false;

/**
 * Seeds the shipped catalogue, without overwriting anything already there.
 *
 * The "without overwriting" is the load-bearing half. Seeding is lazy, so it
 * happens at whatever moment something first asks for an identity — which may
 * be *after* a host has registered an override for a shipped provider. A seed
 * that replaced by id would silently undo that override, and the failure would
 * look like "my custom mark works sometimes", which is the worst kind.
 *
 * `registerAgentVisualIdentity` still replaces by id when called directly, so
 * an override registered at any point after this has run also wins. Either
 * order works, which is the point.
 */
function ensureSeeded(): void {
  if (seeded) return;
  for (const identity of defaultAgentVisualCatalog()) {
    if (hasAgentVisualIdentity(identity.id)) continue;
    registerAgentVisualIdentity(identity);
  }
  seeded = true;
}

/**
 * The identity for a provider. Never throws, never returns undefined.
 *
 * Takes a plain string because that is what the domain stores — see the note
 * on the lookup in ./registry.ts.
 */
export function agentVisualIdentity(provider: string | undefined | null): AgentVisualIdentity {
  ensureSeeded();
  return getAgentVisualIdentity(provider);
}

/** Every shipped identity, in catalogue order. Used by the settings legend. */
export function allAgentVisualIdentities(): AgentVisualIdentity[] {
  ensureSeeded();
  return listAgentVisualIdentities();
}

/**
 * Forgets that seeding happened.
 *
 * For tests that clear the registry and need the next call to re-seed it.
 * The application never calls this.
 */
export function resetAgentVisualIdentitySeeding(): void {
  seeded = false;
}
