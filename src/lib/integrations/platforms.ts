import type { IntegrationClient } from "./scopes";

/**
 * Which AI products can use Hubble, how, and how sure we are — as data.
 *
 * ## Verified, not assumed
 *
 * Every row records what the vendor's own documentation said on
 * `VERIFIED_ON`, with the page it came from. A product sharing MCP with
 * another is not evidence that it supports the same setup: the Gemini CLI
 * and the Gemini app, or Grok's API and grok.com, are separate rows with
 * separate requirements because their documentation says different things.
 *
 * ## Two different claims, kept apart
 *
 *   hubble       what Hubble implements for this path ("ready" means the
 *                endpoint, authentication and tools it needs exist)
 *   verification how that path was exercised:
 *                  "protocol"  Hubble's own tests drove it with the official
 *                              MCP SDK client over the real HTTP and OAuth
 *                              wire format — not the vendor's product
 *                  "client"    a person connected the vendor's product itself
 *                              and called a tool
 *
 * No row says "client" until that has actually happened, and the settings
 * pane shows this field instead of a green tick.
 *
 * The registry is read by the settings pane and the setup snippets
 * (./setup.ts). It authorizes nothing: every connection, whatever product it
 * came from, goes through the same grant and the same server-side checks.
 */

export const VERIFIED_ON = "2026-10-12";

export type PlatformSurfaceId =
  | "chatgpt"
  | "claude-connector"
  | "claude-code"
  | "claude-desktop-config"
  | "gemini-app"
  | "gemini-cli"
  | "antigravity"
  | "grok-app"
  | "grok-api"
  | "grok-cli";

/** How the product reaches Hubble. */
export type ConnectionMode =
  /** The product connects to Hubble's public HTTPS endpoint itself and signs in with OAuth. */
  | "remote-oauth"
  /** The product connects to Hubble's endpoint with a token the person pastes into its config. */
  | "remote-token"
  /** The product starts a local process (stdio) that relays to Hubble's endpoint with a token. */
  | "local-bridge";

export type PlatformSurface = {
  id: PlatformSurfaceId;
  client: IntegrationClient;
  /** The product as its vendor names it. */
  product: string;
  kind: "app" | "developer-tool" | "api";
  modes: readonly ConnectionMode[];
  /** The mode the setup guide leads with. */
  recommended: ConnectionMode;
  transport: string;
  authentication: string;
  read: boolean;
  /** Whether the product can call Hubble's write tools at all, and what it asks the person first. */
  write: { supported: boolean; note: string };
  /** Plan, account, region or admin requirements, in the vendor's terms. */
  requirements: readonly string[];
  limitations: readonly string[];
  /** Short, ordered setup steps. Snippets for the token modes come from ./setup.ts. */
  steps: readonly string[];
  docs: string;
  verifiedOn: string;
  hubble: "ready" | "not-supported";
  verification: "protocol" | "client" | "none";
  /**
   * What happened when the vendor's own product was connected, capability by
   * capability. Absent until someone has tried. "client" verification means
   * at least the read test passed here; each other capability says its own
   * result, so a product verified for reads is never shown as verified for writes.
   */
  clientTests?: ClientTestRecord;
};

export type ClientTestStatus = "pass" | "fail" | "blocked" | "not_run";

export type ClientTestRecord = {
  date: string;
  /** The vendor product and version actually used, and how it connected. */
  setup: string;
  read: ClientTestStatus;
  write: ClientTestStatus;
  approval: ClientTestStatus;
  revocation: ClientTestStatus;
  /** Why anything is blocked or failed, in the vendor's words where possible. */
  note?: string;
};

export const CLIENT_TEST_LABEL: Record<ClientTestStatus, string> = {
  pass: "passed",
  fail: "failed",
  blocked: "blocked by the vendor",
  not_run: "not tested",
};

export const PLATFORM_SURFACES: readonly PlatformSurface[] = [
  {
    id: "chatgpt",
    client: "chatgpt",
    product: "ChatGPT (developer mode apps)",
    kind: "app",
    modes: ["remote-oauth"],
    recommended: "remote-oauth",
    transport: "Streamable HTTP (SSE also accepted by ChatGPT)",
    authentication: "OAuth 2.1 with PKCE (S256). Hubble supports Dynamic Client Registration; ChatGPT registers itself.",
    read: true,
    write: {
      supported: true,
      note: "ChatGPT asks you to confirm each write action by default. Hubble still checks the connection's permission on every call.",
    },
    requirements: [
      "Developer mode is offered on Plus, Pro, Business, Enterprise and Edu accounts, on the web only.",
      "On Business, Enterprise and Edu workspaces an admin may have to allow developer mode or custom apps.",
      "Free accounts cannot add a custom MCP app.",
    ],
    limitations: [
      "Set up from chatgpt.com on the web; the app then appears in the composer's developer-mode tool menu.",
      "After Hubble adds tools, refresh the app in ChatGPT's app settings to see them.",
      "Publishing Hubble as a listed ChatGPT app is a separate review process and has not been done.",
    ],
    steps: [
      "In ChatGPT on the web, open Settings → Apps → Advanced settings and turn on Developer mode.",
      "Create an app: name it Hubble and paste the MCP server URL shown here.",
      "Choose OAuth as the authentication method and create the app.",
      "ChatGPT opens Hubble: sign in, choose workspaces and a permission level, and approve.",
      "Start a chat, pick Hubble from the developer-mode tools, and ask about your workspace.",
    ],
    docs: "https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt",
    verifiedOn: VERIFIED_ON,
    hubble: "ready",
    verification: "protocol",
  },
  {
    id: "claude-connector",
    client: "claude",
    product: "Claude custom connectors (claude.ai, Claude Desktop, Claude mobile)",
    kind: "app",
    modes: ["remote-oauth"],
    recommended: "remote-oauth",
    transport: "Streamable HTTP (SSE for URLs ending in /sse)",
    authentication: "OAuth. Choose \"Register automatically\" (Dynamic Client Registration). Hubble does not yet accept Claude's published client identity (CIMD).",
    read: true,
    write: {
      supported: true,
      note: "Claude asks before using a tool unless you allow it. Hubble still checks the connection's permission on every call.",
    },
    requirements: [
      "Free, Pro, Max, Team and Enterprise plans. Free accounts may add one custom connector.",
      "On Team and Enterprise, an owner adds the connector for the organization; each member then signs in.",
    ],
    limitations: [
      "A connector's authentication settings cannot be changed after it is added — remove it and add it again.",
      "A connector added on claude.ai is also available in Claude Desktop and mobile; this is separate from Claude Desktop's local config file.",
    ],
    steps: [
      "In Claude, open Settings → Connectors → Add custom connector.",
      "Name it Hubble and paste the MCP server URL shown here.",
      "Under OAuth client, choose Register automatically, then add it.",
      "Press Connect: sign in to Hubble, choose workspaces and a permission level, and approve.",
      "In a chat, enable Hubble from the tools menu and ask about your workspace.",
    ],
    docs: "https://support.claude.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers",
    verifiedOn: VERIFIED_ON,
    hubble: "ready",
    verification: "protocol",
  },
  {
    id: "claude-code",
    client: "claude",
    product: "Claude Code (CLI)",
    kind: "developer-tool",
    modes: ["remote-token", "remote-oauth"],
    recommended: "remote-token",
    transport: "Streamable HTTP",
    authentication: "A Hubble token in an Authorization header, or OAuth through /mcp.",
    read: true,
    write: { supported: true, note: "Claude Code asks before each tool call unless you allow it." },
    requirements: ["Claude Code installed on this computer."],
    limitations: ["Configured per machine (or per project with --scope project)."],
    steps: ["Create a token connection below.", "Run the command shown, or point Claude Code at the JSON config shown, then /mcp in Claude Code to check it."],
    docs: "https://docs.claude.com/en/docs/claude-code/mcp",
    verifiedOn: VERIFIED_ON,
    hubble: "ready",
    verification: "client",
    clientTests: {
      date: "2026-10-13",
      setup: "Claude Code 2.1.229 (claude.ai Pro account), personal token through an MCP JSON config (--mcp-config), against Hubble on a local server with a throwaway database",
      read: "pass",
      write: "pass",
      approval: "pass",
      revocation: "pass",
      note: "The claude mcp add command shown is from Claude Code's documentation; the test used the equivalent JSON config.",
    },
  },
  {
    id: "claude-desktop-config",
    client: "claude",
    product: "Claude Desktop local config (claude_desktop_config.json)",
    kind: "developer-tool",
    modes: ["local-bridge"],
    recommended: "local-bridge",
    transport: "stdio, relayed to Hubble over HTTPS by scripts/tabdump-mcp-bridge.mjs",
    authentication: "A Hubble token in the bridge's environment.",
    read: true,
    write: { supported: true, note: "Claude Desktop asks before each tool call unless you allow it." },
    requirements: ["Node 18+ and a checkout of the Hubble repository (the bridge resolves the MCP SDK from it)."],
    limitations: [
      "Prefer the custom connector above: it needs no repository, no token and no config file.",
      "Edits to the config file need a Claude Desktop restart.",
    ],
    steps: [
      "Create a token connection below.",
      "Claude Desktop → Settings → Developer → Edit Config, and merge in the snippet shown.",
      "Quit and reopen Claude Desktop.",
    ],
    docs: "https://modelcontextprotocol.io/quickstart/user",
    verifiedOn: VERIFIED_ON,
    hubble: "ready",
    verification: "protocol",
  },
  {
    id: "gemini-app",
    client: "gemini",
    product: "Gemini app (gemini.google.com custom apps)",
    kind: "app",
    modes: ["remote-oauth"],
    recommended: "remote-oauth",
    transport: "Streamable HTTP (standard MCP)",
    authentication: "OAuth with Dynamic Client Registration, which Hubble supports — no extra settings needed.",
    read: true,
    write: { supported: true, note: "Gemini requires manual confirmation for every write action." },
    requirements: [
      "18 or over and in the US.",
      "A personal Google Account — not available with a work or school account.",
      "Keep Activity turned on; custom apps are unavailable when it is off.",
      "English only.",
    ],
    limitations: [
      "Custom apps can only be added in the Gemini web app; once added they also work in the Gemini mobile app.",
      "Gemini Business and Enterprise use an admin-managed connector setup that has not been tested with Hubble.",
    ],
    steps: [
      "On gemini.google.com, open Settings → Connected Apps.",
      "Under Custom apps, add an app and paste the MCP server URL shown here, then Next.",
      "Gemini opens Hubble: sign in, choose workspaces and a permission level, and approve.",
    ],
    docs: "https://support.google.com/gemini/answer/17209137",
    verifiedOn: VERIFIED_ON,
    hubble: "ready",
    verification: "protocol",
  },
  {
    id: "gemini-cli",
    client: "gemini",
    product: "Gemini CLI",
    kind: "developer-tool",
    modes: ["remote-token", "remote-oauth"],
    recommended: "remote-token",
    transport: "Streamable HTTP (httpUrl)",
    authentication:
      "A Hubble token in headers, or OAuth discovered automatically (callback on http://localhost:7777/oauth/callback, run /mcp auth hubble).",
    read: true,
    write: {
      supported: true,
      note: "Gemini CLI confirms each tool call unless the server is marked trust: true — leave it off for Hubble.",
    },
    requirements: ["Gemini CLI installed on this computer."],
    limitations: [
      "OAuth needs a browser on the same machine; use a token for SSH sessions and containers.",
      "Hubble's other Gemini integration — starting Gemini from Hubble's Command Centre — is separate and unchanged.",
    ],
    steps: ["Create a token connection below.", "Run the command shown (or merge the settings.json snippet), then /mcp to check it."],
    docs: "https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html",
    verifiedOn: VERIFIED_ON,
    hubble: "ready",
    verification: "protocol",
    clientTests: {
      date: "2026-10-13",
      setup: "Gemini CLI 0.63.0 signed in with a personal Google account",
      read: "blocked",
      write: "blocked",
      approval: "blocked",
      revocation: "blocked",
      note: "Google refused the account before any tool ran: \u201cThis client is no longer supported for Gemini Code Assist for individuals\u201d. A Gemini API key or a Workspace account may still work; not tested.",
    },
  },
  {
    id: "antigravity",
    client: "gemini",
    product: "Google Antigravity",
    kind: "developer-tool",
    modes: ["remote-token"],
    recommended: "remote-token",
    transport: "Streamable HTTP (serverUrl)",
    authentication: "A Hubble token in headers.",
    read: true,
    write: { supported: true, note: "Antigravity asks before running a tool that has no configured permission." },
    requirements: ["Antigravity installed on this computer."],
    limitations: ["Antigravity reads serverUrl, not url. The config file location differs between versions; check its MCP settings page."],
    steps: ["Create a token connection below.", "Add the snippet to mcp_config.json from Antigravity's MCP settings."],
    docs: "https://antigravity.google/docs/mcp",
    verifiedOn: VERIFIED_ON,
    hubble: "ready",
    verification: "protocol",
  },
  {
    id: "grok-app",
    client: "grok",
    product: "Grok custom connectors (grok.com)",
    kind: "app",
    modes: ["remote-oauth"],
    recommended: "remote-oauth",
    transport: "Remote MCP over the public internet",
    authentication: "OAuth. Reports indicate Grok's dialog uses PKCE with Dynamic Client Registration, which Hubble supports.",
    read: true,
    write: { supported: true, note: "xAI's documentation does not describe write confirmations. Hubble checks the connection's permission on every call." },
    requirements: [
      "xAI's documentation says connectors are available to all Grok users; some reports say custom connectors need a paid plan.",
      "On Business and Enterprise, a team admin must provision the connector first.",
    ],
    limitations: ["The server must be reachable over the public internet — Hubble's deployment is."],
    steps: [
      "Open grok.com/connectors, choose New Connector → Custom.",
      "Paste the MCP server URL shown here and continue.",
      "Grok opens Hubble: sign in, choose workspaces and a permission level, and approve.",
    ],
    docs: "https://docs.x.ai/grok/connectors",
    verifiedOn: VERIFIED_ON,
    hubble: "ready",
    verification: "protocol",
  },
  {
    id: "grok-api",
    client: "grok",
    product: "xAI API (Remote MCP tools)",
    kind: "api",
    modes: ["remote-token"],
    recommended: "remote-token",
    transport: "Streamable HTTP or SSE",
    authentication: "A Hubble token sent as the tool's authorization value.",
    read: true,
    write: {
      supported: true,
      note: "Your code decides. Restrict allowed_tools to Hubble's read tools unless you mean to write.",
    },
    requirements: ["An xAI API key, used with the Responses API or the xAI SDK."],
    limitations: ["require_approval and connector_id are not supported by xAI's Responses API."],
    steps: ["Create a token connection below.", "Add the mcp tool entry shown to your Responses API request."],
    docs: "https://docs.x.ai/developers/tools/remote-mcp",
    verifiedOn: VERIFIED_ON,
    hubble: "ready",
    verification: "protocol",
  },
  {
    id: "grok-cli",
    client: "grok",
    product: "Grok CLI (Grok Build)",
    kind: "developer-tool",
    modes: ["remote-token"],
    recommended: "remote-token",
    transport: "Streamable HTTP",
    authentication: "A Hubble token as an HTTP header (grok mcp add … -H).",
    read: true,
    write: { supported: true, note: "Grok CLI asks before running a tool unless a permission rule allows it." },
    requirements: ["Grok CLI installed and signed in to xAI.", "Free accounts have a usage limit; SuperGrok raises it."],
    limitations: [
      "A server added with --scope project only starts in a folder Grok trusts (grok --trust, or trust the folder).",
      "Grok CLI's built-in file and terminal tools stay available alongside Hubble; restrict them with --disallowed-tools if you want Hubble only.",
    ],
    steps: ["Create a token connection below.", "Run the command shown, then grok mcp doctor to check it."],
    docs: "https://docs.x.ai/developers/tools/remote-mcp",
    verifiedOn: "2026-10-13",
    hubble: "ready",
    verification: "client",
    clientTests: {
      date: "2026-10-13",
      setup: "Grok CLI 1.0.46 (grok-4.7, free account), personal token through grok mcp add --scope project, against Hubble on a local server with a throwaway database",
      read: "pass",
      write: "blocked",
      approval: "blocked",
      revocation: "blocked",
      note: "After the read test, xAI stopped the account: \u201cYou\u2019ve reached your free Grok Build usage limit for now\u201d. Write, approval and revocation were not reached.",
    },
  },
] as const;

export function platformSurface(id: PlatformSurfaceId): PlatformSurface {
  const found = PLATFORM_SURFACES.find((surface) => surface.id === id);
  if (!found) throw new Error(`Unknown platform surface: ${id}`);
  return found;
}

export function surfacesFor(client: IntegrationClient): PlatformSurface[] {
  return PLATFORM_SURFACES.filter((surface) => surface.client === client);
}

export const VERIFICATION_LABEL: Record<PlatformSurface["verification"], string> = {
  protocol: "Tested with the MCP protocol client, not yet with this product",
  client: "Tested with this product",
  none: "Not tested",
};
