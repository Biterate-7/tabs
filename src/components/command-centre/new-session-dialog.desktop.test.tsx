import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NewSessionDialog } from "./new-session-dialog"
import { scriptedStatus } from "@/lib/agents/command-centre/__fixtures__/runtime-client"

/**
 * The start dialog in the desktop app (Phase J.1).
 *
 * A project folder can only come from the native picker there — the Rust
 * shell refuses any other — so the dialog must not let a path be typed, and a
 * new folder must grant no more than the agent was approved for.
 */
function renderDialog(overrides: Partial<Parameters<typeof NewSessionDialog>[0]> = {}) {
  const onAddProject = vi.fn(() => ({ ok: false as const, message: "stop here" }))
  const status = scriptedStatus()
  render(
    <NewSessionDialog
      open
      onOpenChange={vi.fn()}
      status={status}
      providers={status.providers}
      projects={[]}
      onAddProject={onAddProject}
      onCreate={vi.fn()}
      creating={false}
      now={0}
      {...overrides}
    />
  )
  return { onAddProject }
}

describe("authorizing a folder on the desktop", () => {
  it("fills the path from the native picker and never lets it be typed", async () => {
    const user = userEvent.setup()
    const pickFolder = vi.fn(async () => ({ path: "C:/work/research", name: "research" }))
    renderDialog({ pickFolder })

    await user.click(screen.getByRole("button", { name: /authorize a folder/i }))
    const path = screen.getByLabelText("Folder") as HTMLInputElement
    expect(path.readOnly).toBe(true)

    await user.click(screen.getByRole("button", { name: /choose folder/i }))
    expect(pickFolder).toHaveBeenCalledTimes(1)
    expect(path.value).toBe("C:/work/research")
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("research")
  })

  it("grants a new folder only what the agent was approved for", async () => {
    const user = userEvent.setup()
    const { onAddProject } = renderDialog({
      pickFolder: async () => ({ path: "C:/work/research", name: "research" }),
      projectScopesFor: () => ["read_workspace", "read_project"],
    })

    await user.click(screen.getByRole("button", { name: /authorize a folder/i }))
    await user.click(screen.getByRole("button", { name: /choose folder/i }))
    const panel = screen.getByLabelText("Folder").closest("div.rounded-md") as HTMLElement
    await user.click(within(panel).getByRole("button", { name: /^authorize$/i }))

    expect(onAddProject).toHaveBeenCalledWith(
      expect.objectContaining({ path: "C:/work/research", scopes: ["read_workspace", "read_project"] })
    )
  })

  it("keeps the typed path on the web, where there is no picker", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole("button", { name: /authorize a folder/i }))
    expect((screen.getByLabelText("Folder") as HTMLInputElement).readOnly).toBe(false)
    expect(screen.queryByRole("button", { name: /choose folder/i })).toBeNull()
  })
})
