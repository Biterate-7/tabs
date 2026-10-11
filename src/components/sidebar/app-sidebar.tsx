"use client"

import { useState } from "react"
import type { NewProjectBrief } from "@/components/workspace/new-workspace-dialog"
import {
  ChevronRight,
  Clock,
  History,
  House,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Star,
  Waypoints,
} from "lucide-react"
import { AccountSection } from "@/components/auth/account-section"
import { BrandMark } from "@/components/brand-mark"
import { IconButton } from "@/components/ui/icon-button"
import { SidebarItem, SidebarSectionLabel } from "@/components/ui/sidebar-item"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { NewWorkspaceDialog } from "@/components/workspace/new-workspace-dialog"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { Kbd } from "@/components/ui/kbd"
import { modKeyLabel } from "@/lib/keyboard"
import { subjectName } from "@/lib/product/subjects"
import { cn } from "@/lib/utils"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Which destination is on screen. Mirrors the `view` union in app-shell —
 * the rail only needs to know enough to light the right row.
 */
export type SidebarView =
  | "home"
  | "ai"
  | "workspace"
  | "graph"
  | "settings"
  | "favorites"
  | "recents"
  | "history-dump"
  | "command-centre"
  | "agent-history"
  | "agent-session"

/** Destinations that live under "More" — power tools a student never needs to find. */
const MORE_VIEWS: readonly SidebarView[] = ["command-centre", "agent-history", "agent-session", "graph", "favorites", "recents", "history-dump"]

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

/**
 * The persistent left rail.
 *
 *     Hubble
 *     [Search Hubble]
 *     Home
 *     AI
 *     SUBJECTS                +
 *       History HL
 *       Math AA HL
 *     More ›        AI chats (the Command Centre), AI activity, Graph…
 *     ─────
 *     Settings
 *
 * ## Subject-first
 *
 * A student's mental model is subjects → their stuff → AI, so the rail is
 * exactly that: Home, AI, and the subjects themselves (workspaces, shown as
 * subjects — see lib/product/subjects.ts). Opening a subject opens it; the
 * "+" makes one. Nothing else competes for the first glance.
 *
 * ## Progressive disclosure
 *
 * Everything that used to sit beside them — the Command Centre, AI activity
 * (Agent History), the Graph, Favorites, Recent, Import from history — is
 * kept and one click away under "More", closed by default. The group opens
 * itself whenever one of its destinations is on screen, so the current row
 * is never hidden, and remembers being opened by hand.
 *
 * Rows are `SidebarItem`, so the destination on screen carries
 * `aria-current="page"`. Subject rows carry `aria-current` while that
 * subject is open.
 *
 * Renaming, deleting and importing subjects moved off the rail: to the
 * subject's own menu and Settings → Subjects.
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
  graphLocked = false,
  graphLockedReason,
  onOpenCommandCentre,
  onOpenAgentHistory,
  onOpenSettings,
  onOpenWorkspace,
  onOpenHome,
  onOpenAI,
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
  /** Opens a subject's page. Absent: switching is all a row does (the landing demo). */
  onOpenSubject?: (id: string) => void
  onCreate: (name: string, brief?: NewProjectBrief) => void
  onOpenFavorites: () => void
  onOpenRecents: () => void
  onOpenHistoryDump: () => void
  onOpenGraph: () => void
  /** True while a dump is still being organized/laid out — see lib/organize/lifecycle.ts. Disabled rather than hidden. */
  graphLocked?: boolean
  /** What the graph is waiting on, used as the disabled row's tooltip. */
  graphLockedReason?: string
  /** Agent History, shown as "AI activity". Unconditional: history exists to be reachable when nothing is running. */
  onOpenAgentHistory: () => void
  /** The Command Centre, shown as "AI chats". Unconditional, under More: every AI chat, live and past. */
  onOpenCommandCentre: () => void
  onOpenSettings: () => void
  /** Returns to the current workspace from any other destination. */
  onOpenWorkspace?: () => void
  /** Home. Absent: no Home row (the landing demo, which has no Home). */
  onOpenHome?: () => void
  /** The AI page. Absent: no AI row. */
  onOpenAI?: () => void
  /** The destination currently on screen, used to mark the active row. */
  currentView?: SidebarView
  /** Opens the shell's search — the rail's search field is its front door. */
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

  /*
    The Session View belongs to AI activity: it is opened from a row there
    and its back action returns there, so that row stays lit while a
    session is open.
  */
  const activeIs = (v: SidebarView) => currentView === v || (v === "agent-history" && currentView === "agent-session")

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

  return (
    <>
      {mobileOpen && (
        <div
          aria-hidden
          onClick={() => onMobileOpenChange(false)}
          className={cn(embedded ? "absolute" : "fixed", "inset-0 z-30 bg-(--overlay) md:hidden")}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-screen w-60 shrink-0 flex-col border-r border-subtle bg-sidebar transition-transform duration-(--duration-base) ease-(--ease-standard)",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "md:sticky md:top-0 md:z-auto md:translate-x-0 md:transition-[width]",
          collapsed ? "md:w-14" : "md:w-60",
          embedded && "absolute h-full md:relative md:top-auto"
        )}
        // Settings → Appearance → Layout → Sidebar density controls this var.
        style={!collapsed || mobileOpen ? { width: "var(--tabdump-sidebar-width)" } : undefined}
      >
        {/* Brand row: the mark in the logo's slot, at the logo's size. */}
        <div className={cn("flex h-12 shrink-0 items-center gap-2 px-3", showLabels ? "justify-between" : "justify-center px-0")}>
          {showLabels && (
            <span className="flex min-w-0 items-center gap-2 pl-1 text-foreground">
              <BrandMark className="size-[18px]" />
              <span className="font-display text-[15px] leading-none font-medium tracking-[-0.01em]">Hubble</span>
            </span>
          )}
          <IconButton
            aria-label={mobileOpen ? "Close sidebar" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => (mobileOpen ? onMobileOpenChange(false) : onToggleCollapsed())}
          >
            {showLabels ? <PanelLeftClose /> : <PanelLeftOpen />}
          </IconButton>
        </div>

        {onOpenSearch && (
          <div className={cn("flex shrink-0 flex-col px-2 pb-2", railCollapsed && "items-center px-0")}>
            {railCollapsed ? (
              <IconButton aria-label="Search Hubble" tooltip="Search Hubble" shortcut={`${modKeyLabel()} K`} onClick={onOpenSearch}>
                <Search />
              </IconButton>
            ) : (
              <button
                type="button"
                onClick={go(onOpenSearch)}
                aria-label="Search Hubble"
                className="flex h-[30px] w-full items-center gap-2 rounded-md border border-border bg-background px-2 text-left text-body text-tertiary transition-[border-color,color] duration-(--duration-fast) ease-(--ease-color) outline-none hover:border-strong hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <Search className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Search Hubble</span>
                <Kbd keys={[modKeyLabel(), "K"]} />
              </button>
            )}
          </div>
        )}

        <div className={cn("min-h-0 flex-1 overflow-y-auto px-2 pb-2", railCollapsed && "px-1.5")}>
          {(onOpenHome || onOpenAI) && (
            <nav aria-label="Main" className="flex flex-col gap-px">
              {onOpenHome && (
                <SidebarItem label="Home" icon={<House />} current={activeIs("home")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenHome)} />
              )}
              {onOpenAI && (
                <SidebarItem label="AI" icon={<Sparkles />} current={activeIs("ai")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenAI)} />
              )}
            </nav>
          )}

          <div className={cn("mt-4 flex items-center justify-between pr-1", railCollapsed && "mt-3 justify-center border-t border-subtle pt-3 pr-0")}>
            <SidebarSectionLabel collapsed={railCollapsed}>Subjects</SidebarSectionLabel>
            <IconButton aria-label="New subject" tooltip="New subject" onClick={() => setNewOpen(true)} className={cn("size-6", railCollapsed && "hidden")}>
              <Plus />
            </IconButton>
          </div>
          <nav aria-label="Subjects" className="mt-0.5 flex flex-col gap-px">
            {workspaces.map((w) => {
              const isOpen = w.id === currentId && currentView === "workspace"
              const isCurrent = w.id === currentId
              const name = subjectName(w)
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
                          "flex w-full items-center gap-2 rounded-xs border border-transparent px-2 text-left",
                          "transition-[background-color,color] duration-(--duration-fast) ease-(--ease-color)",
                          "outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                          touch ? "h-11" : "h-[30px]",
                          railCollapsed && "justify-center px-0",
                          isOpen ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                        )}
                      >
                        <WorkspaceAvatar workspace={w} size={16} />
                        {showLabels && <span className="min-w-0 flex-1 truncate text-body">{name}</span>}
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
                  "flex w-full items-center gap-2 rounded-xs px-2 text-left text-body text-tertiary outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
                  touch ? "h-11" : "h-[30px]"
                )}
              >
                <Plus className="size-4 shrink-0" aria-hidden />
                New subject
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
                className="flex h-[30px] w-full items-center gap-1 rounded-xs px-2 text-left text-body text-tertiary outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform duration-(--duration-fast)", moreOpen && "rotate-90")} />
                More
              </button>
            ) : null}
            {(moreOpen || railCollapsed) && (
              <nav id="sidebar-more" aria-label="More" className="flex flex-col gap-px">
                <SidebarItem label="AI chats" icon={<Radio />} current={activeIs("command-centre")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenCommandCentre)} />
                <SidebarItem label="AI activity" icon={<ScrollText />} current={activeIs("agent-history")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenAgentHistory)} />
                <SidebarItem
                  label="Graph"
                  icon={<Waypoints />}
                  current={activeIs("graph")}
                  collapsed={railCollapsed}
                  touch={touch}
                  disabled={graphLocked}
                  tooltip={graphLocked ? (graphLockedReason ?? "Organizing your tabs…") : undefined}
                  onClick={go(onOpenGraph)}
                />
                <SidebarItem label="Favorites" icon={<Star />} current={activeIs("favorites")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenFavorites)} />
                <SidebarItem label="Recent" icon={<Clock />} current={activeIs("recents")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenRecents)} />
                <SidebarItem label="Import from history" icon={<History />} current={activeIs("history-dump")} collapsed={railCollapsed} touch={touch} onClick={go(onOpenHistoryDump)} />
              </nav>
            )}
          </div>
        </div>

        {/* The foot: Settings and the account — what belongs at a window's bottom edge. */}
        <div className={cn("flex flex-col gap-px border-t border-subtle p-2", railCollapsed && "px-1.5")}>
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
