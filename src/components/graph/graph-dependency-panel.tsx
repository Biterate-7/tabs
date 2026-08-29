"use client"

import { useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, Boxes, ChevronDown, ChevronRight, CornerDownRight, GitBranchPlus, MoreHorizontal, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { EmptyState } from "@/components/ui/empty-state"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { DEPENDENCY_TYPES, DEPENDENCY_TYPE_ORDER } from "@/lib/dependencies/types"
import type { DependencyType, TabDependency } from "@/lib/dependencies/types"
import type { DependencyTreeNode } from "@/lib/dependencies/tree"
import type { GraphNode } from "@/lib/graph/types"

type TabLookup = Map<string, GraphNode>

function labelOf(node: GraphNode | undefined): { title: string; domain?: string } {
  if (!node) return { title: "Deleted tab" }
  return { title: node.tab.title?.trim() || node.tab.domain, domain: node.tab.domain }
}

function TypeIcon({ type, className }: { type?: DependencyType; className?: string }) {
  const Icon = type ? DEPENDENCY_TYPES[type].icon : Boxes
  return <Icon className={className} aria-hidden />
}

function DependencyRow({
  node,
  type,
  onSelect,
  onOpen,
  actions,
}: {
  node: GraphNode | undefined
  type: DependencyType | undefined
  onSelect: () => void
  onOpen: () => void
  actions?: ReactNode
}) {
  const { title, domain } = labelOf(node)
  return (
    <div className="group/dep-row flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-(--duration-fast) hover:bg-accent">
      <TypeIcon type={type} className="size-3.5 shrink-0 text-tertiary" />
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onOpen}
        className="min-w-0 flex-1 text-left"
        title="Click to select · Double-click to open"
      >
        <p className="truncate text-body-sm text-foreground">{title}</p>
        {domain && <p className="truncate text-meta text-tertiary">{domain}</p>}
      </button>
      {node && <TabFavicon domain={node.tab.domain} size={16} />}
      {actions}
    </div>
  )
}

function DependencyTreeRow({
  node,
  nodeById,
  onSelect,
  onOpen,
  depth = 0,
}: {
  node: DependencyTreeNode
  nodeById: TabLookup
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const graphNode = nodeById.get(node.tabId)
  const { title } = labelOf(graphNode)
  const hasChildren = node.children.length > 0

  return (
    <div>
      <div className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent" style={{ paddingLeft: depth * 14 }}>
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((v) => !v)}
            className="flex size-4 shrink-0 items-center justify-center text-tertiary"
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <TypeIcon type={node.type} className="size-3 shrink-0 text-tertiary" />
        {node.isCycle ? (
          <span className="flex items-center gap-1 truncate text-body-sm text-tertiary">
            <CornerDownRight className="size-3 shrink-0" /> {title} (cycle)
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onSelect(node.tabId)}
            onDoubleClick={() => onOpen(node.tabId)}
            className="truncate text-left text-body-sm text-foreground hover:underline"
          >
            {node.isMissing ? "Deleted tab" : title}
          </button>
        )}
      </div>
      {expanded && hasChildren && (
        <div className="duration-(--duration-fast) ease-(--ease-standard) animate-in fade-in-0">
          {node.children.map((child) => (
            <DependencyTreeRow
              key={child.dependencyId}
              node={child}
              nodeById={nodeById}
              onSelect={onSelect}
              onOpen={onOpen}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function GraphDependencyPanel({
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
  node: GraphNode
  dependencies: TabDependency[]
  usedByDeps: TabDependency[]
  tree: DependencyTreeNode[]
  nodeById: TabLookup
  onSelectTab: (id: string) => void
  onOpenTab: (id: string) => void
  onAddDependency: () => void
  onRemoveDependency: (depId: string) => void
  onChangeDependencyType: (depId: string, type: DependencyType | undefined) => void
}) {
  const isEmpty = dependencies.length === 0 && usedByDeps.length === 0

  return (
    <div className="space-y-4 duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0">
      <div className="flex items-center justify-between">
        <p className="truncate text-body-sm font-medium text-foreground">{node.tab.title?.trim() || node.tab.domain}</p>
        <Button variant="ghost" size="xs" onClick={onAddDependency}>
          <GitBranchPlus /> Add
        </Button>
      </div>

      {!isEmpty && (
        <div className="flex items-center gap-3 text-meta text-tertiary">
          <span className="flex items-center gap-1">
            <ArrowDown className="size-3" /> {dependencies.length} dependenc{dependencies.length === 1 ? "y" : "ies"}
          </span>
          <span className="flex items-center gap-1">
            <ArrowUp className="size-3" /> {usedByDeps.length} used by
          </span>
        </div>
      )}

      {isEmpty ? (
        <EmptyState
          icon={Boxes}
          title="No dependencies yet."
          description="Add tabs that this tab relies on."
          action={{ label: "Add dependency…", onClick: onAddDependency }}
        />
      ) : (
        <>
          {dependencies.length > 0 && (
            <div>
              <p className="mb-1 text-label text-tertiary">DEPENDENCIES</p>
              <div className="space-y-0.5">
                {dependencies.map((dep) => (
                  <DependencyRow
                    key={dep.id}
                    node={nodeById.get(dep.childTabId)}
                    type={dep.type}
                    onSelect={() => onSelectTab(dep.childTabId)}
                    onOpen={() => onOpenTab(dep.childTabId)}
                    actions={
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <IconButton
                              aria-label="Dependency actions"
                              className="size-6 opacity-0 group-hover/dep-row:opacity-100"
                            >
                              <MoreHorizontal className="size-3.5" />
                            </IconButton>
                          }
                        />
                        <DropdownMenuContent align="end">
                          {DEPENDENCY_TYPE_ORDER.map((id) => (
                            <DropdownMenuItem key={id} onClick={() => onChangeDependencyType(dep.id, id)}>
                              {DEPENDENCY_TYPES[id].name}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => onRemoveDependency(dep.id)}>
                            <Trash2 /> Remove dependency
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {usedByDeps.length > 0 && (
            <div>
              <p className="mb-1 text-label text-tertiary">USED BY</p>
              <div className="space-y-0.5">
                {usedByDeps.map((dep) => (
                  <DependencyRow
                    key={dep.id}
                    node={nodeById.get(dep.parentTabId)}
                    type={dep.type}
                    onSelect={() => onSelectTab(dep.parentTabId)}
                    onOpen={() => onOpenTab(dep.parentTabId)}
                    actions={
                      <IconButton
                        aria-label="Remove dependency"
                        className="size-6 opacity-0 group-hover/dep-row:opacity-100"
                        onClick={() => onRemoveDependency(dep.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {tree.length > 0 && (
            <div>
              <p className="mb-1 text-label text-tertiary">DEPENDENCY TREE</p>
              <div className="rounded-md border border-subtle p-1.5">
                {tree.map((child) => (
                  <DependencyTreeRow
                    key={child.dependencyId}
                    node={child}
                    nodeById={nodeById}
                    onSelect={onSelectTab}
                    onOpen={onOpenTab}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
