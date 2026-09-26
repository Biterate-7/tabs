/**
 * The one generator for every persistent entity id in Hubble — workspaces,
 * tabs, sections, groups, collections.
 *
 * Ids used to be `<prefix>-<epoch_ms>-<counter>` from a module-scoped
 * counter, which had two defects that only matter once ids leave the device:
 *
 *  - the counter restarted at 0 on every page load, so the first id minted
 *    in any session on any device was always `<prefix>-<ms>-1`. Two devices
 *    creating their first workspace in the same millisecond produced the
 *    same id.
 *  - `src/lib/tabs/parse.ts` kept a SECOND counter emitting the identical
 *    `tab-<ms>-<n>` shape, so a collision was reachable on one device too.
 *
 * Ids are opaque: nothing in the codebase parses one, and the entity type is
 * always known from the object holding it, so the old prefixes carried no
 * information and are gone. Existing stored ids in the old format keep
 * working untouched — this changes what is minted next, not what is saved
 * (see the compatibility note in src/lib/workspace/json-import.ts).
 */

/**
 * `crypto.randomUUID` is restricted to secure contexts. https deployments,
 * `http://localhost` during development, and the desktop app's
 * `http://tauri.localhost` all qualify, so it is the path taken essentially
 * everywhere.
 *
 * The exception this guards is a self-hosted Hubble served over plain http
 * on a non-localhost host — a deployment shape src/lib/auth/origin.ts
 * already explicitly supports. There `randomUUID` is simply absent, and
 * falling back to a timestamp and a counter would quietly reintroduce the
 * collisions this file exists to remove. `crypto.getRandomValues` carries no
 * secure-context restriction, so the fallback is the same CSPRNG assembled
 * into the same RFC 4122 v4 layout — identical entropy, no weaker guarantee.
 *
 * If neither exists, this throws rather than degrading: an id that only
 * looks unique is worse than a loud failure, because the damage would show
 * up later as two devices silently sharing a workspace row.
 */
function randomUuidV4(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error(
      "Hubble needs Web Crypto to generate ids. Serve the app over https (or localhost)."
    );
  }

  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

  const hex: string[] = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

/** A fresh, opaque, globally collision-resistant id for a persistent entity. */
export function createId(): string {
  return randomUuidV4();
}
