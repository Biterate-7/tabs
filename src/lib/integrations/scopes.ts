/**
 * What a connected AI client may do in Hubble, as data.
 *
 * Shared by the server (the authorization decision on every MCP call), the
 * OAuth consent page and the AI Integrations settings pane, so the words a
 * person reads when granting access and the rule the server enforces cannot
 * describe two different things.
 *
 * ## Two scopes, one of them always present
 *
 *   hubble.read    read the granted workspaces: collections, tabs, saved
 *                  project context, the connection's own activity
 *   hubble.write   additionally: save notes and project context, create
 *                  collections, add saved tabs to collections, and propose
 *                  reorganizations — which apply only after the person
 *                  approves them in Hubble
 *
 * Read is the default. Write is a separate, explicit choice made by the
 * person in Hubble (the consent page or Settings), never by the client: a
 * requested `scope` only preselects the consent page's control.
 *
 * Nothing in either scope deletes, runs a command, reads a file or fetches a
 * URL. There is no scope that would allow it.
 */

export const HUBBLE_SCOPES = ["hubble.read", "hubble.write"] as const;
export type HubbleScope = (typeof HUBBLE_SCOPES)[number];

export type PermissionLevel = "read" | "write";

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ["read", "write"] as const;

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === "read" || value === "write";
}

export function scopesFor(level: PermissionLevel): HubbleScope[] {
  return level === "write" ? ["hubble.read", "hubble.write"] : ["hubble.read"];
}

export function levelOf(scopes: readonly string[]): PermissionLevel {
  return scopes.includes("hubble.write") ? "write" : "read";
}

/** The scopes a valid grant may hold: read, alone or with write. Anything else is not a grant. */
export function isValidScopeSet(scopes: readonly string[]): scopes is HubbleScope[] {
  if (!scopes.includes("hubble.read")) return false;
  if (new Set(scopes).size !== scopes.length) return false;
  return scopes.every((scope) => (HUBBLE_SCOPES as readonly string[]).includes(scope));
}

/** A space-separated OAuth `scope` parameter, read as a hint. Unknown values are ignored, never granted. */
export function requestedLevel(scope: string | null | undefined): PermissionLevel {
  if (!scope) return "read";
  return scope.split(/\s+/).includes("hubble.write") ? "write" : "read";
}

export const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  read: "Read only",
  write: "Read and save",
};

export const PERMISSION_DESCRIPTION: Record<PermissionLevel, string> = {
  read: "Search and read the workspaces you choose: collections, saved tabs and saved project context. It cannot change anything.",
  write:
    "Everything in Read only, plus save notes and project context, create collections and add saved tabs to them. Reorganizing several collections is only proposed — it applies after you approve it in Hubble.",
};

/** What no connection can do, at any level. Shown on the consent page and in Settings. */
export const NEVER_ALLOWED = [
  "Delete projects, collections, tabs or notes",
  "Run commands or read files on your computer",
  "Open or fetch web addresses",
  "See projects you did not choose",
] as const;

/* ------------------------------------------------------------------ *
 * Which AI client a connection is
 * ------------------------------------------------------------------ */

export type IntegrationClient = "chatgpt" | "claude" | "gemini" | "grok" | "other";

export const INTEGRATION_CLIENTS: readonly IntegrationClient[] = ["chatgpt", "claude", "gemini", "grok", "other"] as const;

export function isIntegrationClient(value: unknown): value is IntegrationClient {
  return typeof value === "string" && (INTEGRATION_CLIENTS as readonly string[]).includes(value);
}

export const CLIENT_NAME: Record<IntegrationClient, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  other: "Another MCP client",
};

/**
 * Which client an OAuth redirect URI belongs to — for display only.
 *
 * Derived from the redirect host, which the authorization server verifies
 * exactly, rather than from the self-declared `client_name`, which anyone
 * registering a client can set to anything. A loopback redirect (a CLI on
 * this computer) is not attributed to any vendor: several tools use one.
 * Nothing is authorized on the strength of this answer.
 */
export function clientForRedirectUri(redirectUri: string): IntegrationClient {
  let host: string;
  try {
    host = new URL(redirectUri).hostname.toLowerCase();
  } catch {
    return "other";
  }
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (under("chatgpt.com") || under("openai.com")) return "chatgpt";
  if (under("claude.ai") || under("claude.com") || under("anthropic.com")) return "claude";
  if (under("gemini.google.com") || under("antigravity.google")) return "gemini";
  if (under("grok.com") || under("x.ai")) return "grok";
  return "other";
}
