import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reconstructHistorySession } from "@/lib/agents/activity/history"
import { buildHandoffEnvelope } from "@/lib/agents/handoff/handoff"
import { prepareHandoffPreview } from "@/lib/agents/handoff/preview"
import { CLAUDE_SESSION, DEMO_HISTORY, DEMO_NOW, HISTORY_IDEAS_HANDOFF, HISTORY_IDEAS_SESSION, HISTORY_ROADMAP_SESSION } from "./data"
import { DemoApp } from "./demo-app"
import { DemoFrame } from "./demo-frame"
import { HubbleDemoProvider } from "./demo-provider"
import type { DemoInit } from "./demo-state"

/*
 * Explicit agent handoff on the landing page (Hubble 1.4) must be Hubble's
 * handoff, not a picture of one.
 *
 *   - **Structural.** The demo opens the very dialog the Command Centre opens
 *     (`HandoffDialog`), lists agents with the same helper, and its
 *     deterministic transport computes the preview and the envelope with the
 *     functions the runtime host uses. Nothing under marketing/ restates the
 *     handoff's words.
 *   - **Behavioural.** Driven like a visitor: Claude Code finishes, "Continue
 *     with…", Codex, the context preview, Continue — Codex receives it, asks
 *     before changing the workspace, the change is applied, and both
 *     sessions show the relationship. No network, no storage.
 */

const SRC = join(process.cwd(), "src")
const read = (path: string) => readFileSync(join(SRC, path), "utf8")

function marketingSources(): Array<{ path: string; source: string }> {
  const walk = (dir: string): string[] =>
    readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : []
    )
  return walk("components/marketing").map((path) => ({ path, source: read(path) }))
}

describe("the demo's handoff is the product's", () => {
  it("opens the Command Centre's own dialog, with the same agent list", () => {
    const demo = read("components/marketing/demo/demo-command-centre.tsx")
    const app = read("components/command-centre/command-centre-view.tsx")
    for (const source of [demo, app]) {
      expect(source).toMatch(/import \{ HandoffDialog, handoffAgentOptions \} from "(@\/components\/command-centre|\.)\/handoff-dialog"/)
      expect(source).toContain("<HandoffDialog")
      expect(source).toContain("handoffAgentOptions(")
      // The same rule for when "Continue with…" is offered.
      expect(source).toContain("canHandOffFrom(")
    }
  })

  it("previews and builds the envelope with the runtime's own functions", () => {
    const host = read("lib/agents/runtime/host.ts")
    const provider = read("components/marketing/demo/demo-provider.tsx")
    for (const name of ["prepareHandoffPreview", "buildHandoffEnvelope", "readHandoffInstruction", "selectHandoffContext"]) {
      expect(host, `host uses ${name}`).toContain(`${name}(`)
      expect(provider, `demo uses ${name}`).toContain(`${name}(`)
    }
  })

  it("never draws or words a handoff itself", () => {
    for (const { path, source } of marketingSources()) {
      expect(source, path).not.toMatch(/data-handoff-(dialog|preview|continue)|DialogContent/)
      for (const words of ["Continue with", "Handoff received", "Previous result", "Couldn't hand off"]) {
        expect(source, `${path} restates "${words}"`).not.toContain(words)
      }
    }
  })

  it("its past handoff is what the runtime would have recorded from that session's own records", () => {
    const ideas = DEMO_HISTORY.find((entry) => entry.session.sessionId === HISTORY_IDEAS_SESSION)!
    const history = reconstructHistorySession(ideas)
    const { preview } = prepareHandoffPreview({
      // The session as it stood when the person continued it: its records up to the handoff.
      session: { ...history.session, status: "completed" },
      workspaceId: ideas.session.workspaceId,
      events: history.events.filter((event) => event.kind !== "handoff_sent"),
      knownApprovals: history.knownApprovals,
      changes: history.changes,
      targetProvider: "openai-codex",
      contextTools: true,
      now: DEMO_NOW,
    })
    expect(HISTORY_IDEAS_HANDOFF.context.previousResult).toEqual(preview.context.previousResult)
    // And the past session's envelope is the product's envelope.
    const roadmap = DEMO_HISTORY.find((entry) => entry.session.sessionId === HISTORY_ROADMAP_SESSION)!
    expect(roadmap.session.handoff?.from).toMatchObject({ sessionId: HISTORY_IDEAS_SESSION, provider: "claude-code" })
    expect(ideas.session.handoff?.to?.[0]).toMatchObject({ sessionId: HISTORY_ROADMAP_SESSION, provider: "openai-codex" })
    expect(
      buildHandoffEnvelope({ workspaceName: "Research", sourceProvider: "claude-code", context: HISTORY_IDEAS_HANDOFF.context, contextTools: true })
    ).toContain("- Created collection “Product Ideas” (3 tabs)")
  })
})

/* ------------------------------------------------------------------ *
 * Driven like a visitor
 * ------------------------------------------------------------------ */

let fetchSpy: ReturnType<typeof vi.fn>
const isFaviconLookup = (input: unknown) => String(input).includes("/api/favicon?")

beforeEach(() => {
  window.localStorage.clear()
  fetchSpy = vi.fn(() => Promise.reject(new Error("the demo must not fetch")))
  vi.stubGlobal("fetch", fetchSpy)
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})

afterEach(() => {
  expect(window.localStorage.length).toBe(0)
  expect(fetchSpy.mock.calls.filter(([input]) => !isFaviconLookup(input))).toEqual([])
  vi.unstubAllGlobals()
})

function renderWindow(init: DemoInit) {
  const user = userEvent.setup()
  render(
    <HubbleDemoProvider init={init}>
      <DemoFrame palette label="Hubble demo">
        <DemoApp />
      </DemoFrame>
    </HubbleDemoProvider>
  )
  const frame = () => within(screen.getByRole("region", { name: "Hubble demo" }))
  const activity = () => within(within(frame().getByRole("complementary", { name: "Session context" })).getByRole("region", { name: "Activity" }))
  const titles = () =>
    activity()
      .getAllByRole("listitem")
      .map((row) => row.querySelector("[data-activity-title]")?.textContent)
      .filter(Boolean)
  const sessions = () => within(frame().getByRole("navigation", { name: "Agent sessions" }))
  return { user, frame, activity, titles, sessions }
}

describe("a visitor hands Claude Code's work to Codex", () => {
  it("finish → Continue with… → Codex → preview → Continue → handoff received → approval → applied → linked", async () => {
    const { user, frame, activity, titles, sessions } = renderWindow({ view: "command-centre", selectedSessionId: CLAUDE_SESSION, contextPanelOpen: true })

    // Claude Code is mid-approval: no handoff is offered while a decision is owed.
    expect(activity().queryByRole("button", { name: "Continue with…" })).toBeNull()
    await user.click(within(frame().getByRole("group", { name: "Approval required" })).getByRole("button", { name: /Allow/ }))
    await waitFor(() => expect(titles()[0]).toBe("Finished"), { timeout: 3_000 })

    // Continue with… — the connected-agent roster.
    await user.click(activity().getByRole("button", { name: "Continue with…" }))
    const dialog = () => within(screen.getByRole("dialog"))
    expect(dialog().getByRole("heading", { name: "Continue with…" })).toBeTruthy()
    await user.click(dialog().getByRole("button", { name: "Continue with Codex" }))

    // The preview, as the runtime would compute it from Claude Code's records.
    await waitFor(() => expect(dialog().getByRole("heading", { name: "Continue with Codex" })).toBeTruthy())
    expect(dialog().getByText("Workspace context")).toBeTruthy()
    expect(dialog().getByText(/\d+ tabs · \d+ collections/)).toBeTruthy()
    expect(dialog().getByText("Previous result")).toBeTruthy()
    expect(dialog().getByText("Created collection “SWE-bench”")).toBeTruthy()
    await user.type(dialog().getByLabelText("Instruction"), "Turn this into an implementation plan.")
    await user.click(dialog().getByRole("button", { name: "Continue" }))

    // Codex's session opens, and starts where the handoff left it.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(titles()).toContain("Handoff received"))
    expect(titles().at(-1)).toMatch(/Codex connected$/)
    expect(titles()).toEqual(expect.arrayContaining(["Handoff received", "Workspace context loaded"]))
    expect(titles()).not.toContain("You sent a message")

    // Codex asks before changing the workspace — the handoff granted nothing.
    await waitFor(() => expect(frame().getByRole("group", { name: "Approval required" })).toBeTruthy(), { timeout: 3_000 })
    await user.click(within(frame().getByRole("group", { name: "Approval required" })).getByRole("button", { name: /Allow/ }))
    await waitFor(() => expect(titles()).toContain("Created collection “Implementation Plan”"), { timeout: 3_000 })
    await waitFor(() => expect(titles()[0]).toBe("Finished"), { timeout: 3_000 })

    // The handoff opens in the same inspector.
    await user.click(activity().getByRole("button", { name: /Handoff received/ }))
    const inspector = within(activity().getByRole("article"))
    expect(inspector.getByText("Claude Code")).toBeTruthy()
    expect(inspector.getByText("Turn this into an implementation plan.")).toBeTruthy()
    expect(inspector.getByText(/A handoff doesn't change the workspace/)).toBeTruthy()

    // Both sessions, linked in the list without a diagram.
    const relations = sessions()
      .getAllByRole("button")
      .map((row) => row.querySelector("[data-handoff-relation]")?.textContent)
      .filter(Boolean)
    expect(relations).toEqual(expect.arrayContaining([expect.stringContaining("→ Codex"), expect.stringContaining("← Claude Code")]))

    // And the source's activity says where the work went, with a way there.
    await user.click(inspector.getByRole("button", { name: "Open Claude Code session" }))
    await waitFor(() => expect(titles()).toContain("Handed off to Codex"))
  }, 20_000)

  it("shows a past handoff in history, linked both ways", async () => {
    const { user, frame } = renderWindow({ view: "command-centre", selectedSessionId: null, contextPanelOpen: true })
    const history = within(frame().getByRole("region", { name: "Agent history" }))
    expect(history.getByRole("button", { name: /Group the product ideas/ }).textContent).toContain("→ Codex")
    expect(history.getByRole("button", { name: /Turn the ideas into a roadmap/ }).textContent).toContain("← Claude Code")
    await user.click(history.getByRole("button", { name: /Turn the ideas into a roadmap/ }))
    const pane = within(frame().getByRole("region", { name: "Past agent session" }))
    expect(pane.getByText("Handoff received")).toBeTruthy()
    await user.click(pane.getByRole("button", { name: "Open Claude Code session" }))
    await waitFor(() => expect(within(frame().getByRole("region", { name: "Past agent session" })).getByText("Handed off to Codex")).toBeTruthy())
  })
})
