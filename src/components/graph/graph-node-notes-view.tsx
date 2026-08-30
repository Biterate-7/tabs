"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronLeft } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { Textarea } from "@/components/ui/textarea"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import type { GraphNode } from "@/lib/graph/types"

const SAVE_DEBOUNCE_MS = 400

/**
 * Full-page notes editor for a single graph node — replaces the old
 * GraphNotesPopover's small canvas-anchored panel. GraphView mounts this
 * with `key={node.id}`, so switching the target tab unmounts the previous
 * instance (flushing its draft via the effect below) before mounting a
 * fresh one, rather than needing its own internal "reset on prop change"
 * bookkeeping.
 *
 * Writes through the same onNotesChange → updateWorkspaceTabs path every
 * other notes surface (TabNotesButton, the old popover) uses — tab.notes
 * stays the single source of truth, this is just another entry point onto it.
 */
export function GraphNodeNotesView({
  node,
  onNotesChange,
  onClose,
}: {
  node: GraphNode
  onNotesChange: (id: string, notes: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(node.tab.notes ?? "")
  const draftRef = useRef(draft)
  draftRef.current = draft
  // Tracks the last value actually persisted, so the debounced autosave and
  // the unmount-flush below never send a redundant duplicate write.
  const savedRef = useRef(node.tab.notes ?? "")

  function commit(value: string) {
    const trimmed = value.trim()
    if (trimmed === savedRef.current) return
    savedRef.current = trimmed
    onNotesChange(node.id, trimmed)
  }

  // Debounced autosave while typing — mirrors the graph's own camera-save
  // debounce (see SAVE_DEBOUNCE_MS in graph-view.tsx) so persistence still
  // goes through updateWorkspaceTabs "immediately" without a localStorage
  // write on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => commit(draft), SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // Flush whatever hasn't been saved yet when this view goes away — Back
  // button, or the key-change unmount when GraphView retargets to a
  // different node — so the last debounce window's worth of typing is never
  // silently dropped.
  useEffect(() => {
    return () => commit(draftRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleBack() {
    commit(draftRef.current)
    onClose()
  }

  const title = node.tab.title?.trim() || node.tab.domain

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <div className="flex items-center gap-3 border-b border-subtle px-4 py-3">
        <IconButton aria-label="Back to graph" tooltip="Back to graph" onClick={handleBack}>
          <ChevronLeft />
        </IconButton>
        <TabFavicon domain={node.tab.domain} size={24} />
        <div className="min-w-0">
          <p className="truncate text-body-sm font-medium text-foreground">{title}</p>
          <p className="truncate text-meta text-tertiary">{node.tab.domain}</p>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-2 overflow-y-auto px-4 py-6">
        <label htmlFor={`graph-notes-page-${node.id}`} className="text-label text-tertiary">
          Notes
        </label>
        <Textarea
          id={`graph-notes-page-${node.id}`}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Add a note for ${node.tab.domain}…`}
          className="field-sizing-fixed h-full min-h-0 flex-1 resize-none text-body leading-relaxed"
        />
      </div>
    </div>
  )
}
