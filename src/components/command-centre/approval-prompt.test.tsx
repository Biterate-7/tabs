import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { ApprovalPrompt } from "./approval-prompt"
import type { RuntimeApprovalView } from "@/lib/agents/runtime/protocol"

const NOW = Date.UTC(2026, 8, 25, 16, 0, 0)
const approval: RuntimeApprovalView = {
  approvalId: "a1",
  sessionId: "s1",
  provider: "claude-code",
  action: "change_workspace",
  scope: "collections.write",
  workspaceId: "w1",
  targets: [],
  change: { kind: "create_collection", subject: "Reading", tabCount: 2, details: ["One", "Two"] },
  requestedAt: NOW,
  expiresAt: NOW + 60_000,
}

function renderPrompt(props: Partial<React.ComponentProps<typeof ApprovalPrompt>> = {}) {
  return render(
    <ol>
      <ApprovalPrompt approval={approval} workspaceName="Research" pending={false} now={NOW} onRespond={vi.fn()} {...props} />
    </ol>
  )
}

describe("ApprovalPrompt focus", () => {
  it("puts focus on Deny when a decision arrives, as it always has", () => {
    renderPrompt()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Deny" }))
  })

  it("leaves focus alone when told the card was already on screen", () => {
    renderPrompt({ autoFocus: false })
    expect(document.activeElement).toBe(document.body)
    // Still fully operable.
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy()
  })
})
