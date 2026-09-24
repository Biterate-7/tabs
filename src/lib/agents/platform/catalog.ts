import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The agent connector platform's provider registry (Phase J, completed in J.2).
 *
 * **The only provider-aware module in `lib/agents/platform/`.** Everything
 * else — the connection lifecycle, the connector, the roster, the chat model,
 * the Connect Agent dialog — works against a `PlatformProvider` and never
 * branches on which one it is. Adding a provider is an entry here plus, on the
 * server, a launch entry or a control adapter. Nothing else changes.
 *
 * ## What an entry is, and what it is not
 *
 * An entry says how a person *connects* an agent: how TabDump reaches it, how
 * that agent signs in, where it can work, and what TabDump does with it once
 * connected. It is not the last word on any of that — the runtime reports
 * what is installed, whether the agent is signed in, and what its adapter
 * actually declares, and the lifecycle (./lifecycle.ts) believes the runtime
 * over this file wherever they differ.
 *
 * `sessions` is the one field that mirrors a security decision made on the
 * server: an agent TabDump cannot hold to its approvals (the launch
 * allowlist's `approval: "unavailable"`) gets no session there regardless of
 * what this says. It is repeated here so the UI can say *why* before anyone
 * tries, and `platform/registry.test.ts` fails if the two ever disagree.
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

/** Where TabDump itself is running. */
export type PlatformSurface = "web" | "desktop";

/** What TabDump does with an agent once it is connected. Shown when connecting; confirmed by the runtime. */
export type PlatformFeature =
  | "chat"
  | "streaming"
  | "approvals"
  | "project_files"
  | "workspace_context"
  | "read_tabdump";

export const PLATFORM_FEATURE_LABEL: Record<PlatformFeature, string> = {
  chat: "Chat in TabDump",
  streaming: "Replies stream as they are written",
  approvals: "Asks you before it changes a file or runs a command",
  project_files: "Works in a project folder you choose",
  workspace_context: "Sees the TabDump workspace you attach",
  read_tabdump: "Reads your TabDump workspaces, read-only",
};

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
  /**
   * Whether TabDump will start sessions with it, and if not, the one sentence
   * that says why. Enforced on the server; see the header.
   */
  sessions: { available: true } | { available: false; reason: string };
  /** Where this connector can work at all. */
  surfaces: readonly PlatformSurface[];
  /** Why it cannot work on a surface it is absent from. One sentence per surface. */
  unavailableOn?: Partial<Record<PlatformSurface, string>>;
  /** What TabDump does with it once connected. */
  features: readonly PlatformFeature[];
  /**
   * Exactly what connecting it means, for a connector the user wires up
   * themselves. Plain sentences; the custom agent is the one that needs them.
   */
  explainer?: readonly string[];
};

/** What every agent TabDump drives in a session offers. The same list for each, because it is the same code. */
const SESSION_FEATURES: readonly PlatformFeature[] = [
  "chat",
  "streaming",
  "approvals",
  "project_files",
  "workspace_context",
];

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
    sessions: { available: true },
    surfaces: ["web", "desktop"],
    features: SESSION_FEATURES,
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
    sessions: {
      available: false,
      reason:
        "Codex's Agent Client Protocol adapter has no mode in which Codex asks before every edit and command, so TabDump cannot approve its actions.",
    },
    surfaces: ["web", "desktop"],
    features: SESSION_FEATURES,
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
    sessions: { available: true },
    surfaces: ["web", "desktop"],
    features: SESSION_FEATURES,
  },
  {
    provider: "grok",
    displayName: "Grok Build",
    vendor: "xAI",
    transport: "acp",
    signIn: {
      kind: "native",
      summary: "Signs in with your Grok account through Grok Build's own login.",
    },
    pitch: "xAI's coding agent, over its built-in Agent Client Protocol mode.",
    // xAI's npm package (publisher xai-security@x.ai). Its site also offers a
    // piped install script; TabDump shows the package manager instead.
    installCommand: "npm install -g @xai-official/grok",
    docsUrl: "https://docs.x.ai/build/overview",
    chat: true,
    sessions: { available: true },
    surfaces: ["web", "desktop"],
    features: SESSION_FEATURES,
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
    pitch:
      "Any agent that speaks MCP can read your TabDump workspaces. You run the agent yourself; TabDump never starts it, and it cannot change anything.",
    docsUrl: "https://modelcontextprotocol.io",
    chat: false,
    sessions: {
      available: false,
      reason: "A custom agent connects to TabDump rather than being run by it, so there is no session to start here.",
    },
    // The MCP server is a route of a TabDump server with an account store.
    // The desktop app is a static shell with neither.
    surfaces: ["web"],
    unavailableOn: {
      desktop:
        "Custom agents connect to TabDump's MCP server, which runs with your TabDump account on the web. The desktop app does not run one.",
    },
    features: ["read_tabdump"],
    // Pinned to what lib/mcp/server.ts registers: seven tools, every one
    // marked read-only. registry.test.ts fails if that list changes.
    explainer: [
      "You run the agent yourself, in its own app or terminal. TabDump never starts it and runs nothing for it.",
      "It connects to this TabDump's MCP server with an access token you issue in Settings → AI connectors, and you can revoke that token there at any time.",
      "It can list and read your workspaces, tabs, collections and tab graph, and see your agent projects and sessions.",
      "It cannot change anything in TabDump, open your project files, or run commands through TabDump.",
    ],
  },
] as const;

export function platformProvider(provider: AgentProviderId): PlatformProvider | undefined {
  return PLATFORM_PROVIDERS.find((entry) => entry.provider === provider);
}
