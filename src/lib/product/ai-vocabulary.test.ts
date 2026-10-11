import { describe, expect, it } from "vitest"
import { CONNECTION_PHASE_LABEL } from "@/lib/agents/platform/lifecycle"
import { aiConnectionState, aiName, aiRecoverySentence } from "./ai-vocabulary"
import type { ConnectionPhase } from "@/lib/agents/platform/lifecycle"

const PHASES = Object.keys(CONNECTION_PHASE_LABEL) as ConnectionPhase[]
// Words for machinery, in any case — and raw errors, as they are written.
const TECHNICAL = /runtime|adapter|\bACP\b|\bMCP\b|\bCLI\b|session|bridge|transport/i
const RAW_ERROR = /ECONN|127\.0\.0\.1|Error:/

describe("AI vocabulary", () => {
  it("uses the names students know", () => {
    expect(aiName("claude-code")).toBe("Claude")
    expect(aiName("gemini")).toBe("Gemini")
    expect(aiName("openai-codex")).toBe("Codex")
    expect(aiName("grok")).toBe("Grok")
    expect(aiName(undefined)).toBe("AI")
  })

  it("words every connection phase without implementation detail", () => {
    for (const phase of PHASES) {
      const state = aiConnectionState(phase)
      expect(state.label, phase).not.toMatch(TECHNICAL)
      expect(state.label, phase).not.toMatch(RAW_ERROR)
      if (state.action) expect(state.action, phase).not.toMatch(TECHNICAL)
    }
  })

  it("gives every state that needs the student exactly one way forward", () => {
    for (const phase of PHASES) {
      const state = aiConnectionState(phase)
      if (state.kind === "broken" || state.kind === "needs-you" || state.kind === "installed") expect(state.action, phase).toBeTruthy()
    }
    expect(aiConnectionState("connected")).toEqual({ kind: "connected", label: "Connected" })
    expect(aiConnectionState("detected")).toMatchObject({ kind: "installed", action: "Connect" })
    expect(aiConnectionState("connection_lost")).toMatchObject({ kind: "broken", label: "Needs reconnecting", action: "Fix connection" })
  })

  it("never puts a raw error in the recovery sentence", () => {
    expect(aiRecoverySentence("claude-code")).toBe("We couldn't connect to Claude.")
  })
})
