import { describe, expect, it } from "vitest"
import { AGENT_SESSION_STATUSES } from "@/lib/agents/control/session"
import { AGENT_CONTROL_EVENT_KINDS } from "@/lib/agents/control/events"
import { RUNTIME_ERROR_CODES } from "@/lib/agents/runtime/protocol"
import {
  EVENT_PRESENTATION,
  RUNTIME_ERROR_PRESENTATION,
  SESSION_STATUS_DETAIL,
  SESSION_STATUS_LABEL,
  SESSION_VISUAL_STATE,
  TERMINAL_SESSION_STATUSES,
  canCreateSession,
  providerRowState,
  canSendMessage,
  isLiveSession,
  isTerminalSession,
  providerUnavailableReason,
  runtimeBanner,
  sessionOrigin,
} from "./presentation"
import { scriptedStatus } from "./__fixtures__/runtime-client"
import type { RuntimeProviderStatus } from "@/lib/agents/runtime/protocol"

/**
 * The presentation layer's job is to restate backend state without adding to
 * it, so these tests are mostly about *totality* and about the handful of
 * places where the obvious mapping would be wrong.
 */

describe("every closed union is covered", () => {
  /*
    Totality is the property that makes this module safe to trust. A status,
    event kind or error code with no entry would render as `undefined` — an
    unlabelled pill, a blank row, an error with no text — and TypeScript's
    Record check catches it at build time only while the unions stay closed.
    These assert it at runtime too, so a union widened through a cast cannot
    slip past.
  */
  it("labels and explains every session status", () => {
    for (const status of AGENT_SESSION_STATUSES) {
      expect(SESSION_STATUS_LABEL[status], status).toBeTruthy()
      expect(SESSION_STATUS_DETAIL[status], status).toBeTruthy()
      expect(SESSION_VISUAL_STATE[status], status).toBeTruthy()
    }
  })

  it("presents every control event kind", () => {
    for (const kind of AGENT_CONTROL_EVENT_KINDS) {
      expect(EVENT_PRESENTATION[kind], kind).toBeDefined()
    }
  })

  it("gives every runtime error a title and an action", () => {
    for (const code of RUNTIME_ERROR_CODES) {
      const presentation = RUNTIME_ERROR_PRESENTATION[code]
      expect(presentation, code).toBeDefined()
      expect(presentation.title, code).toBeTruthy()
      // The brief forbids "Something went wrong": every code has to say what
      // the user can do next, not merely that something failed.
      expect(presentation.action, code).toBeTruthy()
    }
  })

  it("never renders a runtime error as a generic failure", () => {
    const titles = RUNTIME_ERROR_CODES.map((code) => RUNTIME_ERROR_PRESENTATION[code].title)
    expect(titles).not.toContain("Something went wrong")
    // Distinct titles, so two different refusals are not indistinguishable.
    expect(new Set(titles).size).toBe(titles.length)
  })
})

describe("what the composer may do", () => {
  it("accepts a message only in the states that genuinely take one", () => {
    expect(canSendMessage("ready")).toBe(true)
    expect(canSendMessage("waiting_for_input")).toBe(true)
    expect(canSendMessage("created")).toBe(true)
  })

  it("refuses to accept a message while the agent is working", () => {
    // Not merely "non-terminal": the control plane answers
    // `invalid_session_state` here, and offering the composer would promise
    // something already known to fail.
    expect(canSendMessage("running")).toBe(false)
    expect(canSendMessage("connecting")).toBe(false)
  })

  it("refuses to accept a message while an approval is outstanding", () => {
    expect(canSendMessage("waiting_for_approval")).toBe(false)
  })

  it("refuses every terminal state", () => {
    for (const status of TERMINAL_SESSION_STATUSES) {
      expect(canSendMessage(status), status).toBe(false)
      expect(isTerminalSession(status), status).toBe(true)
    }
  })

  it("treats only connecting and running as live", () => {
    expect(isLiveSession("running")).toBe(true)
    expect(isLiveSession("connecting")).toBe(true)
    expect(isLiveSession("waiting_for_approval")).toBe(false)
    expect(isLiveSession("ready")).toBe(false)
  })
})

describe("the runtime banner reports only what it was told", () => {
  it("treats no status at all as disconnected, not as ready", () => {
    const banner = runtimeBanner(null)
    expect(banner.tone).toBe("bad")
    expect(banner.reconnectable).toBe(true)
  })

  it("reports a ready runtime when the host said it is executable", () => {
    expect(runtimeBanner(scriptedStatus()).tone).toBe("good")
  })

  it("uses the gate's own sentence when execution is refused", () => {
    const banner = runtimeBanner(
      scriptedStatus({ executable: false, detail: "Agents cannot run on a hosted deployment." })
    )
    expect(banner.detail).toBe("Agents cannot run on a hosted deployment.")
    // Not offered as reconnectable: this is a property of the deployment, and
    // a Reconnect button would invite the user to retry something fixed.
    expect(banner.reconnectable).toBe(false)
  })

  it("still explains itself when the host gave no detail", () => {
    const banner = runtimeBanner(scriptedStatus({ executable: false }))
    expect(banner.detail).toBeTruthy()
  })
})

describe("provider capability is never inferred", () => {
  function provider(over: Partial<RuntimeProviderStatus> = {}): RuntimeProviderStatus {
    return {
      provider: "claude-code",
      connection: "connected",
      available: true,
      authentication: "unknown",
      capabilities: ["create_session"],
      ...over,
    }
  }

  it("requires both availability and a declared capability", () => {
    expect(canCreateSession(provider())).toBe(true)
    expect(canCreateSession(provider({ available: false }))).toBe(false)
    expect(canCreateSession(provider({ capabilities: [] }))).toBe(false)
  })

  it("explains an unavailable provider rather than merely disabling it", () => {
    expect(providerUnavailableReason(provider())).toBeNull()
    expect(providerUnavailableReason(provider({ available: false }))).toBeTruthy()
    expect(providerUnavailableReason(provider({ capabilities: [] }))).toBeTruthy()
    expect(
      providerUnavailableReason(provider({ connection: "configuration_required" }))
    ).toBeTruthy()
  })

  it("does not treat a connected provider as able to start a session", () => {
    // Codex's situation on this branch: present, registered, and declaring no
    // `create_session`. It must not be offered as startable.
    const codex = provider({ provider: "openai-codex", capabilities: ["observe"] })
    expect(canCreateSession(codex)).toBe(false)
  })
})

describe("origin is a function of the correlation, not of the provider", () => {
  it("names each combination", () => {
    expect(sessionOrigin({ controlRunId: "r1" })).toBe("controlled")
    expect(sessionOrigin({ observationRunId: "o1" })).toBe("observed")
    expect(sessionOrigin({ controlRunId: "r1", observationRunId: "o1" })).toBe(
      "controlled-and-observed"
    )
  })

  it("does not claim control when nothing correlates", () => {
    // The specific failure this guards: a session that exists because a
    // provider exists is not evidence that TabDump started it.
    expect(sessionOrigin({})).toBe("unknown")
  })
})

describe("provider rows (Phase J.2)", () => {
  const base = { provider: "gemini" as const, available: true, capabilities: [] }
  it("says sign-in required for an agent that was reached but says it is signed out", () => {
    expect(providerRowState({ ...base, connection: "connected", authentication: "required" })).toEqual({ label: "Sign-in required", tone: "idle" })
  })
  it("says connected only when the agent did not say otherwise", () => {
    expect(providerRowState({ ...base, connection: "connected", authentication: "authenticated" }).label).toBe("Connected")
  })
})
