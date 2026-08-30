"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronLeft, Layers, Link2, Tag } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { Textarea } from "@/components/ui/textarea"
import { CATEGORIES, type CategoryId } from "@/lib/categories"
import type { GraphNode } from "@/lib/graph/types"

const SAVE_DEBOUNCE_MS = 400

function PropertyRow({ icon: Icon, label, children }: { icon?: typeof Link2; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1">
      <div className="flex w-24 shrink-0 items-center gap-1.5 pt-0.5 text-label text-tertiary">
        {Icon && <Icon className="size-3.5 shrink-0" />}
        {label}
      </div>
      <div className="min-w-0 flex-1 text-body-sm text-foreground">{children}</div>
    </div>
  )
}

/**
 * Full-page, Obsidian-style document view for a single graph node's notes —
 * a dedicated "page" (fixed overlay, same idiom GraphView itself uses; this
 * app has no client-side routing to hook a real /notes/[id] route into) with
 * a breadcrumb, a document title, a read-only properties block drawn from
 * the tab's real fields, and a borderless, autosizing notes body.
 *
 * GraphView mounts this with `key={node.id}`, so switching the target tab
 * unmounts the previous instance (flushing its draft via the effect below)
 * before mounting a fresh one, rather than needing its own internal
 * "reset on prop change" bookkeeping.
 *
 * Writes through the same onNotesChange → updateWorkspaceTabs path every
 * other notes surface (TabNotesButton) uses — tab.notes stays the single
 * source of truth, this is just another entry point onto it.
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
  useEffect(() => {
    draftRef.current = draft
  }, [draft])
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
  const categoryDef = node.tab.category ? CATEGORIES[node.tab.category as CategoryId] : undefined

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <div className="flex items-center gap-3 border-b border-subtle px-4 py-3 sm:px-8">
        <IconButton aria-label="Back to graph" tooltip="Back to graph" onClick={handleBack}>
          <ChevronLeft />
        </IconButton>
        <p className="min-w-0 truncate text-label text-tertiary">
          {node.workspaceName} <span aria-hidden>/</span> {node.tab.domain}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-10 sm:px-10 sm:py-14">
          <h1 className="text-h1 text-foreground">{title}</h1>

          <div className="mt-6">
            <p className="text-h2 text-foreground">Properties</p>
            <div className="mt-2">
              <PropertyRow label="title">{title}</PropertyRow>
              <PropertyRow label="url" icon={Link2}>
                <span className="block truncate">{node.tab.url}</span>
              </PropertyRow>
              <PropertyRow label="workspace" icon={Layers}>
                {node.workspaceName}
              </PropertyRow>
              {categoryDef && (
                <PropertyRow label="category" icon={Tag}>
                  <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-body-sm"
                    style={{
                      color: `var(${categoryDef.accentColor})`,
                      backgroundColor: `color-mix(in srgb, var(${categoryDef.accentColor}) 16%, transparent)`,
                    }}
                  >
                    {categoryDef.name}
                  </span>
                </PropertyRow>
              )}
            </div>
          </div>

          <div className="my-8 h-px bg-border" />

          <label htmlFor={`graph-notes-page-${node.id}`} className="sr-only">
            Notes
          </label>
          <Textarea
            id={`graph-notes-page-${node.id}`}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Start writing…"
            className="field-sizing-content min-h-[45vh] w-full resize-none border-none bg-transparent p-0 text-body leading-[1.7] text-foreground shadow-none focus-visible:border-none focus-visible:ring-0 dark:bg-transparent placeholder:text-muted-foreground/60"
            // The app sets a global `:focus-visible { outline: ... }` rule (see
            // globals.css) outside any @layer, so it beats every Tailwind
            // utility regardless of specificity — only an inline style can
            // suppress it for this one document-style textarea, where the
            // blinking caret itself is the focus indicator.
            style={{ outline: "none" }}
          />
        </div>
      </div>
    </div>
  )
}
