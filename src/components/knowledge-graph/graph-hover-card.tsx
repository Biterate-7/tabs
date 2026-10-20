import { KindGlyph } from "@/components/ui/kind-glyph"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import type { KnowledgeNode, Point } from "@/lib/knowledge-graph/types"
import { nodeFacts, nodeTypeLabel } from "./describe"

const WIDTH = 264

/**
 * The preview under the pointer: what it is, where it lives, the facts worth
 * a glance, and what a click does. Positioned beside the node and kept
 * inside the canvas; never takes the pointer.
 */
export function GraphHoverCard({ node, point, bounds, projectName, now, selected }: { node: KnowledgeNode; point: Point; bounds: { width: number; height: number }; projectName?: string; now: number; selected: boolean }) {
  const left = Math.min(Math.max(8, point.x + 16), bounds.width - WIDTH - 8)
  const below = point.y + 132 < bounds.height
  const top = below ? point.y + 16 : Math.max(8, point.y - 124)
  return (
    <div role="presentation" className="surface-panel pointer-events-none absolute z-20 animate-fade p-3" style={{ left, top, width: WIDTH }} data-graph-hover-card>
      <div className="flex items-center gap-2">
        {node.kind === "project" ? <WorkspaceAvatar workspace={{ name: node.label }} size={16} /> : <KindGlyph kind={node.kind} {...(node.type ? { type: node.type } : {})} />}
        <span className="min-w-0 flex-1 truncate text-meta text-tertiary">
          {nodeTypeLabel(node)}
          {projectName && node.kind !== "project" ? ` · ${projectName}` : ""}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-body text-foreground">{node.label}</p>
      <p className="mt-1 text-meta text-muted-foreground">{nodeFacts(node, now).join(" · ")}</p>
      <p className="mt-2 border-t border-subtle pt-2 text-meta text-tertiary">{selected ? "Double-click to open" : "Click for details · double-click to open"}</p>
    </div>
  )
}
