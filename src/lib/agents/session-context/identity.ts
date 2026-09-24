/**
 * The name a session's TabDump context server goes by (Phase J.4).
 *
 * ## Why every session gets its own
 *
 * An agent knows its MCP servers by name, and that name is the one thing
 * about a tool call an agent reliably carries: Claude calls a tool
 * `mcp__<server>__<tool>`, and Gemini scopes its MCP allowlist by server name.
 * A fixed name ("tabdump") would be a name anyone could also give a server —
 * in the user's own agent settings, in an extension, in an administrator's
 * required configuration — and some agents merge or override same-named
 * servers rather than refuse them. A name minted per session from 80 random
 * bits cannot have been configured anywhere before the session existed, so
 * nothing but TabDump's own server can answer to it.
 *
 * The name is an identity, not a credential: it is not secret and appears on
 * an agent's command line where a launch needs it. What proves a request may
 * *use* the server is still the bearer credential (./registry.ts), which never
 * appears there.
 */

export const CONTEXT_SERVER_NAME_PREFIX = "tabdump_";

/** `tabdump_` + 16 lowercase base32 characters. Short enough for every agent's tool-name limit. */
export const CONTEXT_SERVER_NAME_PATTERN = /^tabdump_[a-z2-7]{16}$/;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function mintContextServerName(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${CONTEXT_SERVER_NAME_PREFIX}${out}`;
}

export function isContextServerName(value: unknown): value is string {
  return typeof value === "string" && CONTEXT_SERVER_NAME_PATTERN.test(value);
}
