import type { AgentProviderId } from "./types";

/**
 * Secrets, for the life of one tab and no longer.
 *
 * ## Why this exists at all
 *
 * Claude Code needs no credential: it is observed by reading files that
 * already belong to the user on the machine they are sitting at. Every other
 * provider Hubble might one day observe is reached over a network and would
 * need one. So the question is not whether to store a secret — it is what to
 * do when a provider asks for one in an environment that cannot keep it.
 *
 * ## What the platform can actually promise
 *
 * In the browser build: nothing durable. `localStorage`, `sessionStorage`,
 * IndexedDB and cookies without `HttpOnly` are all readable by any script on
 * the origin, survive across sessions, and sit in a profile directory that
 * other software on the machine can read. There is no browser API that gives
 * a web app an encrypted secret store. The desktop build has an OS keychain
 * available in principle, but Hubble's Tauri capabilities do not grant
 * access to one today (see src-tauri/ and docs/desktop-architecture.md), and
 * widening native permissions to make a connector feel more finished would
 * trade a real security boundary for a cosmetic one.
 *
 * So Hubble does not persist secrets. It holds them in this module — a plain
 * variable in the page's memory — where they die with the tab. A connector
 * configured this way is honestly labelled *configured for this session*
 * rather than connected, and the user re-enters it next time. That is a worse
 * experience and a much better promise, and the one thing this phase must not
 * do is invent a security guarantee the platform cannot keep.
 *
 * ## The rules this module enforces structurally
 *
 * - Values live in a module-scoped Map. Nothing writes them to storage,
 *   because nothing here imports storage.
 * - `get` exists but nothing in the connector layer calls it except the
 *   provider that owns the secret, at the moment it builds a request.
 * - There is no `list`, no `entries`, no `toJSON` and no iteration: a secret
 *   can be fetched by the provider that put it there and otherwise cannot be
 *   enumerated, so no export, log line or debug dump can sweep them up.
 * - `describe` is what the UI renders — presence and length, never the value.
 *
 * `connectors/security.test.ts` pins all of it.
 */

const secrets = new Map<AgentProviderId, string>();

/** Whether a secret has been supplied for this provider in this tab. */
export function hasSessionCredential(provider: AgentProviderId): boolean {
  return secrets.has(provider);
}

/**
 * Stores a secret for the life of the tab.
 *
 * An empty or whitespace-only value clears rather than stores, so "the user
 * emptied the field" and "the user cleared the credential" are the same
 * action and cannot drift apart.
 */
export function setSessionCredential(provider: AgentProviderId, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    secrets.delete(provider);
    return;
  }
  secrets.set(provider, trimmed);
}

/**
 * The secret, for the provider that owns it.
 *
 * The single reader. A caller that is not the provider building its own
 * request has no business here, and the absence of any bulk accessor is what
 * keeps that from being merely a convention.
 */
export function getSessionCredential(provider: AgentProviderId): string | undefined {
  return secrets.get(provider);
}

export function clearSessionCredential(provider: AgentProviderId): void {
  secrets.delete(provider);
}

/** Drops every secret. Called on sign-out and on connector-layer teardown. */
export function clearAllSessionCredentials(): void {
  secrets.clear();
}

/**
 * What the UI is allowed to know about a secret.
 *
 * Presence and length — enough to render "Configured for this session" and a
 * row of dots of a plausible width, and not enough to reconstruct anything.
 * Deliberately not a masked prefix: showing the first four characters of a
 * key is a habit borrowed from services that can revoke them, and Hubble
 * cannot.
 */
export type SessionCredentialDescription = {
  present: boolean;
  length: number;
};

export function describeSessionCredential(
  provider: AgentProviderId
): SessionCredentialDescription {
  const value = secrets.get(provider);
  return { present: value !== undefined, length: value?.length ?? 0 };
}
