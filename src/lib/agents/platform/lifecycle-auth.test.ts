import { describe, expect, it } from "vitest";
import { platformProvider } from "./catalog";
import {
  CONNECTION_PHASE_LABEL,
  connectionPhase,
  describeReadiness,
  isTransientPhase,
  phaseRecovery,
  phaseSentence,
  recoveryLabel,
  sessionPrerequisite,
  stepFor,
} from "./lifecycle";
import type { ConnectionFacts, ConnectionPhase } from "./lifecycle";
import type { ProviderConnectionView, ProviderDetection } from "@/lib/agents/runtime/protocol";

/**
 * The runtime-availability state machine (Agent Authentication & Runtime).
 *
 * DISCOVERING → NOT_INSTALLED / INSTALLED → AUTHENTICATION_REQUIRED →
 * AUTHENTICATING → AUTHENTICATED → READY, and the terminal failures: timeout,
 * sign-in failed, sign-in expired, sign-in not supported, connection lost,
 * unreachable. Every one is derived from facts, and no transient phase can be
 * shown once the request behind it is over.
 */

const claude = platformProvider("claude-code")!;
const gemini = platformProvider("gemini")!;
const codex = platformProvider("openai-codex")!;

const INSTALLED: ProviderDetection = { provider: "gemini", installed: true, transport: "acp", launchable: true };
const CLAUDE_INSTALLED: ProviderDetection = { provider: "claude-code", installed: true, transport: "sdk", launchable: false };

function reached(over: Partial<ProviderConnectionView> = {}): ProviderConnectionView {
  return {
    provider: "gemini",
    connection: "connected",
    available: true,
    authentication: "authenticated",
    capabilities: ["create_session", "message"],
    nativeSignIn: true,
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
    ...over,
  };
}

const local = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  provider: gemini,
  surface: "desktop",
  executable: true,
  local: true,
  detection: INSTALLED,
  ...over,
});

describe("the happy path, in order", () => {
  it("walks discovering → installed → sign-in required → authenticating → authenticated → ready", () => {
    expect(connectionPhase(local({ detection: undefined }))).toBe("unknown");
    expect(connectionPhase(local())).toBe("detected");
    expect(connectionPhase(local({ connecting: true }))).toBe("connecting");
    expect(connectionPhase(local({ status: reached({ authentication: "required" }) }))).toBe("sign_in_required");
    expect(connectionPhase(local({ authenticating: true, status: reached({ authentication: "required" }) }))).toBe(
      "authenticating"
    );
    expect(connectionPhase(local({ status: reached() }))).toBe("awaiting_approval");
    expect(connectionPhase(local({ status: reached(), approvedScopes: ["read_workspace"] }))).toBe("connected");
  });

  it("says not installed before anything about sign-in", () => {
    expect(
      connectionPhase(local({ detection: { ...INSTALLED, installed: false, launchable: false }, status: reached() }))
    ).toBe("not_installed");
  });
});

describe("every transient phase ends", () => {
  it("is transient only while a request is in flight", () => {
    const transient = (["connecting", "authenticating"] as ConnectionPhase[]).every(isTransientPhase);
    expect(transient).toBe(true);
    for (const phase of Object.keys(CONNECTION_PHASE_LABEL) as ConnectionPhase[]) {
      if (phase === "connecting" || phase === "authenticating") continue;
      expect(`${phase}: ${isTransientPhase(phase)}`).toBe(`${phase}: false`);
    }
  });

  it("turns a connect that timed out into a timeout, not Connecting…", () => {
    expect(connectionPhase(local({ failure: { action: "connect", code: "timeout" } }))).toBe("timeout");
    expect(phaseSentence(gemini, "timeout")).toBe("Gemini CLI didn't respond in time.");
    expect(phaseRecovery("timeout")).toEqual(["retry", "setup"]);
  });

  it("turns a runtime that keeps reporting `connecting` into a timeout once the watchdog fires", () => {
    const stuck = reached({ connection: "connecting", authentication: "unknown" });
    expect(connectionPhase(local({ status: stuck }))).not.toBe("connecting");
    expect(connectionPhase(local({ status: stuck, stalled: true }))).toBe("timeout");
  });

  it("lets a new attempt replace a failure — Retry moves it on", () => {
    expect(connectionPhase(local({ connecting: true, failure: { action: "connect", code: "timeout" } }))).toBe(
      "connecting"
    );
  });
});

describe("terminal failures, each with its own next step", () => {
  it("authentication failure: couldn't authenticate, try again", () => {
    for (const code of ["provider_error", "authentication_required", "invalid_request"] as const) {
      expect(connectionPhase(local({ failure: { action: "authenticate", code } }))).toBe("auth_failed");
    }
    expect(phaseSentence(claude, "auth_failed")).toBe("Claude Code couldn't authenticate.");
    expect(recoveryLabel("auth_failed", phaseRecovery("auth_failed")[0]!)).toBe("Try again");
  });

  it("runtime unavailable / unreachable: isn't reachable, retry or set up", () => {
    expect(connectionPhase(local({ failure: { action: "connect", code: "provider_unavailable" } }))).toBe("error");
    expect(connectionPhase(local({ status: reached({ connection: "error" }) }))).toBe("error");
    expect(phaseSentence(claude, "error")).toBe("Claude Code isn't reachable.");
    expect(phaseRecovery("error")).toEqual(["retry", "setup"]);
    expect(connectionPhase(local({ executable: false }))).toBe("runtime_unavailable");
  });

  it("connection loss: the runtime itself went away", () => {
    expect(connectionPhase(local({ failure: { action: "connect", code: "runtime_disconnected" } }))).toBe(
      "connection_lost"
    );
    expect(connectionPhase(local({ failure: { action: "authenticate", code: "runtime_disconnected" } }))).toBe(
      "connection_lost"
    );
    expect(phaseRecovery("connection_lost")[0]).toBe("retry");
  });

  it("expired authentication: approved before, signed out now", () => {
    const facts = local({ status: reached({ authentication: "required" }), approvedScopes: ["read_workspace"] });
    expect(connectionPhase(facts)).toBe("auth_expired");
    expect(phaseSentence(gemini, "auth_expired")).toBe("Gemini CLI is no longer signed in. Sign in again to keep using it.");
    expect(phaseRecovery("auth_expired")).toEqual(["sign_in"]);
    expect(describeReadiness(facts).authExpired).toBe(true);
  });

  it("a sign-in Hubble may not use: signed in, not supported, and the permitted method offered", () => {
    const facts = local({
      provider: claude,
      detection: CLAUDE_INSTALLED,
      status: reached({
        provider: "claude-code",
        connection: "configuration_required",
        authKind: "subscription",
        authIssue: "method_not_permitted",
      }),
      approvedScopes: ["read_workspace"],
    });
    expect(connectionPhase(facts)).toBe("auth_unsupported");
    expect(phaseRecovery("auth_unsupported")[0]).toBe("choose_method");
    expect(stepFor("auth_unsupported")).toBe("sign_in");
    const readiness = describeReadiness(facts);
    expect(readiness.authenticated).toBe(true);
    expect(readiness.activeMethod?.id).toBe("claude-subscription");
    expect(readiness.canCreateSession).toBe(false);
  });
});

describe("API-key and account authentication", () => {
  it("API key (Claude on the web): no key is sign-in required; a key moves it on", () => {
    const web = { provider: claude, surface: "web" as const, executable: true, local: true, detection: CLAUDE_INSTALLED };
    const status = reached({ provider: "claude-code", authentication: "unknown", nativeSignIn: undefined, authMethods: [] });
    expect(connectionPhase({ ...web, status, providerKeyConnected: false })).toBe("sign_in_required");
    expect(connectionPhase({ ...web, status, providerKeyConnected: true })).toBe("awaiting_approval");
  });

  it("account (the agent's own sign-in): only the agent's answer counts, and 'could not say' is not signed in", () => {
    expect(connectionPhase(local({ status: reached({ authentication: "unknown" }) }))).toBe("unverified");
    expect(connectionPhase(local({ status: reached({ authentication: "unknown" }), approvedScopes: ["read_workspace"] }))).toBe(
      "unverified"
    );
  });

  it("a stored key is irrelevant where the agent signs in on its own (Claude in the desktop app)", () => {
    const desktop = local({
      provider: claude,
      detection: CLAUDE_INSTALLED,
      status: reached({ provider: "claude-code", authKind: "account" }),
      providerKeyConnected: false,
      approvedScopes: ["read_workspace"],
    });
    expect(connectionPhase(desktop)).toBe("connected");
  });
});

describe("provider isolation", () => {
  it("derives one provider's phase from its own facts only", () => {
    const claudeFailed = local({
      provider: claude,
      detection: CLAUDE_INSTALLED,
      failure: { action: "authenticate", code: "provider_error" },
    });
    const geminiReady = local({ status: reached(), approvedScopes: ["read_workspace"] });
    expect(connectionPhase(claudeFailed)).toBe("auth_failed");
    // Gemini's phase is computed from Gemini's facts; Claude's failure is not
    // an input to it and cannot become one.
    expect(connectionPhase(geminiReady)).toBe("connected");
  });
});

describe("session prerequisites", () => {
  const sessions = { available: true } as const;

  it("refuses only what is genuinely missing, with the action that fixes it", () => {
    expect(sessionPrerequisite({ provider: gemini, phase: "connected", approved: true, sessions })).toEqual({ ok: true });
    expect(sessionPrerequisite({ provider: gemini, phase: "sign_in_required", approved: true, sessions })).toMatchObject({
      ok: false,
      action: "sign_in",
    });
    expect(sessionPrerequisite({ provider: gemini, phase: "timeout", approved: true, sessions })).toMatchObject({
      ok: false,
      action: "retry",
    });
    expect(sessionPrerequisite({ provider: gemini, phase: "connecting", approved: true, sessions })).toMatchObject({ ok: false });
    expect(sessionPrerequisite({ provider: gemini, phase: "sign_in_required", approved: false, sessions })).toEqual({
      ok: false,
      reason: "Not connected",
      action: "sign_in",
    });
  });

  it("does not refuse on a guess — not checked, not reached yet, could not say — the runtime re-checks", () => {
    for (const phase of ["unknown", "detected", "disconnected", "unverified"] as const) {
      expect(sessionPrerequisite({ provider: gemini, phase, approved: true, sessions })).toEqual({ ok: true });
    }
  });

  it("explains a refused sign-in with the provider's own reason", () => {
    const refused = sessionPrerequisite({ provider: claude, phase: "auth_unsupported", approved: true, sessions, surface: "desktop" });
    expect(refused).toMatchObject({ ok: false, action: "choose_method" });
    expect(!refused.ok && refused.reason).toMatch(/doesn't allow apps built on the Claude Agent SDK/);
  });

  it("never offers a session for an agent whose sessions are refused, whatever its sign-in", () => {
    const refused = { available: false as const, reason: "Hubble will not start sessions with this agent." };
    expect(
      sessionPrerequisite({ provider: { ...gemini, sessions: refused }, phase: "connected", approved: true, sessions: refused })
    ).toMatchObject({ ok: false });
  });
});

describe("sentences stay safe", () => {
  it("puts no path, command or provider text in the new sentences", () => {
    for (const phase of ["timeout", "auth_failed", "auth_expired", "auth_unsupported", "connection_lost", "error"] as const) {
      expect(phaseSentence(claude, phase)).not.toMatch(/[\\/]|npm |--|\.exe|\.json|sk-/);
    }
  });
});

/**
 * AUTHENTICATED ≠ SESSION_READY. A provider is ready for the command centre
 * only when it is signed in *and* Hubble can start a session with it — the
 * catalogue allows sessions and the runtime's adapter declares
 * `create_session`. Checked for every provider Hubble launches.
 */
describe("signed in is not session-ready", () => {
  const grok = platformProvider("grok")!;
  /**
   * Codex where Hubble has not verified its approvals (anywhere but Windows):
   * the adapter reaches it and reads its sign-in, and declares no capability.
   */
  const codexUnverified = (over: Partial<ConnectionFacts> = {}): ConnectionFacts =>
    local({
      provider: codex,
      detection: { provider: "openai-codex", installed: true, transport: "app-server", launchable: true },
      status: reached({
        provider: "openai-codex",
        capabilities: [],
        authKind: "subscription",
        authMethods: [{ id: "chatgpt", name: "Sign in with ChatGPT" }],
      }),
      ...over,
    });

  it("shows a signed-in Codex on an unverified platform as signed in with sessions unavailable — never awaiting an approval it cannot be given", () => {
    expect(connectionPhase(codexUnverified())).toBe("sessions_unavailable");
    expect(CONNECTION_PHASE_LABEL.sessions_unavailable).toBe("Signed in · sessions unavailable");
    expect(phaseSentence(codex, "sessions_unavailable")).toBe(
      "Codex is signed in, but Hubble can't start sessions with it."
    );
    // Nothing in Hubble fixes it, so no recovery pretends to.
    expect(phaseRecovery("sessions_unavailable")).toEqual([]);
    expect(isTransientPhase("sessions_unavailable")).toBe(false);
    expect(stepFor("sessions_unavailable")).toBe("sign_in");
  });

  it("does not become connected even when an old roster entry approved it", () => {
    expect(connectionPhase(codexUnverified({ approvedScopes: ["read_workspace", "read_project"] }))).toBe(
      "sessions_unavailable"
    );
  });

  it("keeps Codex's real sign-in state when it is not signed in", () => {
    expect(
      connectionPhase(codexUnverified({ status: reached({ provider: "openai-codex", capabilities: [], authentication: "required" }) }))
    ).toBe("sign_in_required");
  });

  it("reports authenticated and not session-ready separately, with the runtime's reason", () => {
    const readiness = describeReadiness(codexUnverified({ approvedScopes: ["read_workspace"] }));
    expect(readiness.authenticated).toBe(true);
    expect(readiness.canCreateSession).toBe(false);
    expect(readiness.runtimeSupportsHubble).toBe(false);
    expect(readiness.sessionsUnavailableReason).toBe("Codex cannot start sessions on this runtime yet.");
  });

  it("treats Codex as session-ready once the runtime proves it — signed in with ChatGPT, sessions declared, approved", () => {
    expect(codex.sessions.available).toBe(true);
    const facts = codexUnverified({
      status: reached({ provider: "openai-codex", capabilities: ["create_session", "message", "approvals"], authKind: "subscription" }),
      approvedScopes: ["read_workspace", "read_project", "run_commands"],
    });
    expect(connectionPhase(facts)).toBe("connected");
    expect(describeReadiness(facts).canCreateSession).toBe(true);
    // Reached but not yet asked about sign-in: never shown as connected.
    expect(connectionPhase({ ...facts, status: { ...facts.status!, authentication: "unknown" } })).toBe("unverified");
    // Merely installed is not connected either.
    expect(connectionPhase({ ...facts, status: undefined })).toBe("disconnected");
  });

  it("treats Gemini and Grok as session-ready once signed in and approved", () => {
    for (const [provider, detection] of [
      [gemini, INSTALLED],
      [grok, { provider: "grok", installed: true, transport: "acp", launchable: true } as ProviderDetection],
    ] as const) {
      const facts = local({
        provider,
        detection,
        status: reached({ provider: provider.provider, capabilities: ["create_session", "message"] }),
        approvedScopes: ["read_workspace", "read_project"],
      });
      expect(connectionPhase(facts)).toBe("connected");
      const readiness = describeReadiness(facts);
      expect(readiness.authenticated).toBe(true);
      expect(readiness.canCreateSession).toBe(true);
      expect(readiness.sessionsUnavailableReason).toBeUndefined();
    }
  });

  it("treats Claude Code as session-ready only with a sign-in it may use", () => {
    const claudeFacts = (over: Partial<ProviderConnectionView>): ConnectionFacts => ({
      provider: claude,
      surface: "desktop",
      executable: true,
      local: true,
      detection: CLAUDE_INSTALLED,
      status: reached({ provider: "claude-code", capabilities: ["create_session", "message"], ...over }),
      approvedScopes: ["read_workspace", "read_project"],
    });
    expect(describeReadiness(claudeFacts({})).canCreateSession).toBe(true);
    const subscription = describeReadiness(claudeFacts({ authKind: "subscription", authIssue: "method_not_permitted" }));
    expect(subscription.authenticated).toBe(true);
    expect(subscription.canCreateSession).toBe(false);
  });

  it("is not session-ready when the runtime's adapter declares no create_session, whatever the catalogue says", () => {
    const facts = local({ status: reached({ capabilities: ["message"] }), approvedScopes: ["read_workspace"] });
    expect(connectionPhase(facts)).toBe("sessions_unavailable");
    expect(describeReadiness(facts)).toMatchObject({ authenticated: true, canCreateSession: false });
  });
});
