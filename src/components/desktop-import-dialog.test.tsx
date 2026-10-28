import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DesktopImportDialog } from "./desktop-import-dialog"
import type { DesktopConversationRequest, DesktopTabsRequest } from "@/lib/desktop/import-protocol"

const PROJECTS = [
  { id: "ia", name: "History IA" },
  { id: "bio", name: "Biology" },
]
const TABS: DesktopTabsRequest = {
  kind: "tabs",
  requestId: "r1",
  tabs: [{ url: "https://a.example/", title: "A" }, { url: "https://b.example/" }],
  received: 2,
  rejected: 0,
  expiresAt: Date.now() + 60_000,
}

afterEach(cleanup)

describe("DesktopImportDialog", () => {
  it("adds tabs to the open project by default", async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn(() => true)
    render(<DesktopImportDialog request={TABS} projects={PROJECTS} currentProjectId="bio" onAdd={onAdd} onCancel={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "Add to Biology" }))
    expect(onAdd).toHaveBeenCalledWith(TABS, { workspaceId: "bio" })
  })

  it("can keep the tabs as a named session instead of adding them to a project", async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn(() => true)
    render(<DesktopImportDialog request={TABS} projects={PROJECTS} currentProjectId="ia" onAdd={onAdd} onCancel={vi.fn()} />)
    await user.click(screen.getByRole("radio", { name: /Save as a session/ }))
    const name = screen.getByRole("textbox", { name: "Session name" }) as HTMLInputElement
    expect(name.value).toMatch(/^Session — /)
    await user.clear(name)
    await user.type(name, "Thursday reading")
    await user.click(screen.getByRole("button", { name: "Save session" }))
    expect(onAdd).toHaveBeenCalledWith(TABS, { session: "Thursday reading" })
  })

  it("needs a session name", async () => {
    const user = userEvent.setup()
    render(<DesktopImportDialog request={TABS} projects={PROJECTS} currentProjectId="ia" onAdd={vi.fn()} onCancel={vi.fn()} />)
    await user.click(screen.getByRole("radio", { name: /Save as a session/ }))
    await user.clear(screen.getByRole("textbox", { name: "Session name" }))
    expect((screen.getByRole("button", { name: "Save session" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("never offers a session for a conversation", () => {
    const conversation = {
      kind: "conversation",
      requestId: "c1",
      conversation: { provider: "chatgpt", title: "Photosynthesis", turns: [{ role: "user", text: "hi" }] },
      truncated: false,
      expiresAt: Date.now() + 60_000,
    } as unknown as DesktopConversationRequest
    render(<DesktopImportDialog request={conversation} projects={PROJECTS} currentProjectId="ia" onAdd={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole("radio", { name: /Save as a session/ })).toBeNull()
  })
})
