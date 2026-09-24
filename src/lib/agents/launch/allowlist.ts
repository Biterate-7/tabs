import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AcpApprovalPolicy } from "@/lib/agents/control/providers/acp/launcher";

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
   * Node refuses to spawn a `.cmd` without a shell, and TabDump never uses a
   * shell. So when the executable found is npm's `.cmd` shim, the launcher
   * runs the package's own JavaScript entry with this Node process's binary
   * instead — found under the shim's own `node_modules`, and only for the
   * package named here.
   */
  npmPackages?: readonly string[];
  approval: AcpApprovalPolicy;
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
    },
  },
  {
    // Codex speaks ACP through its adapter, which bundles Codex itself.
    //
    // Verified against @agentclientprotocol/codex-acp 1.13.1 (src/AgentMode):
    // every mode it offers runs Codex with a `workspace-write` sandbox or
    // none. Its `read-only` mode ("Ask for approval") is on-request approval
    // *inside a writable workspace* — Codex edits project files and runs
    // sandboxed commands without asking. The mode is sent on every turn, so
    // no launch option or user config narrows it. TabDump cannot be the one
    // that approves, so it does not start Codex sessions at all.
    provider: "openai-codex",
    detect: ["codex-acp", "codex"],
    acp: {
      executables: ["codex-acp"],
      args: [],
      npmPackages: ["@agentclientprotocol/codex-acp"],
      approval: {
        kind: "unavailable",
        reason:
          "Codex's Agent Client Protocol adapter has no mode in which Codex asks before every edit and command, so TabDump cannot approve its actions.",
      },
    },
  },
  {
    // Grok Build's own ACP server, verified against @xai-official/grok 1.0.41
    // (published by xai-security@x.ai). `--no-leader` is pinned: in leader
    // mode — which the user's config.toml can turn on — the session runs in a
    // shared background process outside TabDump's process tree, so it would
    // escape the job object and the working directory TabDump chose.
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
