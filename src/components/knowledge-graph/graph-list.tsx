"use client"

import { ArrowUpRight } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { KindGlyph } from "@/components/ui/kind-glyph"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { cn } from "@/lib/utils"
import type { KnowledgeNode } from "@/lib/knowledge-graph/types"
import { nodeFacts, nodeTypeLabel } from "./describe"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * The graph as a list: the same nodes, filters and search, the same
 * selection and inspector, for anyone who would rather read a structure than
 * look at one — or cannot see the canvas at all. Grouped by project, each
 * row saying what a thing is and how many connections it has.
 */
export function GraphList({
  nodes,
  degree,
  projectName,
  now,
  selected,
  onSelect,
  onOpen,
}: {
  nodes: readonly KnowledgeNode[]
  degree: (id: string) => number
  projectName: (id: string) => string | undefined
  now: number
  selected?: string
  onSelect: (id: string) => void
  onOpen: (node: KnowledgeNode) => void
}) {
  const projects = nodes.filter((node) => node.kind === "project")
  const groups = new Map<string, KnowledgeNode[]>()
  const loose: KnowledgeNode[] = []
  for (const node of nodes) {
    if (node.kind === "project") continue
    if (node.projectId) groups.set(node.projectId, [...(groups.get(node.projectId) ?? []), node])
    else loose.push(node)
  }
  // A group whose project is filtered out still lists under its project's name.
  const order = [...projects.map((project) => project.id.slice(2)), ...[...groups.keys()].filter((id) => !projects.some((project) => project.id === `p:${id}`))]

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-40 pb-24 sm:px-6 md:pt-20" data-graph-list>
      {order.map((projectId) => {
        const project = projects.find((entry) => entry.id === `p:${projectId}`)
        const items = (groups.get(projectId) ?? []).sort((a, b) => b.at - a.at)
        const name = projectName(projectId) ?? "Project"
        return (
          <section key={projectId} aria-label={name} className="mb-6">
            {project ? (
              <Row node={project} title={name} subtitle={`${plural(project.size ?? 0, "item", "items")} · ${plural(degree(project.id), "connection", "connections")}`} selected={selected === project.id} onSelect={onSelect} onOpen={onOpen} heading />
            ) : (
              <h2 className="px-2 py-1.5 text-h2 text-muted-foreground">{name}</h2>
            )}
            {items.length > 0 && (
              <ul className="mt-0.5 flex flex-col border-l border-subtle pl-2 sm:ml-3">
                {items.map((node) => (
                  <li key={node.id}>
                    <Row node={node} title={node.label} subtitle={[nodeTypeLabel(node), ...nodeFacts(node, now), plural(degree(node.id), "connection", "connections")].join(" · ")} selected={selected === node.id} onSelect={onSelect} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
      {loose.length > 0 && (
        <section aria-label="Not in a project" className="mb-6">
          <h2 className="px-2 py-1.5 text-eyebrow text-tertiary">Not in a project</h2>
          <ul className="flex flex-col">
            {loose.map((node) => (
              <li key={node.id}>
                <Row node={node} title={node.label} subtitle={[nodeTypeLabel(node), ...nodeFacts(node, now), plural(degree(node.id), "connection", "connections")].join(" · ")} selected={selected === node.id} onSelect={onSelect} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function Row({ node, title, subtitle, selected, onSelect, onOpen, heading = false }: { node: KnowledgeNode; title: string; subtitle: string; selected: boolean; onSelect: (id: string) => void; onOpen: (node: KnowledgeNode) => void; heading?: boolean }) {
  const Title = heading ? "h2" : "span"
  return (
    <div className={cn("group flex items-center gap-1 rounded-md pr-1", selected ? "bg-surface-selected" : "hover:bg-surface-hover")}>
      <button type="button" aria-pressed={selected} onClick={() => onSelect(node.id)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
        {node.kind === "project" ? <WorkspaceAvatar workspace={{ name: title }} size={20} /> : <KindGlyph kind={node.kind} {...(node.type ? { type: node.type } : {})} />}
        <span className="min-w-0 flex-1">
          <Title className={cn("block truncate text-foreground", heading ? "text-h2" : "text-body")}>{title}</Title>
          <span className="block truncate text-meta text-tertiary">{subtitle}</span>
        </span>
      </button>
      <IconButton aria-label={`Open ${title}`} tooltip="Open" className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100" onClick={() => onOpen(node)}>
        <ArrowUpRight />
      </IconButton>
    </div>
  )
}
