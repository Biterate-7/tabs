"use client"

import { useMemo, useState } from "react"
import { Check, Link2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { EmptyState } from "@/components/ui/empty-state"
import { matchesGraphQuery } from "@/lib/graph/search"
import { DEPENDENCY_TYPES, DEPENDENCY_TYPE_ORDER } from "@/lib/dependencies/types"
import type { DependencyType } from "@/lib/dependencies/types"
import type { GraphNode } from "@/lib/graph/types"

export type GraphLinkDialogMode = "link" | "dependency"

/**
 * Shared by the manual "Link to…" flow and the "Add dependency…" flow — both
 * are fundamentally "search this workspace's tabs, pick one," so they share
 * search/candidate-list UI rather than duplicating a second picker dialog
 * (AGENTS.md section 26). The two flows diverge after a pick: link mode
 * connects and closes immediately (a link has no further attributes to set),
 * while dependency mode holds the dialog open for a type pick and an
 * explicit confirm — see AGENTS.md section 4's two-step mockup.
 */
export function GraphLinkDialog({
  open,
  onOpenChange,
  mode = "link",
  sourceNode,
  candidates,
  existingDependencyTargetIds,
  onLink,
  onAddDependency,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode?: GraphLinkDialogMode
  sourceNode: GraphNode | null
  candidates: GraphNode[]
  /** Dependency mode only — target ids already a dependency of sourceNode, shown with a checkmark rather than hidden (AGENTS.md section 4: "existing relationships should be clearly indicated"). */
  existingDependencyTargetIds?: Set<string>
  onLink?: (targetId: string) => void
  onAddDependency?: (targetId: string, type: DependencyType | undefined) => void
}) {
  const [query, setQuery] = useState("")
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [type, setType] = useState<DependencyType | undefined>(undefined)

  const isDependency = mode === "dependency"

  const results = useMemo(() => {
    if (!query.trim()) return candidates
    return candidates.filter((node) => matchesGraphQuery(node, query))
  }, [candidates, query])

  const picked = pickedId ? (candidates.find((n) => n.id === pickedId) ?? null) : null
  const alreadyExists = pickedId ? (existingDependencyTargetIds?.has(pickedId) ?? false) : false

  function reset() {
    setQuery("")
    setPickedId(null)
    setType(undefined)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function handleSelect(id: string) {
    if (isDependency) {
      setPickedId(id)
      return
    }
    onLink?.(id)
    handleOpenChange(false)
  }

  function handleConfirmDependency() {
    if (!pickedId || alreadyExists) return
    onAddDependency?.(pickedId, type)
    handleOpenChange(false)
  }

  const sourceLabel = sourceNode?.tab.title?.trim() || sourceNode?.tab.domain || "this tab"
  const title = isDependency ? "Add dependency" : "Link to…"
  const description = isDependency
    ? `What does "${sourceLabel}" depend on?`
    : `Connect "${sourceLabel}" to another tab.`

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {isDependency && sourceNode && (
          <div>
            <p className="mb-1 text-label text-tertiary">PARENT</p>
            <div className="flex items-center gap-2.5 rounded-md border border-subtle bg-muted/40 px-2.5 py-2">
              <TabFavicon domain={sourceNode.tab.domain} size={20} />
              <p className="truncate text-body-sm font-medium text-foreground">{sourceLabel}</p>
            </div>
          </div>
        )}

        {isDependency && picked ? (
          <div className="space-y-3 duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0 slide-in-from-bottom-1">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-label text-tertiary">DEPENDS ON</p>
                <button
                  type="button"
                  onClick={() => setPickedId(null)}
                  className="text-label text-accent-text hover:underline"
                >
                  Change
                </button>
              </div>
              <div className="flex items-center gap-2.5 rounded-md border border-subtle px-2.5 py-2">
                <TabFavicon domain={picked.tab.domain} size={20} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body-sm font-medium text-foreground">
                    {picked.tab.title?.trim() || picked.tab.domain}
                  </p>
                  <p className="truncate text-meta text-tertiary">{picked.tab.domain}</p>
                </div>
                {alreadyExists && <Check className="size-4 shrink-0 text-success" aria-hidden />}
              </div>
              {alreadyExists && <p className="mt-1 text-meta text-tertiary">Already a dependency.</p>}
            </div>

            <div>
              <p className="mb-1 text-label text-tertiary">DEPENDENCY TYPE</p>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="sm" className="w-full justify-start">
                      {type ? DEPENDENCY_TYPES[type].name : "No type"}
                    </Button>
                  }
                />
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setType(undefined)}>
                    {!type && <Check className="size-3.5" />} No type
                  </DropdownMenuItem>
                  {DEPENDENCY_TYPE_ORDER.map((id) => (
                    <DropdownMenuItem key={id} onClick={() => setType(id)}>
                      {type === id && <Check className="size-3.5" />} {DEPENDENCY_TYPES[id].name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ) : (
          <>
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isDependency ? "Search tabs…" : "Search tabs to link…"}
            />

            <ScrollArea className="h-64 -mx-1 px-1">
              {results.length === 0 ? (
                <EmptyState icon={Link2} title="No tabs match" description="Try a different search." />
              ) : (
                <div className="space-y-0.5">
                  {results.map((node) => {
                    const isExisting = isDependency && (existingDependencyTargetIds?.has(node.id) ?? false)
                    return (
                      <button
                        key={node.id}
                        type="button"
                        onClick={() => handleSelect(node.id)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-accent"
                      >
                        <TabFavicon domain={node.tab.domain} size={22} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-body-sm font-medium text-foreground">
                            {node.tab.title?.trim() || node.tab.domain}
                          </p>
                          <p className="truncate text-meta text-tertiary">
                            {node.tab.domain} · {node.workspaceName}
                          </p>
                        </div>
                        {isExisting && <Check className="size-4 shrink-0 text-success" aria-label="Already a dependency" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </ScrollArea>
          </>
        )}

        {isDependency && picked && (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmDependency} disabled={alreadyExists}>
              Add dependency
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
