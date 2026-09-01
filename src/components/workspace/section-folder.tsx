"use client"

import { FolderTree } from "lucide-react"
import { collectSectionTreeTabs, type SectionTreeNode } from "@/lib/sections/tree"
import { FolderTile } from "@/components/workspace/folder-tile"

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
  const subtitle =
    node.children.length > 0 ? `${node.children.length} subsection${node.children.length === 1 ? "" : "s"}` : undefined

  return (
    <FolderTile
      name={node.section.name}
      icon={FolderTree}
      accentVar={accent}
      tabs={collectSectionTreeTabs(node)}
      totalCount={node.totalTabCount}
      subtitle={subtitle}
      presence={node.presence}
      onOpen={onOpen}
      onDropTab={onDropTab}
    />
  )
}
