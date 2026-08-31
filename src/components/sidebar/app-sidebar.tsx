"use client"

import { History, PanelLeftClose, PanelLeftOpen, Settings, Star, Waypoints } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher"
import { avatarFallback } from "@/lib/workspace/favicon"
import { cn } from "@/lib/utils"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The persistent left "Spaces" rail. Deliberately reuses WorkspaceSwitcher
 * as-is for the actual switch/create/rename/delete/import interactions
 * (unstyled logic, already covered by app-shell.test.tsx via its "Switch
 * workspace" trigger) rather than re-implementing that flow — this component
 * only adds the surrounding spatial chrome: brand, collapse state, a
 * per-space compact identity rail, and a Graph nav entry.
 *
 * The rail's rows show an initial-letter badge and tab count only, with the
 * full name in a hover tooltip rather than as inline text — this is a
 * deliberate choice, not just a density preference: WorkspaceSwitcher's own
 * trigger already renders the *current* workspace's name as plain text, and
 * its dropdown renders every workspace's name as plain text while open, so
 * duplicating those names as a second always-visible text node here would
 * make a workspace name resolvable by more than one on-screen element at
 * once — exactly the ambiguity plain-text queries like `getByText(name)`
 * can't tolerate.
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
  onOpenFavorites,
  onOpenRecents,
  onOpenGraph,
  onOpenSettings,
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
  onOpenFavorites: () => void
  onOpenRecents: () => void
  onOpenGraph: () => void
  onOpenSettings: () => void
}) {
  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0]
  const currentRelationships = relationshipCounts[currentId] ?? 0
  // The desktop icon-rail collapse has no business hiding labels inside the
  // mobile drawer — that's a different affordance (off-canvas vs. in-flow)
  // with its own open/closed state. Labels only actually hide when
  // `collapsed` applies, i.e. on desktop and not inside the mobile drawer.
  const showLabels = !collapsed || mobileOpen

  return (
    <>
      {mobileOpen && (
        <div
          aria-hidden
          onClick={() => onMobileOpenChange(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-screen w-60 shrink-0 flex-col border-r border-subtle bg-card transition-transform duration-(--duration-base) ease-(--ease-standard)",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "md:sticky md:top-0 md:z-auto md:translate-x-0 md:transition-[width]",
          collapsed ? "md:w-14" : "md:w-60"
        )}
        // Settings → Appearance → Layout → Sidebar density controls this var
        // (see resolve.ts). Only applied when the rail is actually showing
        // its full-width state — the collapsed desktop icon rail keeps its
        // fixed w-14, which isn't a "density" the appearance system governs.
        style={!collapsed || mobileOpen ? { width: "var(--tabdump-sidebar-width)" } : undefined}
      >
        <div className={cn("flex items-center gap-2 px-3 py-3", showLabels ? "justify-between" : "justify-center")}>
          {showLabels && <p className="text-body font-semibold tracking-tight text-foreground">TabDump</p>}
          <IconButton
            aria-label={mobileOpen ? "Close sidebar" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => (mobileOpen ? onMobileOpenChange(false) : onToggleCollapsed())}
          >
            {showLabels ? <PanelLeftClose /> : <PanelLeftOpen />}
          </IconButton>
        </div>

      <div className={cn("px-3", !showLabels && "w-full overflow-hidden px-2")}>
        <WorkspaceSwitcher
          workspaces={workspaces}
          currentId={currentId}
          onSwitch={onSwitch}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
          onImportFile={onImportFile}
          collapsed={!showLabels}
        />
        {showLabels && current && (
          <p className="mt-0.5 truncate text-meta text-tertiary">
            {current.tabs.length} tab{current.tabs.length === 1 ? "" : "s"}
            {currentRelationships > 0
              ? ` · ${currentRelationships} relationship${currentRelationships === 1 ? "" : "s"}`
              : ""}
          </p>
        )}
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2">
        {showLabels && <p className="px-1.5 pb-1.5 text-label text-tertiary">SPACES</p>}
        <div className="flex flex-col gap-1">
          {workspaces.map((w) => {
            const isActive = w.id === currentId
            const { letter, colorVar } = avatarFallback(w.name)
            const relationships = relationshipCounts[w.id] ?? 0
            return (
              <Tooltip key={w.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => onSwitch(w.id)}
                      aria-label={`Switch to ${w.name}`}
                      aria-current={isActive ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border border-transparent px-1.5 py-1.5 text-left transition-[background-color,border-color,transform] duration-(--duration-fast) ease-(--ease-standard) active:scale-[0.97]",
                        isActive ? "border-primary/30 bg-primary/10" : "hover:bg-accent"
                      )}
                    >
                      <span
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-[0.65rem] font-semibold text-white"
                        style={{ backgroundColor: `var(${colorVar})` }}
                      >
                        {letter}
                      </span>
                      {showLabels && (
                        <span className="ml-auto shrink-0 text-meta text-tertiary">{w.tabs.length}</span>
                      )}
                    </button>
                  }
                />
                <TooltipContent>
                  {w.name} · {w.tabs.length} tab{w.tabs.length === 1 ? "" : "s"}
                  {relationships > 0 ? ` · ${relationships} relationship${relationships === 1 ? "" : "s"}` : ""}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1 border-t border-subtle p-2">
        <IconButton
          aria-label="Open Favorites"
          tooltip="Favorites"
          onClick={onOpenFavorites}
          className={cn("w-full", showLabels && "justify-start gap-2 px-2")}
        >
          <Star />
          {showLabels && <span className="text-body-sm">Favorites</span>}
        </IconButton>
        <IconButton
          aria-label="Open Recent"
          tooltip="Recent"
          onClick={onOpenRecents}
          className={cn("w-full", showLabels && "justify-start gap-2 px-2")}
        >
          <History />
          {showLabels && <span className="text-body-sm">Recent</span>}
        </IconButton>
        <IconButton
          aria-label="Open Graph View"
          tooltip="Graph"
          onClick={onOpenGraph}
          className={cn("w-full", showLabels && "justify-start gap-2 px-2")}
        >
          <Waypoints />
          {showLabels && <span className="text-body-sm">Graph</span>}
        </IconButton>
        <IconButton
          aria-label="Open Settings"
          tooltip="Settings"
          onClick={onOpenSettings}
          className={cn("w-full", showLabels && "justify-start gap-2 px-2")}
        >
          <Settings />
          {showLabels && <span className="text-body-sm">Settings</span>}
        </IconButton>
      </div>
      </aside>
    </>
  )
}
