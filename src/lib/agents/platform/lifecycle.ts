import { activeAuthMethod, agentCapabilities, signInShape, unavailableAuthMethods } from "./authentication";
import { isLocalProcessTransport } from "./catalog";
import type { AgentAuthMethod, PlatformProvider, PlatformSignInKind, PlatformSurface } from "./catalog";
import type { AgentPermissionScope } from "@/lib/agents/control/permissions";
import type {
  ProviderConnectionView,
  ProviderDetection,
  RuntimeErrorCode,
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
 * decide* a phase — and those facts come from independent reports:
 *
 *   - **detection** — is it installed on this machine (a local runtime only);
 *   - **the runtime** — can it be driven, what did the agent say about its
 *     sign-in, and which kind of sign-in it is;
 *   - **the last action** — did the last connect or sign-in this surface sent
 *     fail, and how (Agent Authentication & Runtime);
 *   - **the roster** — has the user approved it.
 *
 * The phase is recomputed from them on every render, so it can never drift
 * from what they say. There is no stored "connected" flag that could outlive
 * the facts that made it true.
 *
 * ## The order of the checks is the order of the questions a person asks
 *
 *   1. Can agents run here at all?        → `runtime_unavailable`
 *   2. Is Hubble asking it right now?     → `connecting` / `authenticating`
 *   3. Did the last attempt fail?         → `timeout` / `connection_lost` /
 *                                           `auth_failed` / `error`
 *   4. Is it installed?                   → `not_installed`
 *   5. Can Hubble start it?               → `needs_adapter`
 *   6. Is it signed in, in a way Hubble
 *      may use?                           → `sign_in_required` /
 *                                           `auth_expired` / `auth_unsupported`
 *   7. Signed in — but can Hubble start
 *      a session with it?                 → `sessions_unavailable`
 *   8. Has the user approved it?          → `awaiting_approval`
 *   9. Otherwise                          → `connected`
 *
 * ## Signed in is not ready
 *
 * AUTHENTICATED ≠ SESSION_READY. An agent can be reached and signed in and
 * still be one Hubble will not start a session with — the catalogue says so
 * (Codex: it does not ask before every action), or the runtime's adapter
 * declares no `create_session`. Such an agent is `sessions_unavailable`:
 * never "Connected", never "Awaiting your approval" for an approval it cannot
 * be given, and never counted as ready by the command centre.
 *
 * ## Every transient phase ends
 *
 * `connecting` and `authenticating` exist only while a request is in flight,
 * and every request is bounded (runtime/client.ts `COMMAND_TIMEOUT_MS`). A
 * runtime that keeps *reporting* `connecting` past its deadline is `timeout`
 * (the hook's watchdog sets `stalled`). None of them can be shown forever.
 */
export type ConnectionPhase =
  | "runtime_unavailable"
  | "not_installed"
  | "needs_adapter"
  | "detected"
  | "connecting"
  /** The agent's own sign-in is open and Hubble is waiting on the person (Phase J.2). */
  | "authenticating"
  | "sign_in_required"
  /** The agent was reached, but could not say whether it is signed in (Phase J.2). */
  | "unverified"
  /**
   * Reached and signed in, but Hubble will not start sessions with it
   * (`sessionAvailability`). Authenticated, not usable.
   */
  | "sessions_unavailable"
  | "awaiting_approval"
  | "connected"
  /**
   * Approved earlier, and not reached by this runtime since it started — so
   * not shown as connected on the strength of a remembered approval (J.2).
   */
  | "disconnected"
  /** The agent or the runtime did not answer in time. */
  | "timeout"
  /** The agent's own sign-in did not complete. */
  | "auth_failed"
  /** Approved and signed in before, and now the agent says it is signed out. */
  | "auth_expired"
  /** Signed in, with a kind of sign-in Hubble may not use for this provider. */
  | "auth_unsupported"
  /** Hubble lost the runtime itself — a restart, or the local server stopped. */
  | "connection_lost"
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
  sessions_unavailable: "Signed in · sessions unavailable",
  awaiting_approval: "Awaiting your approval",
  connected: "Connected",
  disconnected: "Disconnected",
  timeout: "Didn't respond",
  auth_failed: "Sign-in failed",
  // Accurate either way: Hubble cannot tell a sign-in that expired from one
  // the person ended in a terminal, and both need the same next step.
  auth_expired: "Sign-in required",
  auth_unsupported: "Sign-in not supported",
  connection_lost: "Connection lost",
  error: "Error",
  unknown: "Not checked yet",
};

/** Which connection action a failure came from. */
export type ConnectionAction = "connect" | "authenticate";

export type ConnectionFacts = {
  provider: PlatformProvider;
  /** Where Hubble is running. Absent means the web. */
  surface?: PlatformSurface;
  /** Hubble is reaching this agent right now. */
  connecting?: boolean;
  /** The agent's own sign-in is open, waiting on the person. */
  authenticating?: boolean;
  /**
   * How the last connect or sign-in Hubble sent for this agent failed, if it
   * did. Cleared when the next one starts. Per provider: one agent's failure
   * is never another's (Agent Authentication & Runtime).
   */
  failure?: { action: ConnectionAction; code: RuntimeErrorCode };
  /** The runtime kept reporting `connecting` past its deadline. */
  stalled?: boolean;
  /** Whether the runtime can execute agents at all. */
  executable: boolean;
  /** Whether the runtime is on the user's own machine (only then is detection meaningful). */
  local: boolean;
  detection?: ProviderDetection;
  /** The runtime's report, from `get_status` or a connect/sign-in reply. */
  status?: RuntimeProviderStatus | ProviderConnectionView;
  /** Whether the user's provider key is connected (for `provider-key` sign-in). */
  providerKeyConnected?: boolean;
  /** Whether a Hubble MCP token has been issued (for `mcp-token` sign-in). */
  mcpTokenIssued?: boolean;
  /** Present when the user approved this agent. */
  approvedScopes?: readonly AgentPermissionScope[];
};

export function connectionPhase(facts: ConnectionFacts): ConnectionPhase {
  const { provider } = facts;
  const surface = facts.surface ?? "web";

  // A connector that cannot work where Hubble is running (a custom MCP
  // agent in the desktop app, which runs no MCP server) says so first.
  if (!provider.surfaces.includes(surface)) return "runtime_unavailable";

  // An MCP client is the one kind Hubble never starts, so neither the
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

  // The last attempt's outcome, while nothing newer has replaced it. Each is
  // terminal: it stays until the person retries, and it never reads as
  // "Connecting…".
  if (facts.failure) {
    const { action, code } = facts.failure;
    if (code === "timeout") return "timeout";
    if (code === "runtime_disconnected") return "connection_lost";
    // A sign-in that did not finish is a failed sign-in, whatever stopped it —
    // the person's next step is the same: try again.
    return action === "authenticate" ? "auth_failed" : "error";
  }
  if (facts.stalled) return "timeout";

  if (facts.status?.connection === "error") return "error";

  if (facts.local) {
    if (facts.detection) {
      if (!facts.detection.installed && !facts.detection.launchable) {
        // The SDK brings its own agent; an absent CLI is not a blocker for it.
        if (provider.transport !== "sdk") return "not_installed";
      }
      if (isLocalProcessTransport(provider.transport) && !facts.detection.launchable) return "needs_adapter";
      // An SDK agent that drives the *installed* CLI (the desktop app) has no
      // runtime to offer when that CLI is absent.
      if (!facts.detection.installed && facts.status?.connection === "unavailable") return "not_installed";
    } else if (!facts.status || (facts.status.authentication === "unknown" && !facts.status.authIssue)) {
      // Neither the machine nor the runtime has said anything definite yet —
      // and "installed" is not claimed on no evidence.
      return "unknown";
    }
    // No detection, but the runtime said something definite about the
    // agent's sign-in (signed out, signed in, not permitted): that decides
    // below, rather than a "not checked yet" that would hide it.
  } else if (isLocalProcessTransport(provider.transport)) {
    // ACP and app-server agents run on the user's machine. A remote runtime cannot reach one.
    return "runtime_unavailable";
  }

  const shape = signInKind(provider, facts.status, surface);

  // A stored key matters only where the runtime has no native sign-in for
  // this agent. In the desktop app Claude uses its own login (Phase J.1), and
  // whether a key is stored in a server Hubble does not have is irrelevant.
  if (shape === "provider-key" && facts.providerKeyConnected === false) return "sign_in_required";

  // Signed in — but with a kind of sign-in this provider does not permit an
  // app like Hubble to use. The runtime refuses sessions on it; the person is
  // shown the permitted method rather than a generic failure.
  if (facts.status?.authIssue === "method_not_permitted") return "auth_unsupported";

  if (facts.status?.authentication === "required") {
    // Approved before — and approving a native agent needed it signed in —
    // so it has since expired or been signed out.
    return facts.approvedScopes && shape === "native" ? "auth_expired" : "sign_in_required";
  }

  // An agent that signs in with its own login was just asked, and could not
  // say. That is not "signed in", and it is not shown as connected (Phase J.2).
  if (shape === "native" && facts.status?.connection === "connected" && facts.status.authentication === "unknown") {
    return "unverified";
  }

  // Signed in, and the runtime reached it — but no session can be started
  // with it, so it is not presented as ready or as awaiting an approval.
  if (
    provider.chat &&
    facts.status?.connection === "connected" &&
    facts.status.authentication === "authenticated" &&
    !sessionAvailability(provider, facts.status).available
  ) {
    return "sessions_unavailable";
  }

  if (!facts.approvedScopes) return facts.status?.connection === "connected" ? "awaiting_approval" : "detected";

  // An agent that signs in with its own login is connected only once this
  // runtime has reached it and it said it is signed in. An approval from an
  // earlier run proves neither.
  if (shape === "native" && facts.status?.connection !== "connected") return "disconnected";
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
      return isLocalProcessTransport(provider.transport)
        ? `${name} is unavailable on this runtime. It runs on your own machine, from the desktop app or a local Hubble.`
        : "Agents cannot run in this Hubble.";
    }
    case "not_installed":
      return `${name} is not installed.`;
    case "needs_adapter":
      return `${name} is installed, but the program Hubble drives it through is not.`;
    case "detected":
      return `${name} is installed.`;
    case "connecting":
      return `Connecting to ${name}…`;
    case "authenticating":
      return `Waiting for you to finish signing in to ${name}…`;
    case "sign_in_required":
      return facts.installed ? `${name} is installed but not authenticated.` : `${name} needs you to sign in.`;
    case "unverified":
      return "Authentication could not be verified.";
    case "sessions_unavailable":
      return `${name} is signed in, but Hubble can't start sessions with it.`;
    case "awaiting_approval":
      return `${name} is ready. Approve what it may do to finish connecting.`;
    case "connected":
      return `${name} is connected.`;
    case "disconnected":
      return `${name} is not connected right now.`;
    case "timeout":
      return `${name} didn't respond in time.`;
    case "auth_failed":
      return `${name} couldn't authenticate.`;
    case "auth_expired":
      return `${name} is no longer signed in. Sign in again to keep using it.`;
    case "auth_unsupported":
      return `${name} is signed in with a method Hubble can't use.`;
    case "connection_lost":
      return "Hubble lost its connection to the agent runtime.";
    case "error":
      return `${name} isn't reachable.`;
    case "unknown":
      return "Hubble has not checked this machine yet.";
  }
}

/**
 * Whether Hubble will start a session with this agent, and if not, why.
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
 * The catalogue's offered methods say how it usually does on this surface;
 * the runtime says whether it can start the agent's own login in this shell.
 * The runtime's answer wins — it is the one that knows which adapter it built.
 */
export function signInKind(
  provider: PlatformProvider,
  status: ConnectionFacts["status"] | undefined,
  surface: PlatformSurface = "web"
): PlatformSignInKind {
  return signInShape(provider, surface, status);
}

/** Phases in which the agent can be talked to. */
export function isChatReady(phase: ConnectionPhase): boolean {
  return phase === "connected";
}

/** Phases that last only while a request is in flight. Everything else is where the agent stays. */
export function isTransientPhase(phase: ConnectionPhase): boolean {
  return phase === "connecting" || phase === "authenticating";
}

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

/**
 * What a person can do about a phase, as closed actions a UI maps to its own
 * handlers. The same for every provider: which *method* "Sign in" starts is
 * the offered-methods question, not this one.
 *
 *   - `sign_in` — start a sign-in the agent offers (or connect a key).
 *   - `retry` — ask the agent again after it failed to answer.
 *   - `check_again` — ask the agent again after the person did something
 *     outside Hubble (installed it, signed in in a terminal).
 *   - `setup` — the provider's own documentation.
 *   - `install` — the install command, to copy. Hubble never runs it.
 *   - `choose_method` — a sign-in Hubble can use, instead of the one in use.
 */
export type RecoveryAction = "sign_in" | "retry" | "check_again" | "setup" | "install" | "choose_method";

export const RECOVERY_LABEL: Record<RecoveryAction, string> = {
  sign_in: "Sign in",
  retry: "Retry",
  check_again: "Check again",
  setup: "Setup",
  install: "Install",
  choose_method: "Use a supported sign-in",
};

export function phaseRecovery(phase: ConnectionPhase): readonly RecoveryAction[] {
  switch (phase) {
    case "sign_in_required":
    case "auth_expired":
      return ["sign_in"];
    case "auth_failed":
      return ["sign_in", "setup"];
    case "timeout":
    case "error":
    case "connection_lost":
      return ["retry", "setup"];
    case "auth_unsupported":
      return ["choose_method", "setup"];
    case "unverified":
    case "disconnected":
    case "detected":
    case "unknown":
      return ["check_again"];
    case "not_installed":
    case "needs_adapter":
      return ["install", "check_again"];
    case "runtime_unavailable":
      return ["setup"];
    // Nothing the person can do in Hubble makes it startable; the reason is
    // shown instead, and another agent is the way forward.
    case "sessions_unavailable":
    case "connecting":
    case "authenticating":
    case "awaiting_approval":
    case "connected":
      return [];
  }
}

/** The label a phase's first recovery action carries — "Sign in", "Retry" — or "Try again" after a failed sign-in. */
export function recoveryLabel(phase: ConnectionPhase, action: RecoveryAction): string {
  if (phase === "auth_failed" && action === "sign_in") return "Try again";
  return RECOVERY_LABEL[action];
}

/* ------------------------------------------------------------------ *
 * Readiness — the observable answer to "can I use this agent?"
 * ------------------------------------------------------------------ */

/**
 * What is true of one agent right now, as answers to the questions a person
 * (or a support engineer) asks. Derived; holds nothing secret — every field
 * is a boolean, a phase or a catalogue entry.
 */
export type AgentReadiness = {
  phase: ConnectionPhase;
  /** `unknown` where this runtime cannot look (not the user's machine). */
  installed: boolean | "unknown";
  /** Hubble reached the agent this runtime. */
  reachable: boolean;
  authenticated: boolean | "unknown";
  /** The method in use, only when the runtime said which. */
  activeMethod?: AgentAuthMethod;
  supportsSubscriptionAuth: boolean;
  /** Something the person must set up outside Hubble first (install, runtime). */
  requiresSetup: boolean;
  authExpired: boolean;
  /**
   * Hubble would start a session: approved, sessions offered, and no
   * prerequisite known to be missing. The runtime still re-checks.
   * Independent of `authenticated`: a signed-in agent can still be false here.
   */
  canCreateSession: boolean;
  /** Why no session can be started with it at all, whatever its sign-in. */
  sessionsUnavailableReason?: string;
  /** Hubble's own features this runtime declares it supports. */
  runtimeSupportsHubble: boolean;
};

export function describeReadiness(facts: ConnectionFacts): AgentReadiness {
  const phase = connectionPhase(facts);
  const surface = facts.surface ?? "web";
  const status = facts.status;
  const capabilities = agentCapabilities(facts.provider, surface);
  const installed: AgentReadiness["installed"] = facts.local
    ? Boolean(facts.detection?.installed || facts.detection?.launchable)
    : "unknown";
  const authenticated: AgentReadiness["authenticated"] =
    status?.authentication === "authenticated"
      ? true
      : status?.authentication === "required" || facts.providerKeyConnected === false
        ? false
        : "unknown";
  const active = activeAuthMethod(facts.provider, status);
  const sessions = sessionAvailability(facts.provider, status);
  return {
    phase,
    installed,
    reachable: status?.connection === "connected",
    authenticated,
    ...(active ? { activeMethod: active } : {}),
    supportsSubscriptionAuth: capabilities.supportsSubscriptionAuth,
    requiresSetup: phase === "not_installed" || phase === "needs_adapter" || phase === "runtime_unavailable",
    authExpired: phase === "auth_expired",
    canCreateSession: sessionPrerequisite({
      provider: facts.provider,
      phase,
      approved: Boolean(facts.approvedScopes),
      sessions,
      surface,
    }).ok,
    runtimeSupportsHubble: Boolean(status?.available && status.capabilities.includes("create_session")),
    ...(facts.provider.chat && !sessions.available ? { sessionsUnavailableReason: sessions.reason } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Session prerequisites
 * ------------------------------------------------------------------ */

/**
 * Whether a session may be started with this agent, and if not, the one
 * sentence and the one action that fix it.
 *
 * Refuses only when a prerequisite is genuinely missing, and never by
 * choosing another sign-in for the person: the action is theirs to take.
 */
export type SessionPrerequisite =
  | { ok: true }
  | { ok: false; reason: string; phase?: ConnectionPhase; action?: RecoveryAction };

/**
 * The phases that *prove* a prerequisite is missing: the runtime cannot run
 * it, the agent is not installed, it is signed out or signed in a way Hubble
 * may not use, its sign-in failed, it is not answering — or Hubble is still
 * asking. Everything else (not checked yet, not reached since a restart,
 * could not say) proves nothing, and the runtime — which re-checks every
 * `create_session` — is left to answer, rather than Hubble refusing on a
 * guess.
 */
const SESSION_BLOCKING_PHASES: readonly ConnectionPhase[] = [
  "runtime_unavailable",
  "not_installed",
  "needs_adapter",
  "connecting",
  "authenticating",
  "sign_in_required",
  "auth_expired",
  "auth_failed",
  "auth_unsupported",
  "timeout",
  "connection_lost",
  "error",
];

export function sessionPrerequisite(input: {
  provider: PlatformProvider;
  phase: ConnectionPhase;
  approved: boolean;
  sessions: { available: true } | { available: false; reason: string };
  surface?: PlatformSurface;
}): SessionPrerequisite {
  const { provider, phase } = input;
  if (!provider.chat || !input.sessions.available) {
    return { ok: false, reason: input.sessions.available ? `${provider.displayName} has no sessions.` : input.sessions.reason };
  }
  if (!input.approved) return { ok: false, reason: "Not connected", action: "sign_in" };
  if (!SESSION_BLOCKING_PHASES.includes(phase)) return { ok: true };
  if (phase === "auth_unsupported") {
    const surface = input.surface ?? "web";
    const refused = unavailableAuthMethods(provider, surface).find((entry) => entry.method.subscription);
    return {
      ok: false,
      phase,
      reason: refused ? `${CONNECTION_PHASE_LABEL[phase]} — ${refused.reason}` : CONNECTION_PHASE_LABEL[phase],
      action: "choose_method",
    };
  }
  const [action] = phaseRecovery(phase);
  return { ok: false, phase, reason: CONNECTION_PHASE_LABEL[phase], ...(action ? { action } : {}) };
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
    case "connection_lost":
      return "detect";
    case "detected":
    case "connecting":
    case "authenticating":
    case "sign_in_required":
    case "unverified":
    case "disconnected":
    case "timeout":
    case "auth_failed":
    case "auth_expired":
    case "auth_unsupported":
    case "sessions_unavailable":
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
 * Reading Hubble content is on, because it is the point of connecting an
 * agent to Hubble. Reading project files is on because an agent that cannot
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
  // An MCP client reads Hubble and nothing else — there is no project.
  if (provider.transport === "mcp") return ["read_workspace"];
  return APPROVABLE_SCOPES.filter((entry) => entry.defaultOn).map((entry) => entry.scope);
}
