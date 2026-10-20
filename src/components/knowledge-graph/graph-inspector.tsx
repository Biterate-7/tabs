"use client"

import { useMemo } from "react"
import { ArrowLeft, ArrowUpRight, ExternalLink, FolderOpen, Layers, MessageSquareShare, Play, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { KindGlyph } from "@/components/ui/kind-glyph"
import { ProviderBadge } from "@/components/memory/provider-mark"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { EDGE_LABEL } from "@/lib/knowledge-graph/types"
import { formatFullTimestamp, formatRelativeTime } from "@/lib/time-format"
import { tabLabel } from "@/lib/sessions/model"
import { cn } from "@/lib/utils"
import type { KnowledgeEdge, KnowledgeEdgeKind, KnowledgeNode } from "@/lib/knowledge-graph/types"
import type { TabSession } from "@/lib/sessions/types"
import { nodeFacts, nodeTypeLabel } from "./describe"

const OPEN_LABEL: Record<KnowledgeNode["kind"], string> = {
  project: "Open project",
  conversation: "Open conversation",
  source: "Open source",
  file: "Open file",
  note: "Open note",
  session: "Restore session",
}

/** How many of one kind a project's panel lists before "and N more". */
const PER_KIND = 5

/**
 * The contextual inspector: what the selected node is, everything Hubble
 * actually knows about it, how it connects — each relationship a way to
 * travel on — and what can be done with it. Every action goes to the real
 * thing: a conversation's reader, a file's preview, the project, Chrome.
 */
export function GraphInspector({
  node,
  edges,
  byId,
  projectName,
  now,
  session,
  restorePending,
  canGoBack,
  onBack,
  onClose,
  onSelect,
  onOpen,
  onUseInAi,
  onOpenUrl,
  onOpenSessions,
  className,
}: {
  node: KnowledgeNode
  /** Every edge touching the node. */
  edges: readonly KnowledgeEdge[]
  byId: ReadonlyMap<string, KnowledgeNode>
  projectName: (id: string) => string | undefined
  now: number
  session?: TabSession
  restorePending?: boolean
  canGoBack: boolean
  onBack: () => void
  onClose: () => void
  onSelect: (id: string) => void
  onOpen: (node: KnowledgeNode) => void
  onUseInAi?: (node: KnowledgeNode) => void
  onOpenUrl: (url: string) => void
  onOpenSessions?: () => void
  className?: string
}) {
  const relations = useMemo(() => {
    const groups = new Map<KnowledgeEdgeKind, KnowledgeNode[]>()
    for (const edge of edges) {
      const other = byId.get(edge.source === node.id ? edge.target : edge.source)
      if (!other) continue
      // A project's own items are listed by kind below, not as "In project".
      if (node.kind === "project" && (edge.kind === "contains" || edge.kind === "session-project")) continue
      if (node.kind !== "project" && edge.kind === "contains") continue
      groups.set(edge.kind, [...(groups.get(edge.kind) ?? []), other])
    }
    return [...groups.entries()]
  }, [edges, byId, node])

  const projectItems = useMemo(() => {
    if (node.kind !== "project") return []
    const kinds = new Map<string, KnowledgeNode[]>()
    for (const edge of edges) {
      if (edge.kind !== "contains" && edge.kind !== "session-project") continue
      const other = byId.get(edge.target)
      if (!other) continue
      kinds.set(other.kind, [...(kinds.get(other.kind) ?? []), other])
    }
    return [...kinds.entries()].map(([kind, list]) => [kind, list.sort((a, b) => b.at - a.at)] as const)
  }, [edges, byId, node])

  const owner = node.projectId ? projectName(node.projectId) : undefined
  const item = node.item
  const typeLabel = nodeTypeLabel(node)
  const facts = nodeFacts(node, now)

  return (
    <aside aria-label={`${typeLabel}: ${node.label}`} className={cn("surface-panel flex min-h-0 flex-col overflow-hidden", className)} data-graph-inspector={node.kind}>
      <div className="flex items-center gap-1 border-b border-subtle px-2 py-1.5">
        {canGoBack ? (
          <IconButton aria-label="Back to previous selection" tooltip="Back" shortcut="Backspace" onClick={onBack}>
            <ArrowLeft />
          </IconButton>
        ) : null}
        <span className="min-w-0 flex-1 truncate px-1 text-eyebrow text-tertiary">{typeLabel}</span>
        <IconButton aria-label="Close details" tooltip="Close" shortcut="Esc" onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex items-start gap-3 px-4 pt-4">
          {node.kind === "project" ? (
            <WorkspaceAvatar workspace={{ name: node.label }} size={32} />
          ) : (
            <KindGlyph kind={node.kind} {...(node.type ? { type: node.type } : {})} tile />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-h1 break-words text-foreground">{node.label}</h2>
            <p className="mt-0.5 text-meta text-tertiary">{facts.join(" · ")}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 px-4 pt-4">
          <Button type="button" size="lg" onClick={() => onOpen(node)} disabled={node.kind === "session" && (restorePending || !session)}>
            {node.kind === "project" ? <FolderOpen /> : node.kind === "session" ? <Play /> : <ArrowUpRight />}
            {node.kind === "session" ? (restorePending ? "Opening…" : session ? `Restore ${session.tabs.length} ${session.tabs.length === 1 ? "tab" : "tabs"}` : OPEN_LABEL.session) : OPEN_LABEL[node.kind]}
          </Button>
          {onUseInAi && node.kind !== "session" && (
            <Button type="button" size="lg" variant="secondary" onClick={() => onUseInAi(node)}>
              <MessageSquareShare /> Use in AI
            </Button>
          )}
          {node.kind === "session" && onOpenSessions && (
            <Button type="button" size="lg" variant="secondary" onClick={onOpenSessions}>
              <Layers /> All sessions
            </Button>
          )}
        </div>

        <dl className="mx-4 mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-subtle pt-3 text-body-sm">
          {owner && node.projectId && (
            <Row label={node.kind === "session" ? "Project" : "In"}>
              <button type="button" className="truncate text-left text-foreground underline-offset-2 hover:underline" onClick={() => onSelect(`p:${node.projectId}`)}>
                {owner}
              </button>
            </Row>
          )}
          {node.provider && (
            <Row label="From">
              <ProviderBadge provider={node.provider} />
            </Row>
          )}
          {item?.url && (
            <Row label="Address">
              <button type="button" className="flex min-w-0 items-center gap-1 text-left text-link hover:underline" onClick={() => onOpenUrl(item.url!)}>
                <span className="truncate">{item.domain ?? item.url}</span>
                <ExternalLink aria-hidden className="size-3 shrink-0" />
              </button>
            </Row>
          )}
          {item?.fileName && <Row label="File">{item.fileName}</Row>}
          {item && (
            <Row label="Added">
              <time dateTime={new Date(item.addedAt).toISOString()} title={formatFullTimestamp(item.addedAt)}>
                {formatRelativeTime(item.addedAt, now)}
              </time>
            </Row>
          )}
          {session && (
            <>
              <Row label="Saved">{formatRelativeTime(session.updatedAt, now)}</Row>
              {session.lastRestoredAt && <Row label="Last opened">{formatRelativeTime(session.lastRestoredAt, now)}</Row>}
            </>
          )}
          {item?.problem && (
            <Row label="Status">
              <span className="text-warning">{item.problem}</span>
            </Row>
          )}
          {item?.tags && item.tags.length > 0 && <Row label="Tags">{item.tags.join(", ")}</Row>}
        </dl>

        {session && (
          <Section title={`Tabs · ${session.tabs.length}`}>
            <ul className="flex flex-col">
              {session.tabs.slice(0, 8).map((tab) => (
                <li key={tab.id}>
                  <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-xs px-2 py-1 text-left text-body-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground" onClick={() => onOpenUrl(tab.url)}>
                    <span className="min-w-0 flex-1 truncate">{tabLabel(tab)}</span>
                    <ExternalLink aria-hidden className="size-3 shrink-0 opacity-60" />
                  </button>
                </li>
              ))}
            </ul>
            {session.tabs.length > 8 && <p className="px-2 pt-1 text-meta text-tertiary">and {session.tabs.length - 8} more</p>}
          </Section>
        )}

        {projectItems.map(([kind, list]) => (
          <Section key={kind} title={`${kind === "session" ? "Sessions" : kind === "conversation" ? "Conversations" : `${kind[0]!.toUpperCase()}${kind.slice(1)}s`} · ${list.length}`}>
            <NodeList nodes={list.slice(0, PER_KIND)} now={now} onSelect={onSelect} />
            {list.length > PER_KIND && <p className="px-2 pt-1 text-meta text-tertiary">and {list.length - PER_KIND} more</p>}
          </Section>
        ))}

        {relations.map(([kind, list]) => (
          <Section key={kind} title={EDGE_LABEL[kind]}>
            <NodeList nodes={list} now={now} onSelect={onSelect} projectName={projectName} />
          </Section>
        ))}

        {node.kind !== "project" && relations.length === 0 && (
          <p className="mx-4 mt-4 border-t border-subtle pt-3 text-meta text-tertiary">No other connections yet. It connects when the same source, an excerpt of it or a session shows up elsewhere.</p>
        )}
        <div className="h-4" />
      </div>
    </aside>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-tertiary">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{children}</dd>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mx-2 mt-4 border-t border-subtle pt-3">
      <h3 className="px-2 pb-1 text-eyebrow text-tertiary">{title}</h3>
      {children}
    </section>
  )
}

function NodeList({ nodes, now, onSelect, projectName }: { nodes: readonly KnowledgeNode[]; now: number; onSelect: (id: string) => void; projectName?: (id: string) => string | undefined }) {
  return (
    <ul className="flex flex-col">
      {nodes.map((other) => (
        <li key={other.id}>
          <button
            type="button"
            className="group flex w-full min-w-0 items-center gap-2 rounded-xs px-2 py-1.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60"
            onClick={() => onSelect(other.id)}
          >
            {other.kind === "project" ? <WorkspaceAvatar workspace={{ name: other.label }} size={16} /> : <KindGlyph kind={other.kind} {...(other.type ? { type: other.type } : {})} />}
            <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{other.label}</span>
            <span className="shrink-0 text-meta text-tertiary">{projectName && other.projectId ? projectName(other.projectId) : formatRelativeTime(other.at, now)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
