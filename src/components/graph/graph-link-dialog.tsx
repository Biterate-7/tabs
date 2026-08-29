"use client"

import { useMemo, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { EmptyState } from "@/components/ui/empty-state"
import { Link2 } from "lucide-react"
import { matchesGraphQuery } from "@/lib/graph/search"
import type { GraphNode } from "@/lib/graph/types"

export function GraphLinkDialog({
  open,
  onOpenChange,
  sourceNode,
  candidates,
  onLink,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceNode: GraphNode | null
  candidates: GraphNode[]
  onLink: (targetId: string) => void
}) {
  const [query, setQuery] = useState("")

  const results = useMemo(() => {
    if (!query.trim()) return candidates
    return candidates.filter((node) => matchesGraphQuery(node, query))
  }, [candidates, query])

  function handleSelect(id: string) {
    onLink(id)
    setQuery("")
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("")
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link to…</DialogTitle>
          <DialogDescription>
            {sourceNode
              ? `Connect "${sourceNode.tab.title?.trim() || sourceNode.tab.domain}" to another tab.`
              : "Connect this tab to another tab."}
          </DialogDescription>
        </DialogHeader>

        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tabs to link…"
        />

        <ScrollArea className="h-64 -mx-1 px-1">
          {results.length === 0 ? (
            <EmptyState icon={Link2} title="No tabs match" description="Try a different search." />
          ) : (
            <div className="space-y-0.5">
              {results.map((node) => (
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
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
