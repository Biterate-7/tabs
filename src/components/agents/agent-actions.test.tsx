import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { AgentActionsProvider, type AgentActions } from "./agent-actions"
import { TabActionsMenu } from "@/components/workspace/tab-actions-menu"
import { SelectionToolbar } from "@/components/workspace/selection-toolbar"
import { CollectionHeader } from "@/components/workspace/collection-header"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import { GraphContextMenu } from "@/components/graph/graph-context-menu"
import { GraphCollectionPanel } from "@/components/graph/graph-collection-panel"
import { CommandPaletteHostContext, type CommandPaletteHost } from "@/components/command-palette/palette-host"
import { buildGlobalCommands } from "@/components/command-palette/global-commands"
import { collectionContext, tabsContext } from "@/lib/agents/command-centre/working-context"
import type { Command } from "@/components/command-palette/types"
import type { AgentIntent, WorkingContext } from "@/lib/agents/command-centre/working-context"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Workspace → agent: every place Hubble offers "Ask agent" hands the shell a
 * working context — ids inside the workspace on screen — and nothing else.
 * Outside the shell (no provider) none of them offers it at all.
 */

function actions() {
  return {
    workspaceId: "w1",
    ask: vi.fn<(context: WorkingContext, intent?: AgentIntent) => void>(),
    add: vi.fn<(context: WorkingContext) => void>(),
  } satisfies AgentActions
}

function inShell(agent: AgentActions, children: ReactNode) {
  return <AgentActionsProvider value={agent}>{children}</AgentActionsProvider>
}

const TAB: Tab = { id: "t1", url: "https://arxiv.org/abs/1", normalizedUrl: "https://arxiv.org/abs/1", domain: "arxiv.org", title: "Relativity" }

describe("a tab's menu", () => {
  it("asks about this tab, explains it, summarizes it, or adds it to context", async () => {
    const user = userEvent.setup()
    const agent = actions()
    render(inShell(agent, <TabActionsMenu tab={TAB} onCategoryChange={vi.fn()} trigger={<button type="button">More</button>} />))

    await user.click(screen.getByRole("button", { name: "More" }))
    await user.hover(await screen.findByRole("menuitem", { name: /Ask agent/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Summarize" }))
    expect(agent.ask).toHaveBeenCalledWith(tabsContext("w1", ["t1"]), "summarize")

    await user.click(screen.getByRole("button", { name: "More" }))
    await user.hover(await screen.findByRole("menuitem", { name: /Ask agent/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add to agent context" }))
    expect(agent.add).toHaveBeenCalledWith(tabsContext("w1", ["t1"]))
  })

  it("offers nothing outside the shell", async () => {
    const user = userEvent.setup()
    render(<TabActionsMenu tab={TAB} onCategoryChange={vi.fn()} trigger={<button type="button">More</button>} />)
    await user.click(screen.getByRole("button", { name: "More" }))
    await screen.findByRole("menuitem", { name: "Open" })
    expect(screen.queryByRole("menuitem", { name: /Ask agent/ })).toBeNull()
  })
})

describe("a selection", () => {
  it("is sent with the request chosen, or added to context", async () => {
    const user = userEvent.setup()
    const onAsk = vi.fn()
    const onAdd = vi.fn()
    render(
      <SelectionToolbar
        count={3}
        onRecategorize={vi.fn()}
        onExportSelected={vi.fn()}
        onOpenSelected={vi.fn()}
        onRemoveSelected={vi.fn()}
        onClear={vi.fn()}
        agentActions={{ onAsk, onAdd }}
      />
    )
    await user.click(screen.getByRole("button", { name: "Ask agent" }))
    await user.click(await screen.findByRole("menuitem", { name: "Compare" }))
    expect(onAsk).toHaveBeenCalledWith("compare")

    await user.click(screen.getByRole("button", { name: "Ask agent" }))
    await user.click(await screen.findByRole("menuitem", { name: "Add to agent context" }))
    expect(onAdd).toHaveBeenCalled()
  })
})

describe("a collection", () => {
  it("is asked about from its menu, as the collection", async () => {
    const user = userEvent.setup()
    const agent = actions()
    render(
      inShell(
        agent,
        <CollectionHeader
          name="Physics"
          tabCount={4}
          expanded
          onToggleExpanded={vi.fn()}
          contentId="c"
          onRename={vi.fn()}
          onAddTabs={vi.fn()}
          onOpenAll={vi.fn()}
          onDelete={vi.fn()}
          agentContext={collectionContext("w1", "c-physics")}
        />
      )
    )
    await user.click(screen.getByRole("button", { name: "More actions for Physics" }))
    await user.hover(await screen.findByRole("menuitem", { name: /Ask agent/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Organize" }))
    expect(agent.ask).toHaveBeenCalledWith(collectionContext("w1", "c-physics"), "organize")
  })

  it("is asked about from the graph's collection panel", async () => {
    const user = userEvent.setup()
    const agent = actions()
    render(
      inShell(
        agent,
        <GraphCollectionPanel
          collection={{ id: "c-physics", workspaceId: "w1", name: "Physics", tabIds: [], createdAt: 0, updatedAt: 0 }}
          nodeById={new Map()}
          onSelectTab={vi.fn()}
          onOpenTab={vi.fn()}
          onFocus={vi.fn()}
          onRename={vi.fn()}
          onOpenAll={vi.fn()}
          onDelete={vi.fn()}
        />
      )
    )
    await user.click(screen.getByRole("button", { name: "Ask agent about this collection" }))
    expect(agent.ask).toHaveBeenCalledWith(collectionContext("w1", "c-physics"), "analyze")
  })
})

describe("a graph node", () => {
  it("offers Ask agent only when the shell can take it there", async () => {
    const user = userEvent.setup()
    const onAskAgent = vi.fn()
    const base = {
      state: {
        node: { id: "a", tab: { id: "a", url: "https://arxiv.org", normalizedUrl: "https://arxiv.org", domain: "arxiv.org" }, workspaceId: "w1", workspaceName: "Research" },
        x: 10,
        y: 10,
      },
      otherWorkspaces: [],
      dependencyCount: 0,
      collections: [],
      hasNotes: false,
      isFavorite: false,
      onOpenTab: vi.fn(),
      onOpenNewTab: vi.fn(),
      onCopyUrl: vi.fn(),
      onCopyCleanUrl: vi.fn(),
      onMoveToWorkspace: vi.fn(),
      onLinkTo: vi.fn(),
      onAddDependency: vi.fn(),
      onViewDependencies: vi.fn(),
      onAddToCollection: vi.fn(),
      onGatherNewCollection: vi.fn(),
      onOpenNotes: vi.fn(),
      onToggleFavorite: vi.fn(),
      onRemove: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(<GraphContextMenu {...base} />)
    expect(screen.queryByRole("menuitem", { name: /Ask agent/ })).toBeNull()

    rerender(<GraphContextMenu {...base} onAskAgent={onAskAgent} onAddToAgentContext={vi.fn()} />)
    await user.click(screen.getByRole("menuitem", { name: /Ask agent about this/ }))
    expect(onAskAgent).toHaveBeenCalled()
    expect(screen.getByRole("menuitem", { name: /Add to agent context/ })).toBeTruthy()
  })
})

/* ------------------------------------------------------------------ *
 * Search → select → Ask agent, and the palette, in the real workspace view
 * ------------------------------------------------------------------ */

describe("from search results in the workspace", () => {
  const tabs: Tab[] = [
    { id: "g1", url: "https://github.com/a", normalizedUrl: "https://github.com/a", domain: "github.com", category: "projects" },
    { id: "g2", url: "https://github.com/b", normalizedUrl: "https://github.com/b", domain: "github.com", category: "projects" },
    { id: "x1", url: "https://arxiv.org/abs/1", normalizedUrl: "https://arxiv.org/abs/1", domain: "arxiv.org", category: "research" },
  ]
  const workspace: Workspace = { id: "w1", name: "Research", tabs, createdAt: 0, updatedAt: 0 }

  let open: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    window.localStorage.clear()
    open = vi.spyOn(window, "open").mockImplementation(() => null)
  })
  afterEach(() => open.mockRestore())

  it("sends exactly the selected results, from this workspace, to an agent", async () => {
    const user = userEvent.setup()
    const agent = actions()
    const contributed = new Map<string, Command[]>()
    const host: CommandPaletteHost = {
      open: vi.fn(),
      contribute: (source, commands) => {
        if (commands) contributed.set(source, commands)
        else contributed.delete(source)
      },
    }
    render(
      <CommandPaletteHostContext.Provider value={host}>
        {inShell(agent, <WorkspaceView tabs={tabs} onTabsChange={vi.fn()} onClear={vi.fn()} currentWorkspace={workspace} allWorkspaces={[workspace]} />)}
      </CommandPaletteHostContext.Provider>
    )

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github")
    await user.click(screen.getByRole("button", { name: "Select" }))
    for (const checkbox of screen.getAllByLabelText("Select github.com")) await user.click(checkbox)
    expect(screen.getByText("2 selected")).toBeTruthy()

    // The palette offers the same request while there is a selection.
    const commands = contributed.get("workspace")!
    const askSelection = commands.find((command) => command.id === "agent-ask-selection")!
    expect(askSelection.label).toBe("Ask agent about 2 selected tabs")
    expect(askSelection.disabled).toBe(false)

    const toolbar = screen.getByText("2 selected").parentElement!
    await user.click(within(toolbar).getByRole("button", { name: "Ask agent" }))
    await user.click(await screen.findByRole("menuitem", { name: "Summarize" }))
    expect(agent.ask).toHaveBeenCalledWith(tabsContext("w1", ["g1", "g2"]), "summarize")
    expect(agent.ask.mock.calls[0]![0].tabIds).not.toContain("x1")
  })
})

describe("the palette, everywhere", () => {
  it("asks an agent about the current workspace", () => {
    const askAgentAboutWorkspace = vi.fn()
    const commands = buildGlobalCommands(
      {
        goWorkspace: vi.fn(),
        openGraph: vi.fn(),
        openFavorites: vi.fn(),
        openRecents: vi.fn(),
        openHistoryDump: vi.fn(),
        openCommandCentre: vi.fn(),
        openAgentHistory: vi.fn(),
        openSettings: vi.fn(),
        switchWorkspace: vi.fn(),
        newWorkspace: vi.fn(),
        openUrl: vi.fn(),
        askAgentAboutWorkspace,
      },
      { workspaces: [{ id: "w1", name: "Research", tabs: [], createdAt: 0, updatedAt: 0 }], currentId: "w1" }
    )
    const ask = commands.find((command) => command.id === "agents-ask-workspace")!
    expect(ask.label).toBe("Ask agent about Research")
    ask.onSelect()
    expect(askAgentAboutWorkspace).toHaveBeenCalled()
  })
})
