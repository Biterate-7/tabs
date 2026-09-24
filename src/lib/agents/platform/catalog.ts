import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The agent connector platform's provider catalogue (Phase J).
 *
 * **The only provider-aware module in `lib/agents/platform/`.** Everything
 * else — the connection lifecycle, the connector, the roster, the chat model
 * — works against a `PlatformProvider` and never branches on which one it is.
 * Adding a provider is an entry here plus, on the server, a launch entry or a
 * control adapter. Nothing else changes.
 *
 * ## What an entry is, and what it is not
 *
 * An entry says how a person *connects* an agent: how TabDump reaches it and
 * how that agent signs in. It is not a capability claim — what an agent can
 * do comes from the runtime's own report of what its adapter declares, and a
 * UI that rendered this file as a feature list would be rendering a promise.
 *
 * `installCommand` is text for the user to run themselves. TabDump never
 * runs it: installing software is not something a web page on the user's
 * machine does for them.
 */

/** How TabDump talks to the agent. */
export type PlatformTransport =
  /** Through the provider's own SDK, in the runtime. */
  | "sdk"
  /** Over the Agent Client Protocol, as a local process the runtime starts. */
  | "acp"
  /** The agent is the client: it connects to TabDump's MCP server. TabDump starts nothing. */
  | "mcp";

/** How the agent signs in. TabDump never holds the agent's own login. */
export type PlatformSignIn =
  /** The agent's own sign-in, which TabDump can start through the protocol (ACP `authenticate`). */
  | { kind: "native"; summary: string }
  /** The user's own provider API key, stored encrypted by TabDump (Settings → AI connectors). */
  | { kind: "provider-key"; summary: string }
  /** A TabDump MCP access token, issued once in Settings for the agent's config. */
  | { kind: "mcp-token"; summary: string };

export type PlatformProvider = {
  provider: AgentProviderId;
  displayName: string;
  vendor: string;
  transport: PlatformTransport;
  signIn: PlatformSignIn;
  /**
   * The sentence for a runtime that can start this agent's own login when
   * `signIn` says otherwise — Claude Code in the desktop app (Phase J.1).
   */
  nativeSignInSummary?: string;
  /** One sentence: what connecting this agent gives you. */
  pitch: string;
  /** How to install it, for the user to run. Never run by TabDump. */
  installCommand?: string;
  docsUrl: string;
  /** Whether TabDump can hold a conversation with it. False for an MCP-only client. */
  chat: boolean;
};

export const PLATFORM_PROVIDERS: readonly PlatformProvider[] = [
  {
    provider: "claude-code",
    displayName: "Claude Code",
    vendor: "Anthropic",
    transport: "sdk",
    signIn: {
      kind: "provider-key",
      summary: "Runs on your own Anthropic API key, connected in Settings → AI connectors.",
    },
    nativeSignInSummary:
      "Signs in with your own Claude account through Claude Code's login. TabDump never sees or stores the token.",
    pitch: "Anthropic's coding agent, driven through the Claude Agent SDK with per-action approval.",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    chat: true,
  },
  {
    provider: "openai-codex",
    displayName: "Codex",
    vendor: "OpenAI",
    transport: "acp",
    signIn: {
      kind: "native",
      summary: "Signs in with your ChatGPT account through Codex's own login.",
    },
    pitch: "OpenAI's coding agent, over the Agent Client Protocol adapter.",
    installCommand: "npm install -g @agentclientprotocol/codex-acp",
    docsUrl: "https://github.com/agentclientprotocol/codex-acp",
    chat: true,
  },
  {
    provider: "gemini",
    displayName: "Gemini CLI",
    vendor: "Google",
    transport: "acp",
    signIn: {
      kind: "native",
      summary: "Signs in with your Google account through Gemini CLI's own login.",
    },
    pitch: "Google's open-source coding agent, over its built-in Agent Client Protocol mode.",
    installCommand: "npm install -g @google/gemini-cli",
    docsUrl: "https://geminicli.com/docs/cli/acp-mode/",
    chat: true,
  },
  {
    provider: "grok",
    displayName: "Grok Build",
    vendor: "xAI",
    transport: "acp",
    signIn: {
      kind: "native",
      summary: "Signs in through Grok Build's own login on first use.",
    },
    pitch: "xAI's coding agent, over its built-in Agent Client Protocol mode.",
    installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
    docsUrl: "https://docs.x.ai/build/overview",
    chat: true,
  },
  {
    provider: "custom",
    displayName: "Custom MCP agent",
    vendor: "Any MCP client",
    transport: "mcp",
    signIn: {
      kind: "mcp-token",
      summary: "Connects to TabDump's read-only MCP server with an access token you issue in Settings.",
    },
    pitch: "Any agent that speaks MCP can read your TabDump workspaces. TabDump never starts it.",
    docsUrl: "https://modelcontextprotocol.io",
    chat: false,
  },
] as const;

export function platformProvider(provider: AgentProviderId): PlatformProvider | undefined {
  return PLATFORM_PROVIDERS.find((entry) => entry.provider === provider);
}
