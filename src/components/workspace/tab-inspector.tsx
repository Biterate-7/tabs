"use client"

import { ExternalLink } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { GraphDependencyPanel } from "@/components/graph/graph-dependency-panel"
import type { DependencyType, TabDependency } from "@/lib/dependencies/types"
import type { DependencyTreeNode } from "@/lib/dependencies/tree"
import type { GraphNode } from "@/lib/graph/types"

/**
 * The workspace's tab detail panel — a right-side Sheet, the same convention
 * CategorySheet and AskTabDumpPanel already use for detail views, not a new
 * layout pattern. Its dependency section is GraphDependencyPanel exactly as
 * Graph View uses it: state-agnostic (a node plus pre-computed dependency
 * data and callbacks), so this reuses the existing dependency functionality
 * instead of standing up a second copy of it.
 */
export function TabInspector({
  open,
  onOpenChange,
  node,
  dependencies,
  usedByDeps,
  tree,
  nodeById,
  onSelectTab,
  onOpenTab,
  onAddDependency,
  onRemoveDependency,
  onChangeDependencyType,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null while the sheet is closed, or if the inspected tab no longer exists. */
  node: GraphNode | null
  dependencies: TabDependency[]
  usedByDeps: TabDependency[]
  tree: DependencyTreeNode[]
  nodeById: Map<string, GraphNode>
  onSelectTab: (id: string) => void
  onOpenTab: (id: string) => void
  onAddDependency: () => void
  onRemoveDependency: (depId: string) => void
  onChangeDependencyType: (depId: string, type: DependencyType | undefined) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col data-[side=right]:w-full sm:data-[side=right]:max-w-sm">
        {node && (
          <>
            <SheetHeader>
              <p className="text-label text-tertiary">TAB</p>
              <div className="flex items-center gap-2.5 pt-1">
                <TabFavicon domain={node.tab.domain} size={28} />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-h2">
                    {node.tab.title?.trim() || node.tab.domain}
                  </SheetTitle>
                  <SheetDescription className="truncate">{node.tab.domain}</SheetDescription>
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <p className="text-meta text-tertiary">Workspace: {node.workspaceName}</p>
                <Button variant="ghost" size="xs" onClick={() => onOpenTab(node.id)}>
                  <ExternalLink /> Open
                </Button>
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <GraphDependencyPanel
                node={node}
                dependencies={dependencies}
                usedByDeps={usedByDeps}
                tree={tree}
                nodeById={nodeById}
                onSelectTab={onSelectTab}
                onOpenTab={onOpenTab}
                onAddDependency={onAddDependency}
                onRemoveDependency={onRemoveDependency}
                onChangeDependencyType={onChangeDependencyType}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
