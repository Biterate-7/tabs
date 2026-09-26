"use client"

import { Boxes, Clock, PanelLeftClose, PanelLeftOpen, Radio, ScanSearch, ScrollText, Search, Settings, Star, Waypoints } from "lucide-react"
import { AccountSection } from "@/components/auth/account-section"
import { BrandMark } from "@/components/brand-mark"
import { IconButton } from "@/components/ui/icon-button"
import { SidebarItem, SidebarSectionLabel } from "@/components/ui/sidebar-item"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { Kbd } from "@/components/ui/kbd"
import { modKeyLabel } from "@/lib/keyboard"
import { cn } from "@/lib/utils"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Which destination is on screen. Mirrors the `view` union in app-shell —
 * the rail only needs to know enough to light the right row.
 */
export type SidebarView =
  | "workspace"
  | "graph"
  | "settings"
  | "favorites"
  | "recents"
  | "history-dump"
  | "command-centre"
  | "agent-history"
  | "agent-session"

/**
 * The persistent left rail.
 *
 * ## What changed, and why
 *
 * The rail used to put all seven destinations in a footer block pinned
 * below a workspace list that took every remaining pixel — so the nav sat
 * in the last 250px of the column while several hundred px of nothing sat
 * above it, and Settings ended up underneath the floating sync badge.
 * `sidebars.md` › Desktop is explicit about this: "Avoid putting critical
 * information or actions at the bottom of a sidebar. People often relocate
 * a window in a way that hides its bottom edge." Destinations now open the
 * rail and Spaces follow; the only thing left at the foot is the account,
 * which is the one row that genuinely belongs there.
 *
 * Rows are `SidebarItem`, not `IconButton`, so each one carries
 * `aria-current="page"` when it is the view on screen. Before this there
 * was exactly one `aria-current` in the entire shell and it was on the
 * workspace list, which meant nothing anywhere said which destination you
 * were looking at.
 *
 * Icons are one per destination. "Recent" and "Agent History" both used
 * lucide's `History` glyph, so two unrelated rows were visually identical —
 * `sidebars.md` asks for "familiar symbols to represent items in the
 * sidebar", and two items sharing one symbol is the opposite. Recent keeps
 * a clock, Agent History takes a scroll: a record of what happened, which
 * is what it is.
 *
 * ## Workspace rows
 *
 * They show the name. They previously showed an avatar and a count with the
 * name only in a tooltip, which made two workspaces whose names began with
 * the same letter indistinguishable — the seeded "Thesis Research" and
 * "Hubble Build" both rendered as a circled "T". The original reason was a
 * test constraint (WorkspaceSwitcher also renders the current name, so a
 * plain `getByText(name)` could match twice), and that is a real constraint
 * but the wrong thing to spend legibility on. It is resolved here by giving
 * the switcher's trigger and these rows distinct accessible names rather
 * than by hiding one of them.
 */
export function AppSidebar({
  workspaces,
  currentId,
  relationshipCounts,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onMobileOpenChange,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
  onImportFile,
  onUpdateLogo,
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
  currentView = "workspace",
  onOpenSearch,
  embedded = false,
}: {
  workspaces: Workspace[]
  currentId: string
  /** Keyed by workspace id — see lib/workspace/relationships.ts. Missing entries treated as zero. */
  relationshipCounts: Record<string, number>
  /** Desktop-only icon-rail toggle — has no effect below the `md` breakpoint (see mobileOpen). */
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Below `md`, the sidebar is an off-canvas drawer closed by default (there's no room for a permanent column) — opened via a hamburger button in WorkspaceHeader/LandingView. Has no visual effect at `md` and above, where the sidebar is always in-flow. */
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onImportFile: (text: string) => void
  onUpdateLogo: (id: string, logo: string | undefined) => void
  onOpenFavorites: () => void
  onOpenRecents: () => void
  onOpenHistoryDump: () => void
  onOpenGraph: () => void
  /** True while a dump is still being organized/laid out — see lib/organize/lifecycle.ts. Disabled rather than hidden, so its absence never reads as a missing feature. */
  graphLocked?: boolean
  /** What the graph is waiting on, used as the disabled button's tooltip. */
  graphLockedReason?: string
  /**
   * Opens the Agent World.
   *
   * Unconditional, unlike the graph above it. The world is worth opening with
   * nothing running — that is the whole point of the rework — so there is no
   * readiness gate, no agent-history gate and no connector gate on this row.
   * The one state that changes what it shows is the world being switched off
   * in settings, and the view itself says so rather than the rail hiding the
   * way to find out.
   */
  /**
   * Opens Agent History.
   *
   * Unconditional, like the world above it, and for a sharper reason: the
   * whole point of history is to be reachable when nothing is running. A row
   * that appeared only once there was recent activity would be missing in
   * exactly the state someone comes here in - days later, looking for what
   * an agent did.
   */
  onOpenAgentHistory: () => void
  /**
   * The command centre.
   *
   * Unconditional for the same reason History is: the surface has to be
   * reachable in order to say that agents cannot run here, and a row that
   * appeared only once a runtime was available would be missing in exactly
   * the state someone needs the explanation.
   */
  onOpenCommandCentre: () => void
  onOpenSettings: () => void
  /** Returns to the current workspace from any other destination. */
  onOpenWorkspace?: () => void
  /** The destination currently on screen, used to mark the active row. */
  currentView?: SidebarView
  /** Opens the shell's command palette — the rail's search field is its front door. */
  onOpenSearch?: () => void
  /**
   * Rendered inside another surface rather than as the window's own rail —
   * the landing page's product demo. Positioned against its container instead
   * of the viewport (the mobile drawer slides within that container), and
   * without the account row: a demo must never offer a real sign-in.
   */
  embedded?: boolean
}) {
  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0]
  // The desktop icon-rail collapse has no business hiding labels inside the
  // mobile drawer — that's a different affordance (off-canvas vs. in-flow)
  // with its own open/closed state. Labels only actually hide when
  // `collapsed` applies, i.e. on desktop and not inside the mobile drawer.
  const showLabels = !collapsed || mobileOpen
  const railCollapsed = !showLabels
  // Inside the drawer these rows are tapped, and iOS wants 44pt where macOS
  // is happy with 28 (`accessibility.md` › control sizes). The rail keeps
  // its pointer-sized rows.
  const touch = mobileOpen

  /*
    The Session View belongs to Agent History: it is opened from a row there
    and its back action returns there, so History stays lit while a session
    is open rather than leaving no row marked at all.
  */
  const activeIs = (v: SidebarView) =>
    currentView === v || (v === "agent-history" && currentView === "agent-session")

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
          /*
            The rail, measured off the reference's navigation column: the card
            tone, a 5% right hairline, 8px inner inset, 30px rows. It is the
            quietest thing on screen on purpose — the view beside it is the
            product.
          */
          "fixed inset-y-0 left-0 z-40 flex h-screen w-60 shrink-0 flex-col border-r border-subtle bg-sidebar transition-transform duration-(--duration-base) ease-(--ease-standard)",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "md:sticky md:top-0 md:z-auto md:translate-x-0 md:transition-[width]",
          collapsed ? "md:w-14" : "md:w-60",
          embedded && "absolute h-full md:relative md:top-auto"
        )}
        // Settings → Appearance → Layout → Sidebar density controls this var
        // (see resolve.ts). Only applied when the rail is actually showing
        // its full-width state — the collapsed desktop icon rail keeps its
        // fixed w-14, which isn't a "density" the appearance system governs.
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

        <div className={cn("flex shrink-0 flex-col gap-1.5 px-2 pb-2", railCollapsed && "items-center px-0")}>
          {onOpenSearch &&
            (railCollapsed ? (
              <IconButton aria-label="Search" tooltip="Search" shortcut={`${modKeyLabel()} K`} onClick={onOpenSearch}>
                <Search />
              </IconButton>
            ) : (
              <button
                type="button"
                onClick={onOpenSearch}
                aria-label="Search tabs, workspaces and commands"
                className="flex h-[30px] w-full items-center gap-2 rounded-md border border-border bg-background px-2 text-left text-body text-tertiary transition-[border-color,color] duration-(--duration-fast) ease-(--ease-color) outline-none hover:border-strong hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <Search className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Search</span>
                <Kbd keys={[modKeyLabel(), "K"]} />
              </button>
            ))}
          <WorkspaceSwitcher
            workspaces={workspaces}
            currentId={currentId}
            onSwitch={onSwitch}
            onCreate={onCreate}
            onRename={onRename}
            onDelete={onDelete}
            onImportFile={onImportFile}
            onUpdateLogo={onUpdateLogo}
            collapsed={railCollapsed}
          />
        </div>

        {/*
          Destinations, at the top where they are reachable, and scrollable
          together with the workspace list so a long list never pushes the
          nav off the bottom edge.
        */}
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-2 pb-2", railCollapsed && "px-1.5")}>
          <nav aria-label="Views" className="flex flex-col gap-px">
            <SidebarItem
              label="Workspace"
              icon={<Boxes />}
              current={activeIs("workspace")}
              collapsed={railCollapsed}
              touch={touch}
              trailing={current ? current.tabs.length : undefined}
              onClick={onOpenWorkspace}
            />
            <SidebarItem
              label="Graph"
              icon={<Waypoints />}
              current={activeIs("graph")}
              collapsed={railCollapsed}
              touch={touch}
              disabled={graphLocked}
              tooltip={graphLocked ? (graphLockedReason ?? "Organizing your tabs…") : undefined}
              trailing={relationshipCounts[currentId] || undefined}
              onClick={onOpenGraph}
            />
            <SidebarItem
              label="Favorites"
              icon={<Star />}
              current={activeIs("favorites")}
              collapsed={railCollapsed}
              touch={touch}
              onClick={onOpenFavorites}
            />
            <SidebarItem
              label="Recent"
              icon={<Clock />}
              current={activeIs("recents")}
              collapsed={railCollapsed}
              touch={touch}
              onClick={onOpenRecents}
            />
            <SidebarItem
              label="History Dump"
              icon={<ScanSearch />}
              current={activeIs("history-dump")}
              collapsed={railCollapsed}
              touch={touch}
              onClick={onOpenHistoryDump}
            />
          </nav>

          <SidebarSectionLabel collapsed={railCollapsed} className="mt-4">
            Agents
          </SidebarSectionLabel>
          <nav aria-label="Agents" className={cn("flex flex-col gap-px", railCollapsed && "mt-3 border-t border-subtle pt-3")}>
            <SidebarItem
              label="Command Centre"
              icon={<Radio />}
              current={activeIs("command-centre")}
              collapsed={railCollapsed}
              touch={touch}
              onClick={onOpenCommandCentre}
            />
            <SidebarItem
              label="Agent History"
              icon={<ScrollText />}
              current={activeIs("agent-history")}
              collapsed={railCollapsed}
              touch={touch}
              onClick={onOpenAgentHistory}
            />
          </nav>

          <SidebarSectionLabel collapsed={railCollapsed} className="mt-4">
            Workspaces
          </SidebarSectionLabel>
          <div className={cn("flex flex-col gap-px", railCollapsed && "mt-3 border-t border-subtle pt-3")}>
            {workspaces.map((w) => {
              const isActive = w.id === currentId
              const relationships = relationshipCounts[w.id] ?? 0
              const detail = `${w.tabs.length} tab${w.tabs.length === 1 ? "" : "s"}${
                relationships > 0
                  ? ` · ${relationships} relationship${relationships === 1 ? "" : "s"}`
                  : ""
              }`
              return (
                <Tooltip key={w.id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => onSwitch(w.id)}
                        // Distinct from the name alone, so the switcher's
                        // trigger and this row are separately addressable.
                        aria-label={`Switch to ${w.name}`}
                        aria-current={isActive ? "true" : undefined}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-xs border border-transparent px-2 text-left",
                          "transition-[background-color,color] duration-(--duration-fast) ease-(--ease-color)",
                          "outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                          touch ? "h-11" : "h-[30px]",
                          railCollapsed && "justify-center px-0",
                          isActive
                            ? "bg-surface-selected text-foreground"
                            : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                        )}
                      >
                        <WorkspaceAvatar workspace={w} size={16} />
                        {showLabels && <span className="min-w-0 flex-1 truncate text-body">{w.name}</span>}
                        {showLabels && (
                          <span
                            className={cn(
                              "shrink-0 text-meta tabular-nums",
                              isActive ? "text-muted-foreground" : "text-tertiary"
                            )}
                          >
                            {w.tabs.length}
                          </span>
                        )}
                      </button>
                    }
                  />
                  <TooltipContent>
                    {w.name} · {detail}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </div>

        {/*
          The foot holds only what belongs at a window's bottom edge: the
          account, and Settings. Everything a person navigates to is above,
          out of the way of a dragged window.
        */}
        <div className={cn("flex flex-col gap-px border-t border-subtle p-2", railCollapsed && "px-1.5")}>
          <SidebarItem
            label="Settings"
            icon={<Settings />}
            current={activeIs("settings")}
            collapsed={railCollapsed}
            touch={touch}
            onClick={onOpenSettings}
          />
          {/* Renders nothing at all when this deployment has no accounts
              configured, so the rail is unchanged from before accounts
              existed. See AccountSection. */}
          {!embedded && <AccountSection showLabels={showLabels} />}
        </div>
      </aside>
    </>
  )
}

