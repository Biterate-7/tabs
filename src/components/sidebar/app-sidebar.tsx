"use client"

import { useState } from "react"
import type { ReactNode } from "react"
import type { NewProjectBrief } from "@/components/workspace/new-workspace-dialog"
import {
  ChevronRight,
  Clock,
  Command,
  FileInput,
  FolderPlus,
  History,
  House,
  Layers,
  Library,
  MessageSquareShare,
  NotebookPen,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Star,
  Waypoints,
} from "lucide-react"
import { AccountSection } from "@/components/auth/account-section"
import { BrandMark } from "@/components/brand-mark"
import { IconButton } from "@/components/ui/icon-button"
import { Kbd } from "@/components/ui/kbd"
import { SidebarItem, SidebarSectionLabel } from "@/components/ui/sidebar-item"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { NewWorkspaceDialog } from "@/components/workspace/new-workspace-dialog"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { subjectName } from "@/lib/product/subjects"
import { cn } from "@/lib/utils"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Which destination is on screen. Mirrors the `view` union in app-shell —
 * the rail only needs to know enough to light the right row.
 */
export type SidebarView =
  | "home"
  | "search"
  | "workspace"
  | "graph"
  | "tab-map"
  | "ai"
  | "library"
  | "settings"
  | "favorites"
  | "recents"
  | "history-dump"
  | "sessions"

/** Destinations that live under "More" — tools most people never need to find. */
const MORE_VIEWS: readonly SidebarView[] = ["favorites", "recents", "history-dump", "tab-map"]

const MORE_OPEN_KEY = "hubble:sidebar-more:v1"

function loadMoreOpen(): boolean {
  try {
    return window.localStorage.getItem(MORE_OPEN_KEY) === "1"
  } catch {
    return false
  }
}

function saveMoreOpen(open: boolean): void {
  try {
    window.localStorage.setItem(MORE_OPEN_KEY, open ? "1" : "0")
  } catch {
    // A remembered disclosure is a convenience; nothing to recover.
  }
}

/** What the rail's Create menu can start, beyond a new project. Each is present only where the shell supports it. */
export type SidebarCreateActions = {
  /** Write a note in the project on screen. */
  onWriteNote?: () => void
  /** Import AI conversations (an export file) into the project on screen. */
  onImportChats?: () => void
  /** Save the tabs open in Chrome as a session. */
  onSaveSession?: () => void
}

/**
 * The persistent left rail.
 *
 *     ◉ Hubble                    [+] [⇤]
 *     [Search            ] [⌘]
 *     Home · Graph · AI · Library · Sessions
 *     PROJECTS
 *       Thesis — Urban heat          12
 *       IB History                    9
 *       + New project
 *     More ›   Favorites, Recent, Import from history, Tab map
 *     ─────
 *     ● Chrome connected
 *     Settings
 *
 * ## Places, then projects
 *
 * The top of the rail is the handful of places Hubble has — Home (where you
 * were), the Graph (how it connects), AI (using it), the Library (every
 * conversation and file) and Sessions. Below them are the projects
 * themselves, each with how much it holds. "+" beside the brand creates
 * anything; ⌘ opens the command menu.
 *
 * ## Progressive disclosure
 *
 * Favorites, Recent, Import from history and the Tab map are kept and one
 * click away under "More", closed by default. The group opens itself
 * whenever one of its destinations is on screen, so the current row is never
 * hidden, and remembers being opened by hand.
 *
 * Rows are `SidebarItem`, so the destination on screen carries
 * `aria-current="page"`. Project rows carry `aria-current` while that
 * project is open.
 */
export function AppSidebar({
  workspaces,
  currentId,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onMobileOpenChange,
  onSwitch,
  onOpenSubject,
  onCreate,
  onOpenFavorites,
  onOpenRecents,
  onOpenHistoryDump,
  onOpenGraph,
  onOpenTabMap,
  tabMapLocked = false,
  tabMapLockedReason,
  onOpenSettings,
  onOpenWorkspace,
  onOpenHome,
  onOpenSessions,
  onOpenAi,
  onOpenLibrary,
  onOpenCommandMenu,
  createActions,
  status,
  currentView = "workspace",
  onOpenSearch,
  embedded = false,
}: {
  workspaces: Workspace[]
  currentId: string
  /** Desktop-only icon-rail toggle — has no effect below the `md` breakpoint (see mobileOpen). */
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Below `md`, the sidebar is an off-canvas drawer closed by default — opened via a button in each view's header. Has no visual effect at `md` and above. */
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
  /** Makes a workspace the current one. */
  onSwitch: (id: string) => void
  /** Opens a project's page. Absent: switching is all a row does (the landing demo). */
  onOpenSubject?: (id: string) => void
  onCreate: (name: string, brief?: NewProjectBrief) => void
  onOpenFavorites: () => void
  onOpenRecents: () => void
  onOpenHistoryDump: () => void
  onOpenGraph: () => void
  /** The map of saved tabs (the older graph). Absent: not offered. */
  onOpenTabMap?: () => void
  /** True while a dump is still being organized/laid out — see lib/organize/lifecycle.ts. Disabled rather than hidden. */
  tabMapLocked?: boolean
  /** What the tab map is waiting on, used as the disabled row's tooltip. */
  tabMapLockedReason?: string
  onOpenSettings: () => void
  /** Returns to the current workspace from any other destination. */
  onOpenWorkspace?: () => void
  /** Home. Absent: no Home row (the landing demo, which has no Home). */
  onOpenHome?: () => void
  /** Saved sessions of Chrome tabs. Absent: no Sessions row (Hubble Desktop, the landing demo). */
  onOpenSessions?: () => void
  /** Using saved context in an AI app. Absent: no AI row. */
  onOpenAi?: () => void
  /** Every conversation, file and note across projects. Absent: no Library row. */
  onOpenLibrary?: () => void
  /** The ⌘K command menu. Absent: no button for it. */
  onOpenCommandMenu?: () => void
  createActions?: SidebarCreateActions
  /** A quiet line above Settings: connection or storage problems, or that all is well. */
  status?: ReactNode
  /** The destination currently on screen, used to mark the active row. */
  currentView?: SidebarView
  /** Opens the knowledge search page — the rail's search field is its front door. */
  onOpenSearch?: () => void
  /**
   * Rendered inside another surface rather than as the window's own rail —
   * the landing page's product demo. Positioned against its container instead
   * of the viewport, and without the account row: a demo must never offer a
   * real sign-in.
   */
  embedded?: boolean
}) {
  // The desktop icon-rail collapse has no business hiding labels inside the
  // mobile drawer — that's a different affordance with its own state.
  const showLabels = !collapsed || mobileOpen
  const railCollapsed = !showLabels
  // Inside the drawer these rows are tapped, and want 44pt rather than 30px.
  const touch = mobileOpen
  const [newOpen, setNewOpen] = useState(false)
  const [moreChosen, setMoreChosen] = useState<boolean | null>(null)
  // Read lazily so SSR and the first client render agree (closed), then the remembered choice.
  // Never in the embedded demo, which can render on the server.
  const moreRemembered = moreChosen ?? (!embedded && typeof window !== "undefined" ? loadMoreOpen() : false)
  const moreOpen = moreRemembered || MORE_VIEWS.includes(currentView)

  const activeIs = (v: SidebarView) => currentView === v

  function toggleMore() {
    const next = !moreOpen
    setMoreChosen(next)
    // The landing demo promises to touch no storage: it remembers nothing.
    if (!embedded) saveMoreOpen(next)
  }

  function openSubject(id: string) {
    if (onOpenSubject) onOpenSubject(id)
    else {
      onSwitch(id)
      onOpenWorkspace?.()
    }
    if (mobileOpen) onMobileOpenChange(false)
  }

  // Taps in the drawer navigate and close it, so the destination is what is seen.
  const go = (open?: () => void) => () => {
    open?.()
    if (mobileOpen) onMobileOpenChange(false)
  }

  const hasCreateExtras = Boolean(createActions?.onWriteNote || createActions?.onImportChats || createActions?.onSaveSession)

  const createButton = hasCreateExtras ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton aria-label="Create" tooltip="Create">
            <Plus />
          </IconButton>
        }
      />
      <DropdownMenuContent align={railCollapsed ? "start" : "end"} className="min-w-52">
        <DropdownMenuItem onClick={() => setNewOpen(true)}>
          <FolderPlus /> New project
        </DropdownMenuItem>
        {createActions?.onWriteNote && (
          <DropdownMenuItem onClick={go(createActions.onWriteNote)}>
            <NotebookPen /> Write a note
          </DropdownMenuItem>
        )}
        {createActions?.onImportChats && (
          <DropdownMenuItem onClick={go(createActions.onImportChats)}>
            <FileInput /> Import AI chats
          </DropdownMenuItem>
        )}
        {createActions?.onSaveSession && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={go(createActions.onSaveSession)}>
              <Layers /> Save browser session
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  return (
    <>
      {mobileOpen && (
        <div
          aria-hidden
          onClick={() => onMobileOpenChange(false)}
          className={cn(embedded ? "absolute" : "fixed", "inset-0 z-30 bg-(--overlay) animate-fade md:hidden")}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-screen w-60 shrink-0 flex-col border-r border-subtle bg-sidebar transition-transform duration-(--duration-slow) ease-(--ease-standard)",
          mobileOpen ? "translate-x-0 shadow-(--shadow-window)" : "-translate-x-full",
          "md:sticky md:top-0 md:z-auto md:translate-x-0 md:shadow-none md:transition-[width]",
          collapsed ? "md:w-14" : "md:w-60",
          embedded && "absolute h-full md:relative md:top-auto"
        )}
        // Settings → Appearance → Layout → Sidebar density controls this var.
        style={!collapsed || mobileOpen ? { width: "var(--tabdump-sidebar-width)" } : undefined}
      >
        {/* Brand row: the mark, the name, Create and the collapse toggle. */}
        <div className={cn("flex h-12 shrink-0 items-center gap-1 px-3", showLabels ? "justify-between" : "flex-col justify-center gap-1 px-0 pt-2 h-auto")}>
          {showLabels && (
            <span className="flex min-w-0 flex-1 items-center gap-2 pl-1 text-foreground">
              <BrandMark className="size-[18px]" />
              <span className="font-display text-[15px] leading-none font-medium tracking-[-0.01em]">Hubble</span>
            </span>
          )}
          {showLabels && createButton}
          <IconButton
            aria-label={mobileOpen ? "Close sidebar" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => (mobileOpen ? onMobileOpenChange(false) : onToggleCollapsed())}
          >
            {showLabels ? <PanelLeftClose /> : <PanelLeftOpen />}
          </IconButton>
        </div>

        {onOpenSearch && (
          <div className={cn("flex shrink-0 items-center gap-1 px-2 pb-2", railCollapsed && "flex-col px-0 pt-1")}>
            {railCollapsed ? (
              <IconButton aria-label="Search" tooltip="Search" onClick={onOpenSearch}>
                <Search />
              </IconButton>
            ) : (
              <button
                type="button"
                onClick={go(onOpenSearch)}
                aria-label="Search"
                aria-current={currentView === "search" ? "page" : undefined}
                className={cn(
                  "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2 text-left text-body text-tertiary shadow-(--shadow-sm) transition-[border-color,color] duration-(--duration-fast) ease-(--ease-color) outline-none hover:border-strong hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
                  currentView === "search" && "border-strong text-muted-foreground"
                )}
              >
                <Search className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Search</span>
              </button>
            )}
            {onOpenCommandMenu && !touch && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Command menu"
                      aria-keyshortcuts="Control+K Meta+K"
                      onClick={onOpenCommandMenu}
                      className="flex h-8 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-tertiary outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      {railCollapsed ? <Command className="size-4" aria-hidden /> : <Kbd>⌘K</Kbd>}
                    </button>
                  }
                />
                <TooltipContent>Command menu · Ctrl/⌘ K</TooltipContent>
              </Tooltip>
            )}
            {railCollapsed && createButton}
          </div>
        )}

        <div className={cn("min-h-0 flex-1 overflow-y-auto px-2 pb-2", railCollapsed && "px-1.5")}>
          <nav aria-label="Main" className="flex flex-col gap-px">
            {onOpenHome && <SidebarItem label="Home" icon={<House />} current={activeIs("home")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenHome)} />}
            <SidebarItem label="Graph" icon={<Orbit />} current={activeIs("graph")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenGraph)} />
            {onOpenAi && <SidebarItem label="AI" icon={<MessageSquareShare />} current={activeIs("ai")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenAi)} />}
            {onOpenLibrary && <SidebarItem label="Library" icon={<Library />} current={activeIs("library")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenLibrary)} />}
            {onOpenSessions && <SidebarItem label="Sessions" icon={<Layers />} current={activeIs("sessions")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenSessions)} />}
          </nav>

          <div className={cn("mt-5 flex items-center pr-1", railCollapsed && "mt-3 flex justify-center border-t border-subtle pt-3 pr-0")}>
            <SidebarSectionLabel collapsed={railCollapsed} className="flex-1">
              Projects
            </SidebarSectionLabel>
          </div>
          <nav aria-label="Projects" className="mt-0.5 flex flex-col gap-px">
            {workspaces.map((w) => {
              const isOpen = w.id === currentId && currentView === "workspace"
              const isCurrent = w.id === currentId
              const name = subjectName(w)
              const count = w.tabs.filter((tab) => tab.resource).length + (w.notes?.length ?? 0)
              return (
                <Tooltip key={w.id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => openSubject(w.id)}
                        aria-label={`Open ${name}`}
                        aria-current={isOpen ? "page" : undefined}
                        data-current-subject={isCurrent || undefined}
                        className={cn(
                          "group/project relative flex w-full items-center gap-2 rounded-md border border-transparent px-2 text-left",
                          "transition-[background-color,color] duration-(--duration-fast) ease-(--ease-color)",
                          "outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                          touch ? "h-11" : "h-[30px]",
                          railCollapsed && "justify-center px-0",
                          isOpen ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                        )}
                      >
                        {/* The project on screen is marked by a short bar as well as tone. */}
                        {isOpen && !railCollapsed && <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-link" />}
                        <WorkspaceAvatar workspace={w} size={16} />
                        {showLabels && <span className="min-w-0 flex-1 truncate text-body">{name}</span>}
                        {showLabels && count > 0 && <span className="shrink-0 text-meta text-tertiary tabular-nums opacity-0 transition-opacity group-hover/project:opacity-100 group-aria-[current=page]/project:opacity-100">{count}</span>}
                      </button>
                    }
                  />
                  <TooltipContent>{name}</TooltipContent>
                </Tooltip>
              )
            })}
            {showLabels && (
              <button
                type="button"
                onClick={() => setNewOpen(true)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 text-left text-body text-tertiary outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
                  touch ? "h-11" : "h-[30px]"
                )}
              >
                <Plus className="size-4 shrink-0" aria-hidden />
                New project
              </button>
            )}
          </nav>

          {/* More: kept, never in the way. */}
          <div className={cn("mt-4", railCollapsed && "mt-3 border-t border-subtle pt-3")}>
            {showLabels ? (
              <button
                type="button"
                onClick={toggleMore}
                aria-expanded={moreOpen}
                aria-controls="sidebar-more"
                className="flex h-[30px] w-full items-center gap-1 rounded-md px-2 text-left text-body text-tertiary outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform duration-(--duration-fast) ease-(--ease-standard)", moreOpen && "rotate-90")} />
                More
              </button>
            ) : null}
            {(moreOpen || railCollapsed) && (
              <nav id="sidebar-more" aria-label="More" className={cn("flex flex-col gap-px", showLabels && "animate-fade")}>
                <SidebarItem label="Favorites" icon={<Star />} current={activeIs("favorites")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenFavorites)} />
                <SidebarItem label="Recent" icon={<Clock />} current={activeIs("recents")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenRecents)} />
                <SidebarItem label="Import from history" icon={<History />} current={activeIs("history-dump")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenHistoryDump)} />
                {onOpenTabMap && (
                  <SidebarItem
                    label="Tab map"
                    icon={<Waypoints />}
                    current={activeIs("tab-map")}
                    collapsed={railCollapsed}
                    touch={touch}
                    disabled={tabMapLocked}
                    tooltip={tabMapLocked ? (tabMapLockedReason ?? "Organizing your tabs…") : undefined}
                    onClick={go(onOpenTabMap)}
                  />
                )}
              </nav>
            )}
          </div>
        </div>

        {/* The foot: status, Settings and the account — what belongs at a window's bottom edge. */}
        <div className={cn("flex flex-col gap-px border-t border-subtle p-2", railCollapsed && "px-1.5")}>
          {status && showLabels && <div className="px-2 pb-1">{status}</div>}
          <SidebarItem label="Settings" icon={<Settings />} current={activeIs("settings")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenSettings)} />
          {/* Renders nothing when this deployment has no accounts configured. */}
          {!embedded && <AccountSection showLabels={showLabels} />}
        </div>
      </aside>
      <NewWorkspaceDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreate={(name, brief) => {
          onCreate(name, brief)
          if (mobileOpen) onMobileOpenChange(false)
        }}
      />
    </>
  )
}
