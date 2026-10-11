import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Search, Trash2 } from "lucide-react"
import { peekFaviconSrc, resetFaviconCache } from "@/lib/favicon/client"
import { installFakeFaviconNetwork, type ServiceOutcome } from "@/lib/favicon/__fixtures__/fake-network"
import type { Workspace } from "@/lib/workspace/types"
import { CommandPalette } from "./command-palette"
import { buildGlobalCommands } from "./global-commands"
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

describe("CommandPalette site icons", () => {
  const noop = () => {}
  const actions = {
    goWorkspace: noop,
    openGraph: noop,
    openFavorites: noop,
    openRecents: noop,
    openHistoryDump: noop,
    openCommandCentre: noop,
    openAgentHistory: noop,
    openSettings: noop,
    switchWorkspace: noop,
    newWorkspace: noop,
    openUrl: noop,
    goHome: noop,
  }
  const CHROME_ICON = "https://www.savemyexams.com/static/icon.png"

  let service: Record<string, ServiceOutcome>
  let net: ReturnType<typeof installFakeFaviconNetwork>

  const flush = () =>
    act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })

  function tab(id: string, title: string, url: string, domain: string, favicon?: string) {
    return { id, title, url, normalizedUrl: url, domain, favicon }
  }

  function commandsFor(tabs: ReturnType<typeof tab>[]) {
    const workspace = { id: "w1", name: "Physics", tabs } as unknown as Workspace
    return buildGlobalCommands(actions, { workspaces: [workspace], currentId: "w1" })
  }

  function row(label: string) {
    return screen.getByText(label).closest("[cmdk-item]") as HTMLElement
  }

  beforeEach(() => {
    service = {}
    net = installFakeFaviconNetwork({ service: (host) => service[host] ?? "not-found" })
    resetFaviconCache()
  })

  afterEach(() => {
    resetFaviconCache()
    net.restore()
  })

  it("shows a tab's favicon in place of the globe", async () => {
    service["savemyexams.com"] = "icon"
    const commands = commandsFor([tab("t1", "Save My Exams", "https://www.savemyexams.com/a", "savemyexams.com")])
    render(<CommandPalette open onOpenChange={vi.fn()} commands={commands} />)
    await flush()

    const item = row("Save My Exams")
    expect(item.querySelector("img")?.getAttribute("src")).toBe(peekFaviconSrc("savemyexams.com"))
    expect(item.querySelector("svg.lucide-globe")).toBeNull()
    // The row keeps its second line and still filters on its text.
    expect(item.textContent).toContain("savemyexams.com")
  })

  it("prefers the icon Chrome saved with the tab, without asking the resolver", async () => {
    net.restore()
    net = installFakeFaviconNetwork({ service: () => "icon", image: (src) => (src === CHROME_ICON ? "load" : "error") })
    const commands = commandsFor([tab("t1", "Save My Exams", "https://www.savemyexams.com/a", "savemyexams.com", CHROME_ICON)])
    render(<CommandPalette open onOpenChange={vi.fn()} commands={commands} />)
    await flush()

    expect(row("Save My Exams").querySelector("img")?.getAttribute("src")).toBe(CHROME_ICON)
    expect(net.fetched).toEqual([])
  })

  it("keeps the globe, and no <img>, when the site has no icon", async () => {
    const commands = commandsFor([tab("t1", "TutorChase", "https://tutorchase.com/a", "tutorchase.com")])
    render(<CommandPalette open onOpenChange={vi.fn()} commands={commands} />)
    await flush()

    const item = row("TutorChase")
    expect(item.querySelector("img")).toBeNull()
    expect(item.querySelector("svg.lucide-globe")).not.toBeNull()
  })

  it("falls back to the globe when a resolved icon then fails to render", async () => {
    service["revisionvillage.com"] = "icon"
    const commands = commandsFor([tab("t1", "Revision Village", "https://revisionvillage.com/a", "revisionvillage.com")])
    const first = render(<CommandPalette open onOpenChange={vi.fn()} commands={commands} />)
    await flush()
    const src = peekFaviconSrc("revisionvillage.com")!
    expect(row("Revision Village").querySelector("img")).not.toBeNull()
    first.unmount()

    net.breakBlob(src)
    render(<CommandPalette open onOpenChange={vi.fn()} commands={commands} />)
    await flush()

    const item = row("Revision Village")
    expect(item.querySelector("img")).toBeNull()
    expect(item.querySelector("svg.lucide-globe")).not.toBeNull()
  })

  it("falls back to the globe when Chrome's icon and the resolver both fail", async () => {
    net.restore()
    net = installFakeFaviconNetwork({ service: () => "not-found", image: () => "error" })
    const commands = commandsFor([tab("t1", "Save My Exams", "https://www.savemyexams.com/a", "savemyexams.com", CHROME_ICON)])
    render(<CommandPalette open onOpenChange={vi.fn()} commands={commands} />)
    await flush()
    await flush()

    const item = row("Save My Exams")
    expect(item.querySelector("img")).toBeNull()
    expect(item.querySelector("svg.lucide-globe")).not.toBeNull()
  })

  it("leaves navigation, AI, subject and settings results on their own icons", async () => {
    service["savemyexams.com"] = "icon"
    const commands = commandsFor([tab("t1", "Save My Exams", "https://www.savemyexams.com/a", "savemyexams.com")])
    render(<CommandPalette open onOpenChange={vi.fn()} commands={commands} />)
    await flush()

    for (const [label, glyph] of [
      ["Go to Home", "lucide-house"],
      ["Open graph view", "lucide-waypoints"],
      ["Open AI chats", "lucide-radio"],
      ["Physics", "lucide-boxes"],
      ["New subject", "lucide-folder-plus"],
      ["Open settings", "lucide-settings"],
    ] as const) {
      const item = row(label)
      expect(item.querySelector(`svg.${glyph}`), label).not.toBeNull()
      expect(item.querySelector("img"), label).toBeNull()
    }
    // Only the saved tab was looked up.
    expect(net.fetched).toEqual(["/api/favicon?host=savemyexams.com"])
  })

  it("renders tabs with missing or malformed addresses without crashing or requesting anything", async () => {
    const commands = commandsFor([
      tab("t1", "No host", "not a url", ""),
      tab("t2", "Bad host", "http://exa mple/", "exa mple"),
      tab("t3", "Local host", "http://localhost:3000/", "localhost"),
      tab("t4", "Address", "http://192.168.0.1/", "192.168.0.1"),
      tab("t5", "Script icon", "https://savemyexams.com/", "", "javascript:alert(1)"),
      { id: "t6", title: "Untyped", url: "x", normalizedUrl: "x" } as never,
    ])
    render(<CommandPalette open onOpenChange={vi.fn()} commands={commands} />)
    await flush()

    for (const label of ["No host", "Bad host", "Local host", "Address", "Script icon", "Untyped"]) {
      const item = row(label)
      expect(item.querySelector("img"), label).toBeNull()
      expect(item.querySelector("svg.lucide-globe"), label).not.toBeNull()
    }
    expect(net.fetched).toEqual([])
    expect(net.images).toEqual([])
  })
})

describe("paletteFilter", () => {
  it("does not match scattered letters, so a tab search is not buried under commands", async () => {
    const { paletteFilter } = await import("./command-palette")
    // The regression: fuzzy matching let "arxiv" hit this command's keywords.
    expect(paletteFilter("Connect an agent Agents agents-connect", "arxiv", ["provider", "mcp", "codex", "gemini", "grok"])).toBe(0)
    expect(paletteFilter("https://arxiv.org/abs/2310.06770 Tabs tab-1", "arxiv", ["arxiv.org"])).toBeGreaterThan(0)
  })

  it("still finds AI chats by its power-user name, Command Centre", async () => {
    const { paletteFilter } = await import("./command-palette")
    const { buildGlobalCommands } = await import("./global-commands")
    const noop = () => {}
    const commands = buildGlobalCommands(
      {
        goWorkspace: noop,
        openGraph: noop,
        openFavorites: noop,
        openRecents: noop,
        openHistoryDump: noop,
        openCommandCentre: noop,
        openAgentHistory: noop,
        openSettings: noop,
        switchWorkspace: noop,
        newWorkspace: noop,
        openUrl: noop,
      },
      { workspaces: [], currentId: "" }
    )
    const entry = commands.find((command) => command.id === "agents-command-centre")!
    expect(entry.label).toBe("Open AI chats")
    expect(paletteFilter(`${entry.label} ${entry.group} ${entry.id}`, "command centre", entry.keywords ?? [])).toBeGreaterThan(0)
  })

  it("ranks a label prefix above a keyword hit", async () => {
    const { paletteFilter } = await import("./command-palette")
    expect(paletteFilter("New workspace Workspaces", "new work", [])).toBe(1)
    expect(paletteFilter("Open settings Settings", "preferences", ["preferences"])).toBeLessThan(1)
  })
})
