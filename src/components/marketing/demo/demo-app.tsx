"use client"

import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import dynamic from "next/dynamic"
import { ChevronLeft, ScanSearch, ScrollText, Waypoints, type LucideIcon } from "lucide-react"
import { CommandPalette } from "@/components/command-palette/command-palette"
import { buildGlobalCommands } from "@/components/command-palette/global-commands"
import type { SettingsSection } from "@/components/settings/appearance-settings-view"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import { EmptyState } from "@/components/ui/empty-state"
import { IconButton } from "@/components/ui/icon-button"
import { usePortalContainer } from "@/components/ui/portal-container"
import { FavoritesView } from "@/components/workspace/favorites-view"
import { NewWorkspaceDialog } from "@/components/workspace/new-workspace-dialog"
import { RecentsView } from "@/components/workspace/recents-view"
import { applyCategoryChange } from "@/lib/sections/migrate"
import { parseWorkspaceExport } from "@/lib/workspace/json-import"
import { countRelationshipsByWorkspace } from "@/lib/workspace/relationships"
import type { Tab } from "@/lib/tabs/types"
import { DemoCommandCentre } from "./demo-command-centre"
import { useHubbleDemo } from "./demo-provider"
import { DemoSettings } from "./demo-settings"
import { currentWorkspace, type DemoSettingsSection } from "./demo-state"
import { DemoWorkspace } from "./demo-workspace"

/**
 * The graph and its physics engine load only when a visitor opens it.
 */
export const DemoGraph = dynamic(() => import("./demo-graph"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-w-0 flex-1 items-center justify-center bg-background">
      <p className="flex items-center gap-2 text-body-sm text-tertiary">
        <Waypoints className="size-4" aria-hidden />
        Laying out the graph…
      </p>
    </div>
  ),
})

/** Settings deep links from the palette, mapped onto the sections the demo has. */
function demoSection(section: SettingsSection | undefined): DemoSettingsSection {
  switch (section) {
    case "connectors":
    case "providers":
    case "mcp":
      return "agents"
    case "workspaces":
      return "workspaces"
    case "shortcuts":
      return "shortcuts"
    default:
      return "appearance"
  }
}

/**
 * The whole app, as AppShell composes it: the persistent rail and one
 * destination beside it — Workspace, Graph, Favorites, Recent, the Command
 * Centre, Settings — with the shell's command palette over everything.
 *
 * The rail is the real AppSidebar (in its `embedded` form, which positions it
 * in this window and omits the account row); the palette is the real
 * CommandPalette fed the shell's own `buildGlobalCommands`. What each
 * destination is made of is described in its own module.
 */
export function DemoApp({
  showSessions = true,
  compactRailBelow,
}: {
  /** Passed to the Command Centre: false crops it to the open session and its context. */
  showSessions?: boolean
  /** Collapses the rail to icons after mount when the viewport is narrower than this (px). */
  compactRailBelow?: number
} = {}) {
  const { state, dispatch, openUrl, scheme } = useHubbleDemo()
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false)
  const portal = usePortalContainer()
  const workspace = currentWorkspace(state)
  const relationshipCounts = useMemo(
    () => countRelationshipsByWorkspace(state.store.workspaces, state.dependencies),
    [state.store.workspaces, state.dependencies]
  )

  // After mount, not in the initial state: the server cannot know the width,
  // and the first render has to match what it sent.
  useEffect(() => {
    if (compactRailBelow && window.innerWidth < compactRailBelow) dispatch({ type: "set-sidebar-collapsed", collapsed: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const go = (view: typeof state.view) => dispatch({ type: "navigate", view })
  const toWorkspace = () => go("workspace")

  const tabHandlers = {
    onCategoryChange: (id: string, category: Parameters<typeof applyCategoryChange>[1]) =>
      setTab(id, (t) => applyCategoryChange(t, category)),
    onToggleFavorite: (id: string) => setTab(id, (t) => ({ ...t, isFavorite: !t.isFavorite })),
    onNotesChange: (id: string, notes: string) => setTab(id, (t) => ({ ...t, notes: notes.trim() || undefined })),
    onOpenTab: (id: string) => {
      const tab = workspace.tabs.find((t) => t.id === id)
      if (!tab) return
      openUrl(tab.url)
      setTab(id, (t) => ({ ...t, lastAccessedAt: Date.now() }))
    },
  }
  function setTab(id: string, change: (tab: Tab) => Tab) {
    dispatch({ type: "set-tabs", workspaceId: workspace.id, tabs: workspace.tabs.map((t) => (t.id === id ? change(t) : t)) })
  }

  const destination = (() => {
    switch (state.view) {
      case "graph":
        return <DemoGraph key={scheme?.value ?? "system"} onClose={toWorkspace} />
      case "command-centre":
        return <DemoCommandCentre onClose={toWorkspace} showSessions={showSessions} />
      case "settings":
        return <DemoSettings onClose={toWorkspace} />
      case "favorites":
        return <FavoritesView tabs={workspace.tabs} onClose={toWorkspace} {...tabHandlers} />
      case "recents":
        return <RecentsView tabs={workspace.tabs} onClose={toWorkspace} {...tabHandlers} />
      case "history-dump":
        return (
          <NotInDemo
            title="History Dump"
            icon={ScanSearch}
            onClose={toWorkspace}
            description="History Dump reads your recent browser history through Hubble for Chrome and suggests which pages to keep. This demo has no browser to read."
          />
        )
      case "agent-history":
        return (
          <NotInDemo
            title="Agent History"
            icon={ScrollText}
            onClose={toWorkspace}
            description="Agent History keeps the agent runs Hubble has seen on your device, so you can find what an agent did long after it finished. This demo has no history of its own."
          />
        )
      default:
        return <DemoWorkspace key={workspace.id} />
    }
  })()

  const commands = state.paletteOpen
    ? buildGlobalCommands(
        {
          goWorkspace: toWorkspace,
          openGraph: () => go("graph"),
          openFavorites: () => go("favorites"),
          openRecents: () => go("recents"),
          openHistoryDump: () => go("history-dump"),
          openCommandCentre: () => go("command-centre"),
          openAgentHistory: () => go("agent-history"),
          openSettings: (section) => dispatch({ type: "settings-section", section: demoSection(section) }),
          switchWorkspace: (id) => dispatch({ type: "switch-workspace", id }),
          newWorkspace: () => setNewWorkspaceOpen(true),
          openUrl,
          ...(scheme ? { setTheme: (id: "midnight" | "hubble-light") => scheme.set(id === "midnight" ? "dark" : "light") } : {}),
        },
        {
          workspaces: state.store.workspaces,
          currentId: state.store.currentId,
          ...(scheme ? { themeId: scheme.value === "light" ? "hubble-light" : "midnight" } : {}),
        }
      )
    : []

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0">
      <AppSidebar
        embedded
        onOpenSearch={() => dispatch({ type: "palette", open: true })}
        workspaces={state.store.workspaces}
        currentId={state.store.currentId}
        relationshipCounts={relationshipCounts}
        collapsed={state.sidebarCollapsed}
        onToggleCollapsed={() => dispatch({ type: "toggle-sidebar" })}
        mobileOpen={state.mobileSidebarOpen}
        onMobileOpenChange={(open) => dispatch({ type: "mobile-sidebar", open })}
        onSwitch={(id) => {
          dispatch({ type: "switch-workspace", id })
          toWorkspace()
        }}
        onCreate={(name) => dispatch({ type: "create-workspace", name })}
        onRename={(id, name) => dispatch({ type: "rename-workspace", id, name })}
        onDelete={(id) => dispatch({ type: "delete-workspace", id })}
        onImportFile={(text) => {
          // The product's own parser, into the demo's memory only. The file
          // was picked by the visitor, is read in this tab, and is gone on reload.
          const result = parseWorkspaceExport(text)
          if (result.ok) dispatch({ type: "import-workspaces", store: result.workspaces, collections: result.collections })
        }}
        onUpdateLogo={(id, logo) => dispatch({ type: "update-logo", id, logo })}
        onOpenFavorites={() => go("favorites")}
        onOpenRecents={() => go("recents")}
        onOpenHistoryDump={() => go("history-dump")}
        onOpenGraph={() => go("graph")}
        onOpenCommandCentre={() => go("command-centre")}
        onOpenAgentHistory={() => go("agent-history")}
        onOpenSettings={() => go("settings")}
        onOpenWorkspace={toWorkspace}
        currentView={state.view}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{destination}</div>

      {portal &&
        createPortal(
          <CommandPalette
            open={state.paletteOpen}
            onOpenChange={(open) => dispatch({ type: "palette", open })}
            commands={commands}
            placeholder="Search tabs, workspaces, agents and commands…"
          />,
          portal
        )}
      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onOpenChange={setNewWorkspaceOpen}
        onCreate={(name) => {
          dispatch({ type: "create-workspace", name })
          setNewWorkspaceOpen(false)
        }}
      />
    </div>
  )
}

/** A destination the demo cannot show honestly, said in the app's own empty-state language. */
function NotInDemo({
  title,
  icon,
  description,
  onClose,
}: {
  title: string
  icon: LucideIcon
  description: string
  onClose: () => void
}) {
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <p className="text-h2 text-foreground">{title}</p>
      </div>
      <div className="flex flex-1 items-center justify-center px-6">
        <EmptyState icon={icon} title="Not part of the demo" description={description} />
      </div>
    </div>
  )
}
