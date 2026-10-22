"use client"

import { ItemIcon } from "@/components/memory/item-icon"
import { KindGlyph } from "@/components/ui/kind-glyph"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import type { KnowledgeNode } from "@/lib/knowledge-graph/types"

/**
 * A node as the graph's lists, search, hover card and inspector show it:
 * a project's avatar, a session's glyph, and for everything else the item's
 * own identity — its AI app, its site's icon, or its kind (ItemIcon).
 */
export function NodeIcon({ node, size = 16, tile = false }: { node: KnowledgeNode; size?: number; tile?: boolean }) {
  if (node.kind === "project") return <WorkspaceAvatar workspace={{ name: node.label }} size={tile ? 32 : size} />
  if (node.kind === "session" || !node.item) return <KindGlyph kind={node.kind} tile={tile} />
  return <ItemIcon item={node.item} {...(node.pageIcon ? { favicon: node.pageIcon } : {})} size={size} tile={tile} />
}
