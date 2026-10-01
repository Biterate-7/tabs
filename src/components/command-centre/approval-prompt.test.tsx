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

describe("a Codex command approval", () => {
  const COMMAND_LINE =
    "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'Get-Content C:\\work\\research\\notes.txt | Select-Object -First 5'"
  const codexCommand: RuntimeApprovalView = {
    approvalId: "c1",
    sessionId: "s1",
    provider: "openai-codex",
    action: "run_command",
    scope: "run_commands",
    projectId: "p1",
    targets: ["Command"],
    command: { commandLine: COMMAND_LINE, workingDirectory: ".", insideProject: true },
    requestedAt: NOW,
    expiresAt: NOW + 60_000,
  }

  it("shows the complete command — program, arguments and paths — and where it runs", () => {
    renderPrompt({ approval: codexCommand, projectName: "Research" })
    expect(screen.getByLabelText("Command").textContent).toBe(COMMAND_LINE)
    expect(screen.getByText("Codex wants to run:")).toBeTruthy()
    expect(screen.getByText(".")).toBeTruthy()
    // Not a name standing in for the command.
    expect(screen.queryByText(/^(cmd|exec|command)$/i)).toBeNull()
  })

  it("says, on the card, that approval is the boundary", () => {
    renderPrompt({ approval: codexCommand })
    expect(
      screen.getByText("Codex commands require your approval before execution. Approved commands run with your system permissions.")
    ).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/isolated|sandboxed to/i)
  })

  it("flags a command that runs outside the project, with its full path", () => {
    renderPrompt({ approval: { ...codexCommand, command: { commandLine: "dir", workingDirectory: "C:\\Users\\me", insideProject: false } } })
    expect(screen.getByText("C:\\Users\\me")).toBeTruthy()
    expect(screen.getByText(/outside this project/)).toBeTruthy()
  })

  it("shows a network destination Codex asked for", () => {
    renderPrompt({
      approval: { ...codexCommand, command: { ...codexCommand.command!, network: { host: "example.com", protocol: "https" } } },
    })
    expect(screen.getByText(/network access to example\.com \(https\)/)).toBeTruthy()
  })

  it("makes hidden characters visible rather than displaying a different command than the one that runs", () => {
    renderPrompt({ approval: { ...codexCommand, command: { ...codexCommand.command!, commandLine: "echo ok\u202e txt.exe" } } })
    expect(screen.getByLabelText("Command").textContent).toBe("echo ok\\u{202e} txt.exe")
  })

  it("does not offer Allow for a command it cannot show whole", () => {
    const onRespond = vi.fn()
    for (const command of [undefined, { commandLine: "x".repeat(9_000), workingDirectory: ".", insideProject: true }]) {
      const { unmount } = renderPrompt({ approval: { ...codexCommand, ...(command ? { command } : { command: undefined }) }, onRespond })
      expect(screen.getByText(/can't show this command in full/)).toBeTruthy()
      expect(screen.getByRole("button", { name: "Allow" }).hasAttribute("disabled")).toBe(true)
      expect(screen.getByRole("button", { name: "Deny" }).hasAttribute("disabled")).toBe(false)
      unmount()
    }
    expect(onRespond).not.toHaveBeenCalled()
  })
})
