"use client"

import { ItemIcon } from "@/components/memory/item-icon"
import { KindGlyph } from "@/components/ui/kind-glyph"
import { ProjectIcon } from "@/components/workspace/project-icon"
import type { KnowledgeNode } from "@/lib/knowledge-graph/types"

/** What ProjectIcon needs from a project node: its name, its uploaded image, and the brief's words. */
export function projectIconOf(node: KnowledgeNode) {
  return { name: node.label, ...(node.logo ? { logo: node.logo } : {}), ...(node.context ? { brief: { description: node.context } } : {}) };
}

/**
 * A node as the graph's lists, search, hover card and inspector show it:
 * a project's avatar, a session's glyph, and for everything else the item's
 * own identity — its AI app, its site's icon, or its kind (ItemIcon).
 */
export function NodeIcon({ node, size = 16, tile = false }: { node: KnowledgeNode; size?: number; tile?: boolean }) {
  if (node.kind === "project") return <ProjectIcon workspace={projectIconOf(node)} size={tile ? 32 : size} />
  if (node.kind === "session" || !node.item) return <KindGlyph kind={node.kind} tile={tile} />
  return <ItemIcon item={node.item} {...(node.pageIcon ? { favicon: node.pageIcon } : {})} size={size} tile={tile} />
}
