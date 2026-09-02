"use client"

import { PanelRightClose, PanelRightOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Pill } from "@/components/workspace/category-filter-bar"
import { GraphSearch } from "./graph-search"
import { GraphSettingsPanel } from "./graph-settings-panel"
import { GraphDependencyPanel } from "./graph-dependency-panel"
import { GraphCollectionPanel } from "./graph-collection-panel"
import type { DependencyType, TabDependency } from "@/lib/dependencies/types"
import type { DependencyTreeNode } from "@/lib/dependencies/tree"
import type { Collection } from "@/lib/collections/types"
import type {
  ConnectionFilters,
  GraphDepth,
  GraphDisplaySettings,
  GraphNode,
  GraphViewMode,
} from "@/lib/graph/types"

const DEPTH_OPTIONS: { key: GraphDepth; label: string }[] = [
  { key: 1, label: "1" },
  { key: 2, label: "2" },
  { key: 3, label: "3" },
  { key: "infinite", label: "∞" },
]

export function GraphSidebar({
  open,
  onToggle,
  query,
  onQueryChange,
  searchResults,
  onSelectResult,
  view,
  onViewChange,
  depth,
  onDepthChange,
  filters,
  onFiltersChange,
  display,
  onDisplayChange,
  showClusterBoundaries,
  onShowClusterBoundariesChange,
  workspaces,
  workspaceFilter,
  onWorkspaceFilterChange,
  onFit,
  selectedNode,
  dependenciesOfSelected,
  usedByOfSelected,
  dependencyTree,
  allNodeById,
  onSelectTab,
  onOpenTab,
  onAddDependency,
  onRemoveDependency,
  onChangeDependencyType,
  onOpenNotes,
  selectedCollection,
  onFocusCollection,
  onRenameCollection,
  onOpenAllInCollection,
  onDeleteCollection,
}: {
  open: boolean
  onToggle: () => void
  query: string
  onQueryChange: (value: string) => void
  searchResults: GraphNode[]
  onSelectResult: (id: string) => void
  view: GraphViewMode
  onViewChange: (view: GraphViewMode) => void
  depth: GraphDepth
  onDepthChange: (depth: GraphDepth) => void
  filters: ConnectionFilters
  onFiltersChange: (filters: ConnectionFilters) => void
  display: GraphDisplaySettings
  onDisplayChange: (display: GraphDisplaySettings) => void
  showClusterBoundaries: boolean
  onShowClusterBoundariesChange: (value: boolean) => void
  workspaces: { id: string; name: string }[]
  workspaceFilter: string | "all"
  onWorkspaceFilterChange: (value: string | "all") => void
  onFit: () => void
  /** The currently-selected tab's dependency detail — omitted (undefined) entirely when nothing is selected. */
  selectedNode?: GraphNode | null
  dependenciesOfSelected: TabDependency[]
  usedByOfSelected: TabDependency[]
  dependencyTree: DependencyTreeNode[]
  allNodeById: Map<string, GraphNode>
  onSelectTab: (id: string) => void
  onOpenTab: (id: string) => void
  onAddDependency: () => void
  onRemoveDependency: (depId: string) => void
  onChangeDependencyType: (depId: string, type: DependencyType | undefined) => void
  onOpenNotes: (id: string) => void
  /** The currently-selected collection region's detail — omitted (undefined) when nothing is selected. Mutually exclusive with selectedNode (see graph-canvas.tsx). */
  selectedCollection?: Collection | null
  onFocusCollection: () => void
  onRenameCollection: () => void
  onOpenAllInCollection: () => void
  onDeleteCollection: () => void
}) {
  if (!open) {
    return (
      <div className="absolute top-4 right-4 z-10">
        <IconButton aria-label="Open graph settings" tooltip="Graph settings" onClick={onToggle}>
          <PanelRightOpen />
        </IconButton>
      </div>
    )
  }

  return (
    <div className="absolute top-0 right-0 z-10 flex h-full w-72 max-w-[85vw] flex-col border-l border-subtle bg-popover/95 shadow-lg backdrop-blur-sm duration-(--duration-slow) ease-(--ease-standard) animate-in slide-in-from-right">
      <div className="flex items-center justify-between border-b border-subtle px-3 py-3">
        <p className="text-label text-tertiary">GRAPH</p>
        <IconButton aria-label="Collapse sidebar" tooltip="Collapse sidebar" onClick={onToggle}>
          <PanelRightClose />
        </IconButton>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-3 py-3">
          <GraphSearch
            query={query}
            onQueryChange={onQueryChange}
            matches={searchResults}
            onSelectResult={onSelectResult}
          />

          <div className="h-px bg-border" />

          <div>
            <p className="text-label text-tertiary">VIEW</p>
            <div className="mt-2 flex gap-1.5">
              <Pill active={view === "global"} onClick={() => onViewChange("global")}>
                Global
              </Pill>
              <Pill active={view === "local"} onClick={() => onViewChange("local")}>
                Local
              </Pill>
            </div>
            {view === "local" && (
              <div className="mt-3">
                <p className="mb-1.5 text-body-sm text-muted-foreground">Depth</p>
                <div className="flex gap-1.5">
                  {DEPTH_OPTIONS.map((opt) => (
                    <Pill key={opt.key} active={depth === opt.key} onClick={() => onDepthChange(opt.key)}>
                      {opt.label}
                    </Pill>
                  ))}
                </div>
              </div>
            )}
          </div>

          {selectedNode && (
            <>
              <div className="h-px bg-border" />
              <GraphDependencyPanel
                node={selectedNode}
                dependencies={dependenciesOfSelected}
                usedByDeps={usedByOfSelected}
                tree={dependencyTree}
                nodeById={allNodeById}
                onSelectTab={onSelectTab}
                onOpenTab={onOpenTab}
                onAddDependency={onAddDependency}
                onRemoveDependency={onRemoveDependency}
                onChangeDependencyType={onChangeDependencyType}
                onOpenNotes={() => onOpenNotes(selectedNode.id)}
              />
            </>
          )}

          {selectedCollection && (
            <>
              <div className="h-px bg-border" />
              <GraphCollectionPanel
                collection={selectedCollection}
                nodeById={allNodeById}
                onSelectTab={onSelectTab}
                onOpenTab={onOpenTab}
                onFocus={onFocusCollection}
                onRename={onRenameCollection}
                onOpenAll={onOpenAllInCollection}
                onDelete={onDeleteCollection}
              />
            </>
          )}

          <div className="h-px bg-border" />

          <GraphSettingsPanel
            filters={filters}
            onFiltersChange={onFiltersChange}
            display={display}
            onDisplayChange={onDisplayChange}
            showClusterBoundaries={showClusterBoundaries}
            onShowClusterBoundariesChange={onShowClusterBoundariesChange}
            workspaces={workspaces}
            workspaceFilter={workspaceFilter}
            onWorkspaceFilterChange={onWorkspaceFilterChange}
          />
        </div>
      </ScrollArea>

      <div className="border-t border-subtle p-3">
        <Button variant="secondary" size="sm" className="w-full" onClick={onFit}>
          Fit graph
        </Button>
      </div>
    </div>
  )
}
