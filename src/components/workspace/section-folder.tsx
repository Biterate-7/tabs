"use client"

import { useState, type DragEvent } from "react"
import { FolderTree } from "lucide-react"
import { cn } from "@/lib/utils"
import { getDragTabId, hasDragTabId } from "@/lib/collections/drag"
import type { SectionTreeNode } from "@/lib/sections/tree"

/** Small fixed palette (reusing the app's existing category accent tokens) cycled by a hash of the section id — sections are dynamic/user-named, so there's no fixed color map like CATEGORIES has, but reusing these tokens keeps new section tiles visually consistent with the rest of the app instead of introducing a second color system. */
const ACCENT_VARS = [
  "--category-research",
  "--category-school",
  "--category-projects",
  "--category-shopping",
  "--category-creative",
  "--category-news",
  "--category-read-later",
  "--category-other",
]

export function accentForSection(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return ACCENT_VARS[Math.abs(hash) % ACCENT_VARS.length]
}

export function SectionFolder({
  node,
  onOpen,
  onDropTab,
}: {
  node: SectionTreeNode
  onOpen: () => void
  /** Omitted for the synthetic "Other" tile, which isn't a real drop target — a tab lands in Other by having no section, not by being assigned one. */
  onDropTab?: (tabId: string) => void
}) {
  const accent = accentForSection(node.section.id)
  const [dragOver, setDragOver] = useState(false)
  const isEmpty = node.totalTabCount === 0

  function handleDragOver(e: DragEvent<HTMLButtonElement>) {
    if (!onDropTab || !hasDragTabId(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    if (!dragOver) setDragOver(true)
  }

  function handleDragLeave(e: DragEvent<HTMLButtonElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }

  function handleDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setDragOver(false)
    const tabId = getDragTabId(e.dataTransfer)
    if (tabId && onDropTab) onDropTab(tabId)
  }

  if (node.presence === "compact") {
    return (
      <button
        type="button"
        onClick={isEmpty ? undefined : onOpen}
        disabled={isEmpty}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        aria-label={isEmpty ? `${node.section.name}: no tabs` : `Open ${node.section.name}, ${node.totalTabCount} tabs`}
        className={cn(
          "flex min-h-11 items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) sm:min-h-0",
          isEmpty ? "cursor-default opacity-45" : "bg-card hover:border-border",
          dragOver && "border-primary/50 bg-primary/[0.04] ring-1 ring-primary/30"
        )}
      >
        <FolderTree className="size-3.5 shrink-0" style={{ color: `var(${accent})` }} />
        <span className="text-body-sm text-foreground">{node.section.name}</span>
        <span className="ml-auto text-meta text-tertiary">{node.totalTabCount}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label={`Open ${node.section.name}, ${node.totalTabCount} tab${node.totalTabCount === 1 ? "" : "s"}`}
      className={cn(
        "group flex w-full flex-col rounded-xl border border-subtle bg-card p-4 text-left shadow-sm transition-[transform,box-shadow,border-color] duration-(--duration-fast) ease-(--ease-standard) hover:-translate-y-0.5 hover:shadow-md",
        node.presence === "large" && "sm:col-span-2 lg:col-span-1",
        dragOver && "border-primary/50 bg-primary/[0.04] ring-1 ring-primary/30"
      )}
      style={{ minHeight: node.presence === "large" ? 116 : 100 }}
    >
      <div className="flex items-center gap-2">
        <FolderTree className="size-4 shrink-0" style={{ color: `var(${accent})` }} />
        <span className="truncate text-body font-medium text-foreground">{node.section.name}</span>
      </div>
      {node.children.length > 0 && (
        <p className="mt-1 text-meta text-tertiary">
          {node.children.length} subsection{node.children.length === 1 ? "" : "s"}
        </p>
      )}
      <p className="mt-auto pt-3 text-meta text-tertiary">
        {node.totalTabCount} tab{node.totalTabCount === 1 ? "" : "s"}
      </p>
    </button>
  )
}
