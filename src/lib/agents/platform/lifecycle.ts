import type { PlatformProvider, PlatformSurface } from "./catalog";
import type { AgentPermissionScope } from "@/lib/agents/control/permissions";
import type {
  ProviderConnectionView,
  ProviderDetection,
  RuntimeProviderStatus,
} from "@/lib/agents/runtime/protocol";

/**
 * Where one agent's connection stands, derived — never stored.
 *
 * ## One vocabulary for every provider
 *
 * Claude Code over its SDK, Gemini/Codex/Grok over ACP and a custom MCP client
 * all move through the same phases, which is what lets the connect flow and
 * the roster be written once. What differs per provider is only *which facts
 * decide* a phase — and those facts come from three independent reports:
 *
 *   - **detection** — is it installed on this machine (a local runtime only);
 *   - **the runtime** — can it be driven, and what did the agent say about
 *     its sign-in;
 *   - **the roster** — has the user approved it.
 *
 * The phase is recomputed from them on every render, so it can never drift
 * from what they say. There is no stored "connected" flag that could outlive
 * the facts that made it true.
 *
 * ## The order of the checks is the order of the questions a person asks
 *
 *   1. Can agents run here at all?        → `runtime_unavailable`
 *   2. Is it installed?                   → `not_installed`
 *   3. Can TabDump start it?              → `needs_adapter`
 *   4. Is it signed in?                   → `sign_in_required`
 *   5. Has the user approved it?          → `awaiting_approval`
 *   6. Otherwise                          → `connected`
 *
 * `detected` sits between 3 and 4 for an agent that is installed and has not
 * been connected yet, and `unknown` is what an agent reports before anyone
 * has asked (a local machine that has not been scanned).
 */
export type ConnectionPhase =
  | "runtime_unavailable"
  | "not_installed"
  | "needs_adapter"
  | "detected"
  | "connecting"
  /** The agent's own sign-in is open and TabDump is waiting on the person (Phase J.2). */
  | "authenticating"
  | "sign_in_required"
  /** The agent was reached, but could not say whether it is signed in (Phase J.2). */
  | "unverified"
  | "awaiting_approval"
  | "connected"
  /**
   * Approved earlier, and not reached by this runtime since it started — so
   * not shown as connected on the strength of a remembered approval (J.2).
   */
  | "disconnected"
  | "error"
  | "unknown";

export const CONNECTION_PHASE_LABEL: Record<ConnectionPhase, string> = {
  runtime_unavailable: "Unavailable here",
  not_installed: "Not installed",
  needs_adapter: "Needs its ACP adapter",
  detected: "Installed",
  connecting: "Connecting…",
  authenticating: "Signing in…",
  sign_in_required: "Sign-in required",
  unverified: "Sign-in not verified",
  awaiting_approval: "Awaiting your approval",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
  unknown: "Not checked yet",
};

export type ConnectionFacts = {
  provider: PlatformProvider;
  /** Where TabDump is running. Absent means the web. */
  surface?: PlatformSurface;
  /** TabDump is reaching this agent right now. */
  connecting?: boolean;
  /** The agent's own sign-in is open, waiting on the person. */
  authenticating?: boolean;
  /** Whether the runtime can execute agents at all. */
  executable: boolean;
  /** Whether the runtime is on the user's own machine (only then is detection meaningful). */
  local: boolean;
  detection?: ProviderDetection;
  /** The runtime's report, from `get_status` or a connect/sign-in reply. */
  status?: RuntimeProviderStatus | ProviderConnectionView;
  /** Whether the user's provider key is connected (for `provider-key` sign-in). */
  providerKeyConnected?: boolean;
  /** Whether a TabDump MCP token has been issued (for `mcp-token` sign-in). */
  mcpTokenIssued?: boolean;
  /** Present when the user approved this agent. */
  approvedScopes?: readonly AgentPermissionScope[];
};

export function connectionPhase(facts: ConnectionFacts): ConnectionPhase {
  const { provider } = facts;

  // A connector that cannot work where TabDump is running (a custom MCP
  // agent in the desktop app, which runs no MCP server) says so first.
  if (!provider.surfaces.includes(facts.surface ?? "web")) return "runtime_unavailable";

  // An MCP client is the one kind TabDump never starts, so neither the
  // runtime nor the machine is a question for it.
  if (provider.transport === "mcp") {
    // `false` is a known absence. `undefined` is a surface that did not look,
    // which must not read as "you have no token".
    if (facts.mcpTokenIssued === false) return "sign_in_required";
    return facts.approvedScopes ? "connected" : "awaiting_approval";
  }

  if (!facts.executable) return "runtime_unavailable";

  if (facts.connecting) return "connecting";
  if (facts.authenticating) return "authenticating";

  if (facts.status?.connection === "error") return "error";

  if (facts.local) {
    if (!facts.detection) return "unknown";
    if (!facts.detection.installed && !facts.detection.launchable) {
      // The SDK brings its own agent; an absent CLI is not a blocker for it.
      if (provider.transport !== "sdk") return "not_installed";
    }
    if (provider.transport === "acp" && !facts.detection.launchable) return "needs_adapter";
    // An SDK agent that drives the *installed* CLI (the desktop app) has no
    // runtime to offer when that CLI is absent.
    if (!facts.detection.installed && facts.status?.connection === "unavailable") return "not_installed";
  } else if (provider.transport === "acp") {
    // ACP agents run on the user's machine. A remote runtime cannot reach one.
    return "runtime_unavailable";
  }

  // A stored key matters only where the runtime has no native sign-in for
  // this agent. In the desktop app Claude uses its own login (Phase J.1), and
  // whether a key is stored in a server TabDump does not have is irrelevant.
  if (
    signInKind(provider, facts.status) === "provider-key" &&
    facts.providerKeyConnected === false
  ) {
    return "sign_in_required";
  }
  if (facts.status?.authentication === "required") return "sign_in_required";

  // An agent that signs in with its own login was just asked, and could not
  // say. That is not "signed in", and it is not shown as connected (Phase J.2).
  if (
    signInKind(provider, facts.status) === "native" &&
    facts.status?.connection === "connected" &&
    facts.status.authentication === "unknown"
  ) {
    return "unverified";
  }

  if (!facts.approvedScopes) return facts.status?.connection === "connected" ? "awaiting_approval" : "detected";

  // An agent that signs in with its own login is connected only once this
  // runtime has reached it and it said it is signed in. An approval from an
  // earlier run proves neither.
  if (signInKind(provider, facts.status) === "native" && facts.status?.connection !== "connected") {
    return "disconnected";
  }
  return "connected";
}

/**
 * The one sentence a person reads about where an agent stands.
 *
 * Written once, from the provider's name and the phase, so every provider
 * fails in the same words and no component composes its own. Never a path,
 * a command line or anything the agent itself printed.
 */
export function phaseSentence(
  provider: PlatformProvider,
  phase: ConnectionPhase,
  facts: { surface?: PlatformSurface; installed?: boolean } = {}
): string {
  const name = provider.displayName;
  switch (phase) {
    case "runtime_unavailable": {
      const surface = facts.surface ?? "web";
      if (!provider.surfaces.includes(surface)) {
        return provider.unavailableOn?.[surface] ?? `${name} is unavailable here.`;
      }
      return provider.transport === "acp"
        ? `${name} is unavailable on this runtime. It runs on your own machine, from the desktop app or a local TabDump.`
        : "Agents cannot run in this TabDump.";
    }
    case "not_installed":
      return `${name} is not installed.`;
    case "needs_adapter":
      return `${name} is installed, but the program TabDump drives it through is not.`;
    case "detected":
      return `${name} is installed.`;
    case "connecting":
      return `Connecting to ${name}…`;
    case "authenticating":
      return `Waiting for you to finish signing in to ${name}…`;
    case "sign_in_required":
      return facts.installed ? `${name} is installed but not authenticated.` : `${name} is not signed in.`;
    case "unverified":
      return "Authentication could not be verified.";
    case "awaiting_approval":
      return `${name} is ready. Approve what it may do to finish connecting.`;
    case "connected":
      return `${name} is connected.`;
    case "disconnected":
      return `${name} is not connected right now.`;
    case "error":
      return `${name} could not be reached.`;
    case "unknown":
      return "TabDump has not checked this machine yet.";
  }
}

/**
 * Whether TabDump will start a session with this agent, and if not, why.
 *
 * The registry's word, and then the runtime's: an adapter that declares no
 * `create_session` cannot be given one whatever the registry says.
 */
export function sessionAvailability(
  provider: PlatformProvider,
  status: ConnectionFacts["status"] | undefined
): { available: true } | { available: false; reason: string } {
  if (!provider.sessions.available) return provider.sessions;
  if (status && status.available && !status.capabilities.includes("create_session")) {
    return { available: false, reason: `${provider.displayName} cannot start sessions on this runtime yet.` };
  }
  return { available: true };
}

/**
 * How this agent signs in *here*.
 *
 * The catalogue says how it usually does; the runtime says whether it can
 * start the agent's own login in this shell. The runtime's answer wins — it is
 * the one that knows which adapter it built.
 */
export function signInKind(
  provider: PlatformProvider,
  status: ConnectionFacts["status"] | undefined
): PlatformProvider["signIn"]["kind"] {
  if (status?.nativeSignIn) return "native";
  return provider.signIn.kind;
}

/** Phases in which the agent can be talked to. */
export function isChatReady(phase: ConnectionPhase): boolean {
  return phase === "connected";
}

/* ------------------------------------------------------------------ *
 * The connect flow
 * ------------------------------------------------------------------ */

/**
 * The steps of Connect Agent, as a table rather than conditionals.
 *
 * choose → detect → sign-in → approve → done. A step is skipped only when the
 * facts already answer it — never because the UI decided to move on. Which
 * step is showing is derived from the phase, so reopening the flow for an
 * agent that is half connected lands on the step it actually needs.
 */
export type ConnectStep = "choose" | "detect" | "sign_in" | "approve" | "done";

export const CONNECT_STEPS: readonly ConnectStep[] = ["choose", "detect", "sign_in", "approve", "done"];

export function stepFor(phase: ConnectionPhase): ConnectStep {
  switch (phase) {
    case "unknown":
    case "runtime_unavailable":
    case "not_installed":
    case "needs_adapter":
    case "error":
      return "detect";
    case "detected":
    case "connecting":
    case "authenticating":
    case "sign_in_required":
    case "unverified":
    case "disconnected":
      return "sign_in";
    case "awaiting_approval":
      return "approve";
    case "connected":
      return "done";
  }
}

/**
 * The scopes an agent may be approved for, and which are on by default.
 *
 * Reading TabDump content is on, because it is the point of connecting an
 * agent to TabDump. Reading project files is on because an agent that cannot
 * read the code it was asked about is not useful. Changing files and running
 * commands are **off** — the user turns them on — and even when on, every
 * single use still needs its own approval (see control/permissions.ts:
 * `APPROVAL_REQUIRED_PERMISSIONS`). There is no "run anything" scope.
 */
export const APPROVABLE_SCOPES: readonly { scope: AgentPermissionScope; defaultOn: boolean }[] = [
  { scope: "read_workspace", defaultOn: true },
  { scope: "read_project", defaultOn: true },
  { scope: "write_project", defaultOn: false },
  { scope: "run_commands", defaultOn: false },
  // Creating a collection in the workspace a session was started from (J.3).
  { scope: "write_workspace", defaultOn: false },
];

export function defaultApprovedScopes(provider: PlatformProvider): AgentPermissionScope[] {
  // An MCP client reads TabDump and nothing else — there is no project.
  if (provider.transport === "mcp") return ["read_workspace"];
  return APPROVABLE_SCOPES.filter((entry) => entry.defaultOn).map((entry) => entry.scope);
}
