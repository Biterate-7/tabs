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
 * An entry says how a person *connects* an agent: how Hubble reaches it, how
 * that agent signs in, where it can work, and what Hubble does with it once
 * connected. It is not the last word on any of that — the runtime reports
 * what is installed, whether the agent is signed in, and what its adapter
 * actually declares, and the lifecycle (./lifecycle.ts) believes the runtime
 * over this file wherever they differ.
 *
 * `sessions` is the one field that mirrors a security decision made on the
 * server: an agent Hubble cannot hold to its approvals (the launch
 * allowlist's `approval: "unavailable"`) gets no session there regardless of
 * what this says. It is repeated here so the UI can say *why* before anyone
 * tries, and `platform/registry.test.ts` fails if the two ever disagree.
 *
 * `installCommand` is text for the user to run themselves. Hubble never
 * runs it: installing software is not something a web page on the user's
 * machine does for them.
 */

/** How Hubble talks to the agent. */
export type PlatformTransport =
  /** Through the provider's own SDK, in the runtime. */
  | "sdk"
  /** Over the Agent Client Protocol, as a local process the runtime starts. */
  | "acp"
  /**
   * Over the agent's own app-server protocol (JSON-RPC on stdio), as a local
   * process the runtime starts — Codex's `codex app-server`. Local only, like ACP.
   */
  | "app-server"
  /** The agent is the client: it connects to Hubble's MCP server. Hubble starts nothing. */
  | "mcp";

/**
 * How the agent signs in *here*, as one of three shapes — derived from the
 * authentication methods below, never declared separately.
 *
 *   - `native` — the agent's own sign-in, which Hubble can start through the
 *     protocol (ACP `authenticate`, or Claude Code's own CLI login).
 *   - `provider-key` — the user's own provider API key, stored encrypted by
 *     Hubble (Settings → Agents).
 *   - `mcp-token` — a Hubble MCP access token, issued in Settings.
 */
export type PlatformSignInKind = "native" | "provider-key" | "mcp-token";

/** Where Hubble itself is running. */
export type PlatformSurface = "web" | "desktop";

/* ------------------------------------------------------------------ *
 * Authentication methods (Agent Authentication & Runtime)
 * ------------------------------------------------------------------ */

/**
 * What kind of credential a method uses, as a person would name it.
 *
 *   - `account` — the provider's own account sign-in, run by its agent in the
 *     user's browser (OAuth). Hubble never sees the token.
 *   - `api_key` — an API key.
 *   - `environment` — a credential the agent reads from its own environment
 *     or settings (a cloud provider's). Hubble never collects one.
 *   - `hubble_token` — a Hubble-issued MCP access token (the custom agent).
 */
export type AgentAuthKind = "account" | "api_key" | "environment" | "hubble_token";

/**
 * Who holds the credential.
 *
 *   - `runtime` — the agent's own credential store. Hubble only asks whether
 *     it is signed in. The preferred shape.
 *   - `hubble` — Hubble's encrypted per-user store (an API key on the web,
 *     an MCP token). Never the browser, never localStorage.
 *   - `agent_config` — the agent's own configuration, set up outside Hubble.
 */
export type AuthCredentialOwner = "runtime" | "hubble" | "agent_config";

/**
 * Whether Hubble offers a method, and where.
 *
 * The source of truth the whole connect UI reads. A method a provider has but
 * Hubble cannot honestly offer is `unsupported` *with the reason*, so the UI
 * can say why rather than leave it out silently or show a button that fails.
 */
export type AuthMethodSupport =
  /** Hubble offers the connection flow for it on these surfaces. */
  | { status: "offered"; surfaces: readonly PlatformSurface[] }
  /**
   * Set up in the agent itself. Hubble offers no flow, and uses it when the
   * agent reports it is in use. `setup` says where.
   */
  | { status: "external"; surfaces: readonly PlatformSurface[]; setup: string }
  /** Hubble does not use it. `reason` is the sentence the UI shows. */
  | { status: "unsupported"; reason: string };

/**
 * One way an agent can authenticate, and what Hubble does with it.
 *
 * Declared from the provider's **documented** mechanisms and each agent's
 * verified behaviour — never assumed uniform across providers. See
 * docs/agent-authentication.md for the verification behind every entry.
 */
export type AgentAuthMethod = {
  /** Stable, provider-scoped. Never a credential. */
  id: string;
  /** What the method is called on screen. */
  label: string;
  kind: AgentAuthKind;
  /**
   * Whether this sign-in can carry a paid plan's entitlement — a Claude
   * subscription, a ChatGPT plan, Google AI Pro. Only ever claimed where the
   * provider documents it.
   */
  subscription: boolean;
  owner: AuthCredentialOwner;
  /** One sentence for the connect dialog: whose credential, and who keeps it. */
  summary: string;
  support: AuthMethodSupport;
  /** Why it is not offered on a surface its `support` leaves out. One sentence per surface. */
  unavailableOn?: Partial<Record<PlatformSurface, string>>;
  /**
   * The ids the agent itself advertises for this method (ACP `authMethods`,
   * Claude Code's allowlisted logins). A runtime-run sign-in is offered only
   * when the agent advertises one of them, so Hubble never starts a flow the
   * agent does not have.
   */
  runtimeMethodIds?: readonly string[];
  /** The kind the runtime reports (`authKind`) when this method is the one in use. */
  reportedAs?: "subscription" | "account" | "api_key" | "cloud_provider";
  /** The provider's own documentation for it. */
  docsUrl?: string;
};

/** What Hubble does with an agent once it is connected. Shown when connecting; confirmed by the runtime. */
export type PlatformFeature =
  | "chat"
  | "streaming"
  | "approvals"
  | "project_files"
  | "workspace_context"
  | "read_tabdump";

export const PLATFORM_FEATURE_LABEL: Record<PlatformFeature, string> = {
  chat: "Chat in Hubble",
  streaming: "Replies stream as they are written",
  approvals: "Asks you before it changes a file or runs a command",
  project_files: "Works in a project folder you choose",
  workspace_context: "Sees the Hubble workspace you attach",
  read_tabdump: "Reads your Hubble workspaces, read-only",
};

export type PlatformProvider = {
  provider: AgentProviderId;
  displayName: string;
  /**
   * The name where only a word fits: a logo strip, a compact chip. The same as
   * `displayName` unless that is a description rather than a name.
   */
  shortName: string;
  vendor: string;
  /**
   * The program that runs the agent and owns its sign-in — "Claude Code",
   * "Gemini CLI". The provider is the company; the runtime is what Hubble
   * starts and asks. For the custom agent, the user's own MCP client.
   */
  runtimeName: string;
  transport: PlatformTransport;
  /**
   * Every authentication method the provider documents for this agent, and
   * whether Hubble offers it (Agent Authentication & Runtime). The connect UI
   * shows only what is offered on the surface it is on, and says why for the
   * rest. `platform/authentication.ts` derives everything else from this.
   */
  auth: readonly AgentAuthMethod[];
  /** One sentence: what connecting this agent gives you. */
  pitch: string;
  /** How to install it, for the user to run. Never run by Hubble. */
  installCommand?: string;
  docsUrl: string;
  /** Whether Hubble can hold a conversation with it. False for an MCP-only client. */
  chat: boolean;
  /**
   * Whether Hubble will start sessions with it, and if not, the one sentence
   * that says why. Enforced on the server; see the header.
   */
  sessions: { available: true } | { available: false; reason: string };
  /** Where this connector can work at all. */
  surfaces: readonly PlatformSurface[];
  /** Why it cannot work on a surface it is absent from. One sentence per surface. */
  unavailableOn?: Partial<Record<PlatformSurface, string>>;
  /** What Hubble does with it once connected. */
  features: readonly PlatformFeature[];
  /**
   * Exactly what connecting it means, for a connector the user wires up
   * themselves — or one whose trust model differs from what the feature list
   * would suggest. Plain sentences.
   */
  explainer?: readonly string[];
  /**
   * For an agent whose approved commands run with the user's own system
   * permissions and nothing narrower (Codex on Windows): the sentence every
   * command approval says. Its presence also makes the approval card require
   * the complete command before it offers Allow — see
   * components/command-centre/approval-prompt.tsx.
   */
  commandTrustNotice?: string;
};

/** Whether Hubble drives this agent as a local process it starts (ACP or an app-server). */
export function isLocalProcessTransport(transport: PlatformTransport): boolean {
  return transport === "acp" || transport === "app-server";
}

/** What every agent Hubble drives in a session offers. The same list for each, because it is the same code. */
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
    shortName: "Claude Code",
    vendor: "Anthropic",
    runtimeName: "Claude Code",
    transport: "sdk",
    // Anthropic's terms for apps built on the Claude Agent SDK (Hubble is
    // one): use API-key authentication — an API key or a Console account — or
    // a supported cloud provider; do not offer Claude.ai subscription login.
    // code.claude.com/docs/en/agent-sdk/overview and …/legal-and-compliance,
    // checked 2026-09-28. The desktop runtime reads which login Claude Code is
    // using and refuses a subscription one (launch/native-auth.ts).
    auth: [
      {
        id: "anthropic-api-key",
        label: "Anthropic API key",
        kind: "api_key",
        subscription: false,
        owner: "hubble",
        summary:
          "Your own key from the Claude Console, stored encrypted and used only for your sessions. Usage is billed to your Anthropic account.",
        support: { status: "offered", surfaces: ["web"] },
        unavailableOn: {
          desktop:
            "The desktop app keeps no credentials of its own. Sign in through Claude Code with an Anthropic Console account instead.",
        },
        reportedAs: "api_key",
        docsUrl: "https://console.anthropic.com/settings/keys",
      },
      {
        id: "anthropic-console",
        label: "Anthropic Console account",
        kind: "account",
        subscription: false,
        owner: "runtime",
        summary:
          "Sign in through Claude Code with your Console account. Claude Code keeps the login, and usage is billed as API usage — not a Claude subscription.",
        support: { status: "offered", surfaces: ["desktop"] },
        unavailableOn: {
          web: "In the browser Claude runs on your own API key. Console sign-in happens through Claude Code in the desktop app.",
        },
        runtimeMethodIds: ["console"],
        reportedAs: "account",
        docsUrl: "https://code.claude.com/docs/en/authentication",
      },
      {
        id: "claude-subscription",
        label: "Claude subscription",
        kind: "account",
        subscription: true,
        owner: "runtime",
        summary: "Signing in with a Claude Pro, Max, Team or Enterprise plan.",
        support: {
          status: "unsupported",
          reason:
            "Anthropic doesn't allow apps built on the Claude Agent SDK, like Hubble, to use Claude subscription sign-in. Use an Anthropic API key or Console account instead.",
        },
        runtimeMethodIds: ["claudeai"],
        reportedAs: "subscription",
        docsUrl: "https://code.claude.com/docs/en/agent-sdk/overview",
      },
      {
        id: "claude-cloud-provider",
        label: "Amazon Bedrock, Google Cloud or Microsoft Foundry",
        kind: "environment",
        subscription: false,
        owner: "agent_config",
        summary: "A cloud provider's credential, configured in Claude Code's own settings. Hubble never collects it.",
        support: {
          status: "external",
          surfaces: ["desktop"],
          setup: "Set it up in Claude Code's own settings. Hubble uses it when Claude Code reports it is in use.",
        },
        unavailableOn: {
          web: "In the browser Claude runs on your own Anthropic API key only.",
        },
        reportedAs: "cloud_provider",
        docsUrl: "https://code.claude.com/docs/en/third-party-integrations",
      },
    ],
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
    shortName: "Codex",
    vendor: "OpenAI",
    runtimeName: "Codex",
    transport: "app-server",
    // Driven directly through Codex's own app-server (verified against Codex
    // 0.159.0; docs/codex-app-server.md) — not codex-acp, whose modes could not
    // make Codex ask before every command. OpenAI documents ChatGPT sign-in and
    // API-key sign-in for Codex (developers.openai.com/codex/auth). Hubble runs
    // `codex login` — Codex's own browser sign-in — against Hubble's own Codex
    // folder, and reads the result from the app-server's `account/read`.
    auth: [
      {
        id: "chatgpt-account",
        label: "ChatGPT account",
        kind: "account",
        subscription: true,
        owner: "runtime",
        summary:
          "Codex's own ChatGPT sign-in, opened in your browser. Codex keeps the login in the Codex folder Hubble runs it with; Hubble never sees or keeps the login.",
        support: { status: "offered", surfaces: ["web", "desktop"] },
        runtimeMethodIds: ["chatgpt"],
        reportedAs: "subscription",
        docsUrl: "https://developers.openai.com/codex/auth",
      },
      {
        id: "openai-api-key",
        label: "OpenAI API key",
        kind: "api_key",
        subscription: false,
        owner: "runtime",
        summary: "An OpenAI API key, read by Codex from its environment.",
        support: {
          status: "unsupported",
          reason:
            "Codex accepts an OpenAI API key, but Hubble starts agents with no keys in their environment and does not hand them one.",
        },
        runtimeMethodIds: ["api-key", "codex-api-key", "openai-api-key"],
        reportedAs: "api_key",
        docsUrl: "https://developers.openai.com/codex/auth",
      },
    ],
    pitch: "OpenAI's coding agent, driven through Codex's own app-server. Every command it runs waits for your approval.",
    installCommand: "npm install -g @openai/codex",
    docsUrl: "https://developers.openai.com/codex",
    chat: true,
    sessions: { available: true },
    surfaces: ["web", "desktop"],
    features: SESSION_FEATURES,
    // Said before connecting and on every command approval, because Codex's
    // trust model is Claude's — per-command approval — and NOT a sandbox:
    // on Windows Codex cannot confine an approved command to the project.
    explainer: [
      "Hubble starts Codex in the project folder you choose and gives it context from your Hubble workspace: the workspace, the tabs and collections in focus, for this session only.",
      "That context is what Hubble tells Codex. It does not limit what Codex can reach on your computer.",
      "Every command Codex wants to run waits for your approval, shown in full. Approved commands run with your system permissions, like a command you run yourself — Codex is not sandboxed to the project.",
      "Codex signs in with its own ChatGPT sign-in. Hubble never sees or keeps the login.",
    ],
    commandTrustNotice:
      "Codex commands require your approval before execution. Approved commands run with your system permissions.",
  },
  {
    provider: "gemini",
    displayName: "Gemini CLI",
    shortName: "Gemini CLI",
    vendor: "Google",
    runtimeName: "Gemini CLI",
    transport: "acp",
    // Gemini CLI documents three methods (geminicli.com/docs/resources/
    // tos-privacy): Google login (Gemini Code Assist, including Google AI Pro
    // and Ultra), a Gemini API key, and Vertex AI. Its ACP mode is built "for
    // IDE and other developer tool integrations"; its terms forbid third-party
    // software *directly* using its OAuth credentials, which Hubble never
    // touches — Gemini CLI itself makes every request. Verified 0.61.0: the
    // Google login is advertised as `oauth-personal`.
    auth: [
      {
        id: "google-account",
        label: "Google account",
        kind: "account",
        subscription: true,
        owner: "runtime",
        summary:
          "Gemini CLI's own Login with Google, opened in your browser. Gemini CLI keeps the login; Hubble never sees it.",
        support: { status: "offered", surfaces: ["web", "desktop"] },
        runtimeMethodIds: ["oauth-personal"],
        docsUrl: "https://geminicli.com/docs/get-started/authentication/",
      },
      {
        id: "gemini-api-key",
        label: "Gemini API key",
        kind: "api_key",
        subscription: false,
        owner: "runtime",
        summary: "A Gemini API key, read by Gemini CLI from its environment.",
        support: {
          status: "unsupported",
          reason:
            "Gemini CLI accepts a Gemini API key, but Hubble starts agents with no keys in their environment and does not hand them one. Sign in with Google instead.",
        },
        runtimeMethodIds: ["gemini-api-key"],
        docsUrl: "https://geminicli.com/docs/get-started/authentication/",
      },
      {
        id: "vertex-ai",
        label: "Vertex AI",
        kind: "environment",
        subscription: false,
        owner: "agent_config",
        summary: "Google Cloud credentials, read by Gemini CLI from its environment.",
        support: {
          status: "unsupported",
          reason:
            "Vertex AI credentials come from Gemini CLI's environment, which Hubble keeps free of credentials.",
        },
        runtimeMethodIds: ["vertex-ai"],
        docsUrl: "https://geminicli.com/docs/get-started/authentication/",
      },
    ],
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
    shortName: "Grok Build",
    vendor: "xAI",
    runtimeName: "Grok Build",
    transport: "acp",
    // xAI documents a browser sign-in on first launch, or `XAI_API_KEY` where
    // there is no browser, and use "through the Agent Client Protocol (ACP) in
    // other apps" (docs.x.ai/build/overview). Grok Build 1.0.41 advertises the
    // browser sign-in over ACP as `grok.com`. Which xAI plans it covers is not
    // documented there, so none is claimed.
    auth: [
      {
        id: "xai-account",
        label: "xAI account",
        kind: "account",
        subscription: false,
        owner: "runtime",
        summary: "Grok Build's own browser sign-in. Grok Build keeps the login; Hubble never sees it.",
        support: { status: "offered", surfaces: ["web", "desktop"] },
        runtimeMethodIds: ["grok.com"],
        docsUrl: "https://docs.x.ai/build/overview",
      },
      {
        id: "xai-api-key",
        label: "xAI API key",
        kind: "api_key",
        subscription: false,
        owner: "runtime",
        summary: "An xAI API key, read by Grok Build from its environment.",
        support: {
          status: "unsupported",
          reason:
            "Grok Build accepts an xAI API key, but Hubble starts agents with no keys in their environment and does not hand them one.",
        },
        docsUrl: "https://docs.x.ai/build/overview",
      },
    ],
    pitch: "xAI's coding agent, over its built-in Agent Client Protocol mode.",
    // xAI's npm package (publisher xai-security@x.ai). Its site also offers a
    // piped install script; Hubble shows the package manager instead.
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
    shortName: "MCP",
    vendor: "Any MCP client",
    runtimeName: "Your MCP client",
    transport: "mcp",
    // The agent is the client. It holds no provider credential Hubble knows
    // of; the only credential in the picture is Hubble's own, read-only
    // access token — and Hubble never starts the agent, so it has no
    // provider sign-in to run.
    auth: [
      {
        id: "hubble-access-token",
        label: "Hubble access token",
        kind: "hubble_token",
        subscription: false,
        owner: "hubble",
        summary:
          "Connects to Hubble's read-only MCP server with an access token you issue in Settings, and can revoke there.",
        support: { status: "offered", surfaces: ["web"] },
        unavailableOn: {
          desktop:
            "Custom agents connect to Hubble's MCP server, which runs with your Hubble account on the web. The desktop app does not run one.",
        },
        docsUrl: "https://modelcontextprotocol.io",
      },
    ],
    pitch:
      "Any agent that speaks MCP can read your Hubble workspaces. You run the agent yourself; Hubble never starts it, and it cannot change anything.",
    docsUrl: "https://modelcontextprotocol.io",
    chat: false,
    sessions: {
      available: false,
      reason: "A custom agent connects to Hubble rather than being run by it, so there is no session to start here.",
    },
    // The MCP server is a route of a Hubble server with an account store.
    // The desktop app is a static shell with neither.
    surfaces: ["web"],
    unavailableOn: {
      desktop:
        "Custom agents connect to Hubble's MCP server, which runs with your Hubble account on the web. The desktop app does not run one.",
    },
    features: ["read_tabdump"],
    // Pinned to what lib/mcp/server.ts registers: seven tools, every one
    // marked read-only. registry.test.ts fails if that list changes.
    explainer: [
      "You run the agent yourself, in its own app or terminal. Hubble never starts it and runs nothing for it.",
      "It connects to this Hubble's MCP server with an access token you issue in Settings → Agents, and you can revoke that token there at any time.",
      "It can list and read your workspaces, tabs, collections and tab graph, and see your agent projects and sessions.",
      "It cannot change anything in Hubble, open your project files, or run commands through Hubble.",
    ],
  },
] as const;

export function platformProvider(provider: AgentProviderId): PlatformProvider | undefined {
  return PLATFORM_PROVIDERS.find((entry) => entry.provider === provider);
}

/** What an agent this build does not ship is called. Its provider id is an internal key and never shown. */
export const UNKNOWN_AGENT_NAME = "Unknown agent";

/**
 * The name every product surface shows for a provider — the session list,
 * the activity timeline, a handoff, agent history, the inspector. Never a
 * provider id: one this build does not know is an unknown agent. The visual
 * identity (visual/identity.ts) adds the mark to this same name.
 */
export function providerDisplayName(provider: string | undefined | null): string {
  if (!provider) return UNKNOWN_AGENT_NAME;
  return PLATFORM_PROVIDERS.find((entry) => entry.provider === provider)?.displayName ?? UNKNOWN_AGENT_NAME;
}
