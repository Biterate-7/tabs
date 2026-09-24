import type { PlatformProvider } from "./catalog";
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
  | "sign_in_required"
  | "awaiting_approval"
  | "connected"
  | "error"
  | "unknown";

export const CONNECTION_PHASE_LABEL: Record<ConnectionPhase, string> = {
  runtime_unavailable: "Unavailable here",
  not_installed: "Not installed",
  needs_adapter: "Needs its ACP adapter",
  detected: "Installed",
  sign_in_required: "Sign-in required",
  awaiting_approval: "Awaiting your approval",
  connected: "Connected",
  error: "Connection failed",
  unknown: "Not checked yet",
};

export type ConnectionFacts = {
  provider: PlatformProvider;
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

  // An MCP client is the one kind TabDump never starts, so neither the
  // runtime nor the machine is a question for it.
  if (provider.transport === "mcp") {
    // `false` is a known absence. `undefined` is a surface that did not look,
    // which must not read as "you have no token".
    if (facts.mcpTokenIssued === false) return "sign_in_required";
    return facts.approvedScopes ? "connected" : "awaiting_approval";
  }

  if (!facts.executable) return "runtime_unavailable";

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

  if (!facts.approvedScopes) return facts.status?.connection === "connected" ? "awaiting_approval" : "detected";
  return "connected";
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
    case "sign_in_required":
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
];

export function defaultApprovedScopes(provider: PlatformProvider): AgentPermissionScope[] {
  // An MCP client reads TabDump and nothing else — there is no project.
  if (provider.transport === "mcp") return ["read_workspace"];
  return APPROVABLE_SCOPES.filter((entry) => entry.defaultOn).map((entry) => entry.scope);
}
