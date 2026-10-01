import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AcpApprovalPolicy, AcpContextIdentity } from "@/lib/agents/control/providers/acp/launcher";

/**
 * Every program Hubble will ever start, and exactly how.
 *
 * ## This file is the whole answer to "what can Hubble execute"
 *
 * A provider's entry names the executables Hubble looks for and the
 * **constant** argument list it passes. Nothing else can reach `spawn`: the
 * launcher takes a provider id, looks it up here, and a provider with no
 * `acp` entry cannot be launched at all. No argument is ever assembled from
 * a request, a prompt, a setting or a path the user typed — the one variable
 * input to a launch is the working directory, and that is a project root the
 * launcher revalidates itself.
 *
 * `launch/security.test.ts` pins the table: every `args` array is a literal,
 * and the set of executables is exactly the list below.
 *
 * ## Nothing here says whether an agent is signed in (Phase J.2)
 *
 * An earlier version listed files an agent's sign-in leaves behind and called
 * the agent "signed in" when one existed. That was a guess about someone
 * else's credential store, and it was wrong in both directions: a file can
 * outlive its token, and some agents keep no file at all. Sign-in state now
 * comes only from the agent itself — see `control/providers/acp/adapter.ts`
 * (`connect`) and `./native-auth.ts`.
 *
 * ## `approval` is read from each agent's source, not its mode names
 *
 * See `AcpApprovalPolicy`. codex-acp's mode called `read-only` lets Codex
 * write inside the project, which is why every entry cites what it checked.
 */

export type AcpLaunchEntry = {
  /** Executable names looked up on PATH, in order. Never a path. */
  executables: readonly string[];
  /** Passed verbatim. A literal in this file, never computed. */
  args: readonly string[];
  /**
   * The npm package whose `bin` an npm shim on Windows points at.
   *
   * Node refuses to spawn a `.cmd` without a shell, and Hubble never uses a
   * shell. So when the executable found is npm's `.cmd` shim, the launcher
   * runs the package's own JavaScript entry with this Node process's binary
   * instead — found under the shim's own `node_modules`, and only for the
   * package named here.
   */
  npmPackages?: readonly string[];
  approval: AcpApprovalPolicy;
  /**
   * Whether a session can be handed its Hubble context server, and how its
   * calls are told apart (Phase J.4). See `AcpContextIdentity`. The one
   * argument this can add is `[allowlistFlag, <per-session server name>]`,
   * and the launcher accepts the name only in the minted shape.
   */
  contextIdentity: AcpContextIdentity;
};

/**
 * An agent Hubble drives through its own SDK but whose *login* it can start
 * (Phase J.1, the desktop app).
 *
 * Every argument list here is a literal. The login ones open the provider's
 * own sign-in page in the user's browser; the credential they produce is
 * written by the agent into its own store and never passes through Hubble.
 */
export type NativeCliEntry = {
  executables: readonly string[];
  /** Answers "is this agent signed in", as JSON. Reads nothing Hubble keeps. */
  statusArgs: readonly string[];
  /** One literal argument list per sign-in method Hubble offers. */
  loginArgs: Readonly<Record<string, readonly string[]>>;
  /** What each sign-in method is called on the button. */
  loginLabels: Readonly<Record<string, string>>;
};

/**
 * An agent Hubble drives over its **own** app-server protocol — JSON-RPC on
 * stdio, not ACP (Codex; docs/codex-app-server.md).
 *
 * The same rules as `AcpLaunchEntry`: executables by name, a literal argument
 * list, an npm shim followed only into the vendor's own package. Two things
 * are added, both because of what the agent reads from its own settings:
 *
 *   - `homeEnv` names the variable that points the agent at its settings
 *     folder. Hubble sets it — never inherits it — to a folder Hubble owns
 *     (./codex-home.ts), because the user's own folder can hold rules that
 *     approve commands unasked and MCP servers that launch programs, and a
 *     launch argument cannot remove either.
 *   - `verifiedPlatforms`: where Hubble verified that the agent asks before
 *     every command in the policy it is given. Elsewhere it is reached and
 *     signed in to, and given no session.
 */
export type AppServerLaunchEntry = {
  executables: readonly string[];
  /** Passed verbatim. A literal in this file, never computed. */
  args: readonly string[];
  npmPackages?: readonly string[];
  homeEnv: "CODEX_HOME";
  verifiedPlatforms: readonly NodeJS.Platform[];
  /** The oldest agent version this protocol was verified against, `major.minor.patch`. */
  minimumVersion: string;
  /**
   * The agent's own sign-in, one literal argument list per method. The agent
   * opens the provider's page in the browser itself and keeps the credential
   * in its own store; Hubble only waits for it to finish.
   */
  loginArgs: Readonly<Record<string, readonly string[]>>;
  loginLabels: Readonly<Record<string, string>>;
};

export type ProviderLaunchEntry = {
  provider: AgentProviderId;
  /** Executables whose presence means the agent is installed. */
  detect: readonly string[];
  /** How Hubble drives it, when it can. Absent: detect only. */
  acp?: AcpLaunchEntry;
  /** How Hubble drives it over its own app-server protocol (Codex). */
  appServer?: AppServerLaunchEntry;
  /** The agent's own CLI, for an SDK-driven agent's executable and native sign-in. */
  native?: NativeCliEntry;
};

export const PROVIDER_LAUNCH_TABLE: readonly ProviderLaunchEntry[] = [
  {
    // Driven through the Agent SDK (control/providers/claude-code), which
    // spawns its own process. Detection only here.
    provider: "claude-code",
    detect: ["claude"],
    // The desktop app drives the user's installed Claude Code (where their
    // own login lives) and can start that login. Verified against 2.1.229:
    // `claude auth status --json` → {"loggedIn", "authMethod", "apiProvider",
    // …}; `claude auth login --console`.
    //
    // Only the Console sign-in ("API usage billing instead of a Claude
    // subscription") is offered. Anthropic does not permit an app built on
    // the Claude Agent SDK to offer Claude.ai subscription login, so there is
    // deliberately no `--claudeai` entry: no request can start one. See
    // docs/agent-authentication.md and ./native-auth.ts.
    native: {
      executables: ["claude"],
      statusArgs: ["auth", "status", "--json"],
      loginArgs: {
        console: ["auth", "login", "--console"],
      },
      loginLabels: {
        console: "Sign in with Anthropic Console",
      },
    },
  },
  {
    // `--approval-mode default` is pinned on the command line because Gemini
    // lets it override the user's own settings, which may ask for `yolo` or
    // `auto_edit`. Verified against @google/gemini-cli 0.61.0: its ACP modes
    // are `default` ("Prompts for approval"), `autoEdit`, `yolo` and `plan`.
    provider: "gemini",
    detect: ["gemini"],
    acp: {
      executables: ["gemini"],
      args: ["--acp", "--approval-mode", "default"],
      npmPackages: ["@google/gemini-cli"],
      approval: { kind: "asking-mode", modeIds: ["default"] },
      // Verified against @google/gemini-cli 0.61.0 (Phase J.4):
      //   - `--allowed-mcp-server-names` is checked for every server Gemini
      //     would load — settings, extensions, admin-required, the legacy
      //     serverCommand, and the session's own (McpClientManager
      //     `isBlockedBySettings`, in `maybeDiscoverMcpServer`). With the
      //     session's name alone, no other MCP server can exist in it.
      //   - `proceed_always_server` and `proceed_always_tool` are offered only
      //     by a confirmation of type `mcp` (`toPermissionOptions`), which only
      //     `DiscoveredMCPToolInvocation` produces. The request itself names no
      //     server (kind `other`, title = the tool's display name).
      // A user who sets `security.disableAlwaysAllow` removes the marker; the
      // request is then refused as an ordinary tool (fails closed).
      contextIdentity: {
        kind: "exclusive-mcp",
        allowlistFlag: "--allowed-mcp-server-names",
        mcpConfirmationOptionIds: ["proceed_always_server", "proceed_always_tool"],
      },
    },
  },
  {
    // Codex, driven directly over its own app-server — not codex-acp, whose
    // four fixed modes could not make Codex ask before every command.
    // Verified against Codex 0.159.0 (docs/codex-app-server.md):
    //
    //   - With approval policy `untrusted` and reviewer `user`, every command
    //     on Windows raises `item/commandExecution/requestApproval` first
    //     (37 commands, reads included), and a declined one never runs.
    //   - Each argument below closes a surface that could act without that
    //     request. `unified_exec_tty`: `write_stdin` into an approved
    //     interactive shell runs further input unasked. `view_image`: reads
    //     any image on disk unasked. Web search, sub-agents, apps, plugins,
    //     hooks, computer and browser use, image generation, goals and
    //     memories are never offered to the model. `--listen stdio://` keeps
    //     the server on this process's pipes: no socket, no shared daemon.
    //   - Code mode stays on. The default model (real-agent QA, 2026-09-30)
    //     runs every command through it; with it off, nothing can run at all.
    //     Its cells are a bare JavaScript isolate — no fs, fetch, import,
    //     process, WebAssembly; `load`/`store` are a key-value store, `image`
    //     takes only a data URI — so a cell acts only through Codex's own
    //     tools: `exec_command` and `apply_patch`, which ask Hubble first
    //     (verified, declined: nothing ran), `write_stdin` (no tty), a clock.
    //   - Hubble never sets `windows.sandbox`: its `elevated` value makes
    //     Codex raise a Windows administrator prompt by itself.
    //
    // There is no workspace sandbox in this model. On Windows an approved
    // command runs with the user's own permissions, exactly as an approved
    // Claude Code command does — which is why every command approval shows the
    // complete command, and says so.
    provider: "openai-codex",
    detect: ["codex"],
    appServer: {
      executables: ["codex"],
      args: ["app-server", "--listen", "stdio://", "--disable", "unified_exec_tty", "--disable", "view_image", "--disable", "multi_agent", "--disable", "multi_agent_v2", "--disable", "apps", "--disable", "plugins", "--disable", "remote_plugin", "--disable", "plugin_sharing", "--disable", "tool_suggest", "--disable", "hooks", "--disable", "computer_use", "--disable", "browser_use", "--disable", "browser_use_external", "--disable", "browser_use_full_cdp_access", "--disable", "in_app_browser", "--disable", "image_generation", "--disable", "skill_mcp_dependency_install", "--disable", "shell_snapshot", "--disable", "workspace_dependencies", "--disable", "realtime_conversation", "--disable", "guardian_approval", "--disable", "goals", "--disable", "memories", "--disable", "worktrees", "-c", "web_search=disabled", "-c", "check_for_update_on_startup=false"],
      npmPackages: ["@openai/codex"],
      homeEnv: "CODEX_HOME",
      // Verified on Windows only. On macOS and Linux Codex's own sandbox runs
      // "known safe" read commands without asking under `untrusted`.
      verifiedPlatforms: ["win32"],
      minimumVersion: "0.159.0",
      // `codex login`: Codex's own ChatGPT sign-in. It opens the browser
      // itself and stores the login in its own folder — Hubble's.
      loginArgs: {
        chatgpt: ["login"],
      },
      loginLabels: {
        chatgpt: "Sign in with ChatGPT",
      },
    },
  },
  {
    // Grok Build's own ACP server, verified against @xai-official/grok 1.0.41
    // (published by xai-security@x.ai). `--no-leader` is pinned: in leader
    // mode — which the user's config.toml can turn on — the session runs in a
    // shared background process outside Hubble's process tree, so it would
    // escape the job object and the working directory Hubble chose.
    //
    // Grok's permission modes are Default ("currently equivalent to Ask"),
    // Ask, Auto (a classifier approves "safe" tools unasked) and Always
    // approve. Only the asking ones are accepted; a session in which the
    // agent offers neither is refused rather than guessed at.
    provider: "grok",
    detect: ["grok"],
    acp: {
      executables: ["grok"],
      args: ["agent", "--no-leader", "stdio"],
      npmPackages: ["@xai-official/grok"],
      approval: { kind: "asking-mode", modeIds: ["ask", "default"] },
      // Checked against 1.0.41 (Phase J.4): its MCP allowlist exists only in
      // managed settings files — there is no launch flag that limits a session
      // to one server — and the shape of its permission request for an MCP
      // call could not be observed without a signed-in xAI account. Without
      // both, Hubble cannot prove a call is its own, so Grok sessions start
      // without workspace context instead of with context they cannot use.
      contextIdentity: {
        kind: "unavailable",
        reason:
          "Grok Build cannot be limited to Hubble's context server, and its approval requests do not say which server a tool belongs to, so Hubble cannot tell its own tools apart from others.",
      },
    },
  },
] as const;

export function launchEntryFor(provider: AgentProviderId): ProviderLaunchEntry | undefined {
  return PROVIDER_LAUNCH_TABLE.find((entry) => entry.provider === provider);
}

/** Providers Hubble can drive over ACP on this machine's runtime. */
export const ACP_PROVIDERS: readonly AgentProviderId[] = PROVIDER_LAUNCH_TABLE.filter(
  (entry) => entry.acp !== undefined
).map((entry) => entry.provider);

/** Providers Hubble drives over their own app-server protocol on this machine's runtime. */
export const APP_SERVER_PROVIDERS: readonly AgentProviderId[] = PROVIDER_LAUNCH_TABLE.filter(
  (entry) => entry.appServer !== undefined
).map((entry) => entry.provider);

/** Every agent Hubble starts as a local process — ACP or app-server — in the table's order. */
export const LOCAL_PROCESS_PROVIDERS: readonly AgentProviderId[] = PROVIDER_LAUNCH_TABLE.filter(
  (entry) => entry.acp !== undefined || entry.appServer !== undefined
).map((entry) => entry.provider);
