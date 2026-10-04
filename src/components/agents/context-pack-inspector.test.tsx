import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ContextPackInspector } from "./context-pack-inspector"
import { HistorySessionView } from "@/components/command-centre/history-session-view"
import { emptyContextWorld } from "@/lib/agents/context/world"
import { buildContextPack } from "@/lib/agents/context-pack/pack"
import type { ContextPack, ContextPackInput } from "@/lib/agents/context-pack/pack"

const T0 = 1_700_000_000_000
const LONG = "An extraordinarily long collection name that would never fit on one line of a 288 pixel panel"

function pack(input: Partial<ContextPackInput> = {}, tabs = 6): ContextPack {
  const result = buildContextPack({
    world: {
      ...emptyContextWorld(null),
      workspaces: [
        {
          id: "w1",
          name: "Research",
          tabs: Array.from({ length: tabs }, (_, index) => ({
            id: `t${index}`,
            url: `https://example.com/${index}`,
            normalizedUrl: `https://example.com/${index}`,
            domain: "example.com",
            title: `Source ${index}`,
          })),
          brief: { description: "Climate policy sources.", focus: "Carbon pricing.", updatedAt: T0 },
          createdAt: T0,
          updatedAt: T0,
        },
      ],
      collections: [{ id: "c1", workspaceId: "w1", name: LONG, tabIds: ["t0"], createdAt: T0, updatedAt: T0 }],
    },
    selection: { workspaceId: "w1", tabIds: [], collectionIds: [] },
    ...input,
  })
  if (!result.ok) throw new Error(result.reason)
  return result.pack
}

describe("ContextPackInspector", () => {
  it("lists exactly the pack, in words — no ids, no placeholders", () => {
    render(<ContextPackInspector pack={pack({ instruction: "Compare the pricing models." })} agentName="Claude Code" state="delivered" />)
    expect(screen.getByText("Research")).toBeTruthy()
    expect(screen.getByText("Climate policy sources.")).toBeTruthy()
    expect(screen.getByText("Carbon pricing.")).toBeTruthy()
    expect(screen.getByText("Whole workspace")).toBeTruthy()
    expect(screen.getByText("All 6 · read on request")).toBeTruthy()
    expect(screen.getByText("“Compare the pricing models.”")).toBeTruthy()
    expect(screen.getByText("Claude Code has this")).toBeTruthy()
    const text = document.body.textContent ?? ""
    expect(text).not.toMatch(/undefined|null|\bc1\b|\bw1\b|pack-/)
  })

  it("shows selected resources, keeps long names on one line with the full name on hover, and expands a long list", async () => {
    const user = userEvent.setup()
    render(<ContextPackInspector pack={pack({ selection: { workspaceId: "w1", tabIds: ["t1", "t2", "t3", "t4", "t5"], collectionIds: ["c1"] } })} agentName="Gemini CLI" />)
    const collections = screen.getByText(LONG)
    expect(collections.className).toContain("truncate")
    expect(collections.getAttribute("title")).toBe(LONG)
    const tabs = within(screen.getByRole("list", { name: "Tabs" }))
    expect(tabs.getAllByRole("listitem")).toHaveLength(4)
    await user.click(tabs.getByRole("button", { name: "and 2 more" }))
    expect(tabs.getAllByRole("listitem")).toHaveLength(5)
  })

  it("says what is missing rather than showing a blank", () => {
    render(<ContextPackInspector pack={pack({ selection: { workspaceId: "w1", tabIds: ["t1", "gone"], collectionIds: [] } }, 2)} agentName="Codex" />)
    expect(screen.getAllByText("None").length).toBeGreaterThan(0)
    expect(screen.getByText("1 selected item is no longer in Research.")).toBeTruthy()
  })

  it("says an empty workspace is empty", () => {
    render(<ContextPackInspector pack={pack({}, 0)} agentName="Codex" />)
    expect(screen.getByText("This workspace has no tabs yet, so there is nothing to read.")).toBeTruthy()
  })

  it("has a quiet loading state and an unavailable state, never an empty box", () => {
    const { rerender } = render(<ContextPackInspector pack={null} loading agentName="Codex" />)
    expect(screen.getByRole("status").textContent).toBe("Preparing context…")
    rerender(<ContextPackInspector pack={null} agentName="Codex" unavailable="This session was started without a workspace." />)
    expect(screen.getByText("This session was started without a workspace.")).toBeTruthy()
  })

  it("offers to send the current pack only when the agent has an older one", async () => {
    const user = userEvent.setup()
    const onSendUpdate = vi.fn()
    const { rerender } = render(<ContextPackInspector pack={pack()} agentName="Codex" state="changed" onSendUpdate={onSendUpdate} />)
    expect(screen.getByText("Changed since Codex received it")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Send update" }))
    expect(onSendUpdate).toHaveBeenCalledTimes(1)
    rerender(<ContextPackInspector pack={pack()} agentName="Codex" state="pending" onSendUpdate={onSendUpdate} />)
    expect(screen.queryByRole("button", { name: "Send update" })).toBeNull()
    expect(screen.getByText("Sent with your next message")).toBeTruthy()
  })

  it("leaves out rows its host shows elsewhere", () => {
    render(<ContextPackInspector pack={pack({ instruction: "Hidden here" })} agentName="Codex" hide={["instruction", "workspace", "focus"]} />)
    expect(screen.queryByText("“Hidden here”")).toBeNull()
    expect(screen.queryByText("Climate policy sources.")).toBeNull()
  })
})

describe("a past session's context", () => {
  it("is said as it was when the session ran", () => {
    render(
      <HistorySessionView
        session={{ sessionId: "s1", workspaceId: "w1", provider: "gemini", status: "completed", startedAt: T0, lastActivityAt: T0 }}
        state={{
          kind: "ready",
          detail: {
            session: { sessionId: "s1", workspaceId: "w1", provider: "gemini", status: "completed", startedAt: T0, lastActivityAt: T0 },
            records: { events: [], approvals: [], changes: [], undos: [], planOutcomes: [] },
          },
        } as never}
        now={T0}
        onClose={vi.fn()}
        context={{ lines: ["Research workspace · Workspace brief", "Pricing Research collection · 5 tabs"] }}
      />
    )
    const used = within(screen.getByRole("region", { name: "Context used" }))
    expect(used.getByText("Pricing Research collection · 5 tabs")).toBeTruthy()
    expect(used.getByText(/As it was when the session ran/)).toBeTruthy()
  })
})
