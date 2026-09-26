import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Search, Trash2 } from "lucide-react"
import { CommandPalette } from "./command-palette"
import type { Command } from "./types"

function makeCommands(onSelectSearch: () => void, onSelectClear: () => void): Command[] {
  return [
    { id: "search", label: "Search tabs", group: "Navigation", icon: Search, onSelect: onSelectSearch },
    { id: "clear", label: "Clear workspace", group: "Actions", icon: Trash2, onSelect: onSelectClear },
  ]
}

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    render(
      <CommandPalette open={false} onOpenChange={vi.fn()} commands={makeCommands(vi.fn(), vi.fn())} />
    )
    expect(screen.queryByPlaceholderText(/type a command/i)).toBeFalsy()
  })

  it("filters commands by typed query and runs the selected command on click", async () => {
    const user = userEvent.setup()
    const onSelectClear = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={makeCommands(vi.fn(), onSelectClear)}
      />
    )

    const input = screen.getByPlaceholderText(/type a command/i)
    await user.type(input, "clear")

    expect(screen.queryByText("Search tabs")).toBeFalsy()
    const item = screen.getByText("Clear workspace")
    await user.click(item)

    expect(onSelectClear).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("runs the selected command on Enter after filtering to a single match", async () => {
    const user = userEvent.setup()
    const onSelectClear = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={makeCommands(vi.fn(), onSelectClear)}
      />
    )

    const input = screen.getByPlaceholderText(/type a command/i)
    await user.type(input, "clear")
    await user.keyboard("{Enter}")

    expect(onSelectClear).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("groups commands under their group heading", () => {
    render(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        commands={makeCommands(vi.fn(), vi.fn())}
      />
    )
    expect(screen.getByText("Navigation")).toBeTruthy()
    expect(screen.getByText("Actions")).toBeTruthy()
  })
})

describe("paletteFilter", () => {
  it("does not match scattered letters, so a tab search is not buried under commands", async () => {
    const { paletteFilter } = await import("./command-palette")
    // The regression: fuzzy matching let "arxiv" hit this command's keywords.
    expect(paletteFilter("Connect an agent Agents agents-connect", "arxiv", ["provider", "mcp", "codex", "gemini", "grok"])).toBe(0)
    expect(paletteFilter("https://arxiv.org/abs/2310.06770 Tabs tab-1", "arxiv", ["arxiv.org"])).toBeGreaterThan(0)
  })

  it("ranks a label prefix above a keyword hit", async () => {
    const { paletteFilter } = await import("./command-palette")
    expect(paletteFilter("New workspace Workspaces", "new work", [])).toBe(1)
    expect(paletteFilter("Open settings Settings", "preferences", ["preferences"])).toBeLessThan(1)
  })
})
