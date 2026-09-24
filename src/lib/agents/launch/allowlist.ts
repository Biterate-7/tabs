import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * Every program TabDump will ever start, and exactly how.
 *
 * ## This file is the whole answer to "what can TabDump execute"
 *
 * A provider's entry names the executables TabDump looks for and the
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
 * ## Sign-in markers are presence checks, never reads
 *
 * `signInMarkers` are files an agent's own sign-in leaves behind. Detection
 * asks whether one *exists* — it never opens it — and even then only claims
 * "signed in" on presence. Absence proves nothing (Claude Code on macOS keeps
 * its login in the Keychain), so absence is reported as `unknown`, never as
 * "signed out".
 */

export type AcpLaunchEntry = {
  /** Executable names looked up on PATH, in order. Never a path. */
  executables: readonly string[];
  /** Passed verbatim. A literal in this file, never computed. */
  args: readonly string[];
  /**
   * The npm package whose `bin` an npm shim on Windows points at.
   *
   * Node refuses to spawn a `.cmd` without a shell, and TabDump never uses a
   * shell. So when the executable found is npm's `.cmd` shim, the launcher
   * runs the package's own JavaScript entry with this Node process's binary
   * instead — found under the shim's own `node_modules`, and only for the
   * package named here.
   */
  npmPackages?: readonly string[];
  /**
   * The ACP session mode in which the agent asks before editing or running
   * anything, when it has named modes. TabDump puts every new session in it.
   */
  askingModeId?: string;
};

/**
 * An agent TabDump drives through its own SDK but whose *login* it can start
 * (Phase J.1, the desktop app).
 *
 * Every argument list here is a literal. The login ones open the provider's
 * own sign-in page in the user's browser; the credential they produce is
 * written by the agent into its own store and never passes through TabDump.
 */
export type NativeCliEntry = {
  executables: readonly string[];
  /** Answers "is this agent signed in", as JSON. Reads nothing TabDump keeps. */
  statusArgs: readonly string[];
  /** One literal argument list per sign-in method TabDump offers. */
  loginArgs: Readonly<Record<string, readonly string[]>>;
  /** What each sign-in method is called on the button. */
  loginLabels: Readonly<Record<string, string>>;
};

export type ProviderLaunchEntry = {
  provider: AgentProviderId;
  /** Executables whose presence means the agent is installed. */
  detect: readonly string[];
  /** Relative to the user's home directory. Presence only. */
  signInMarkers: readonly string[];
  /** How TabDump drives it, when it can. Absent: detect only. */
  acp?: AcpLaunchEntry;
  /** The agent's own CLI, for an SDK-driven agent's executable and native sign-in. */
  native?: NativeCliEntry;
};

export const PROVIDER_LAUNCH_TABLE: readonly ProviderLaunchEntry[] = [
  {
    // Driven through the Agent SDK (control/providers/claude-code), which
    // spawns its own process. Detection only here.
    provider: "claude-code",
    detect: ["claude"],
    signInMarkers: [".claude/.credentials.json"],
    // The desktop app drives the user's installed Claude Code (where their
    // own login lives) and can start that login. Verified against 2.1.229:
    // `claude auth status --json` → {"loggedIn": …}; `claude auth login`.
    native: {
      executables: ["claude"],
      statusArgs: ["auth", "status", "--json"],
      loginArgs: {
        claudeai: ["auth", "login", "--claudeai"],
        console: ["auth", "login", "--console"],
      },
      loginLabels: {
        claudeai: "Sign in with Claude",
        console: "Sign in with Anthropic Console",
      },
    },
  },
  {
    provider: "gemini",
    detect: ["gemini"],
    signInMarkers: [".gemini/oauth_creds.json"],
    acp: {
      executables: ["gemini"],
      args: ["--acp"],
      npmPackages: ["@google/gemini-cli"],
      askingModeId: "default",
    },
  },
  {
    // Codex speaks ACP through its adapter, which bundles Codex itself.
    provider: "openai-codex",
    detect: ["codex-acp", "codex"],
    signInMarkers: [".codex/auth.json"],
    acp: {
      executables: ["codex-acp"],
      args: [],
      npmPackages: ["@agentclientprotocol/codex-acp", "@zed-industries/codex-acp"],
      askingModeId: "read-only",
    },
  },
  {
    // Grok Build ships ACP in its own binary. Its sign-in store is not
    // documented, so TabDump claims nothing about it.
    provider: "grok",
    detect: ["grok"],
    signInMarkers: [],
    acp: {
      executables: ["grok"],
      args: ["agent", "stdio"],
    },
  },
] as const;

export function launchEntryFor(provider: AgentProviderId): ProviderLaunchEntry | undefined {
  return PROVIDER_LAUNCH_TABLE.find((entry) => entry.provider === provider);
}

/** Providers TabDump can drive over ACP on this machine's runtime. */
export const ACP_PROVIDERS: readonly AgentProviderId[] = PROVIDER_LAUNCH_TABLE.filter(
  (entry) => entry.acp !== undefined
).map((entry) => entry.provider);
