"use client"

import { useMemo, useState } from "react"
import { ArrowLeft, ArrowUpRight, ExternalLink, FolderOpen, Layers, MessageSquareShare, MoreHorizontal, Play, Star, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Textarea } from "@/components/ui/textarea"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ProviderBadge } from "@/components/memory/provider-mark"
import { DEPENDENCY_TYPES, DEPENDENCY_TYPE_ORDER } from "@/lib/dependencies/types"
import { EDGE_LABEL, PERSONAL_EDGE_KINDS } from "@/lib/knowledge-graph/types"
import { formatFullTimestamp, formatRelativeTime } from "@/lib/time-format"
import { tabLabel } from "@/lib/sessions/model"
import { cn } from "@/lib/utils"
import type { DependencyType } from "@/lib/dependencies/types"
import type { KnowledgeEdge, KnowledgeNode } from "@/lib/knowledge-graph/types"
import type { TabSession } from "@/lib/sessions/types"
import { nodeFacts, nodeTypeLabel } from "./describe"
import { NodeIcon } from "./node-icon"
import { TabMenuItems } from "./tab-actions"
import type { GraphTab, GraphTabActions } from "./tab-actions"

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

/** A relationship group as the inspector lists it; dependencies read differently from each end. */
type RelationGroup = { key: string; title: string; entries: { node: KnowledgeNode; edge: KnowledgeEdge }[] }

/** The order relationship groups are listed in: the person's own first, then what Hubble found. */
const GROUP_ORDER = ["linked", "depends-on", "used-by", "same-source", "excerpt-of", "session-source", "session-project"]

/**
 * The contextual inspector: what the selected node is, everything Hubble
 * actually knows about it, how it connects — each relationship a way to
 * travel on — and what can be done with it. Every action goes to the real
 * thing: a conversation's reader, a file's preview, the project, Chrome.
 *
 * A node backed by a saved tab also carries what the person has given that
 * tab — its section, collection, favourite, note — and the relationships
 * they made between tabs, each of which they can change or undo here.
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
  graphTab,
  tabActions,
  onSaveNote,
  editingNote = false,
  onEditNote,
  onRemoveRelation,
  onDependencyType,
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
  /** The saved tab behind the node, when there is one and it can be changed from here. */
  graphTab?: GraphTab
  tabActions?: GraphTabActions
  onSaveNote?: (text: string) => void
  /** Whether the note is open for editing — held by the graph, so a right-click menu's "Add note" can open it too. */
  editingNote?: boolean
  onEditNote?: (editing: boolean) => void
  /** Unmakes a relationship the person made: a link or a dependency. */
  onRemoveRelation?: (edge: KnowledgeEdge) => void
  onDependencyType?: (edge: KnowledgeEdge, type: DependencyType | undefined) => void
  className?: string
}) {
  const relations = useMemo(() => {
    const groups = new Map<string, RelationGroup>()
    for (const edge of edges) {
      const other = byId.get(edge.source === node.id ? edge.target : edge.source)
      if (!other) continue
      // A project's own items are listed by kind below, not as "In project".
      if (node.kind === "project" && (edge.kind === "contains" || edge.kind === "session-project")) continue
      if (node.kind !== "project" && edge.kind === "contains") continue
      const key = edge.kind === "depends-on" && edge.target === node.id ? "used-by" : edge.kind
      const title = key === "used-by" ? "Used by" : EDGE_LABEL[edge.kind]
      const group = groups.get(key) ?? { key, title, entries: [] }
      group.entries.push({ node: other, edge })
      groups.set(key, group)
    }
    return [...groups.values()].sort((a, b) => GROUP_ORDER.indexOf(a.key) - GROUP_ORDER.indexOf(b.key))
  }, [edges, byId, node])

  const projectItems = useMemo(() => {
    if (node.kind !== "project") return []
    const kinds = new Map<string, KnowledgeNode[]>()
    for (const edge of edges) {
      if (edge.kind !== "contains" && edge.kind !== "session-project") continue
      const other = byId.get(edge.target)
      if (!other) continue
      const key = other.savedTab ? "tab" : other.kind
      kinds.set(key, [...(kinds.get(key) ?? []), other])
    }
    return [...kinds.entries()].map(([kind, list]) => [kind, list.sort((a, b) => b.at - a.at)] as const)
  }, [edges, byId, node])

  const owner = node.projectId ? projectName(node.projectId) : undefined
  const item = node.item
  const typeLabel = nodeTypeLabel(node)
  const facts = nodeFacts(node, now)
  const tab = graphTab?.tab
  // A saved tab Hubble holds no text for opens as the page itself.
  const openLabel = node.savedTab ? "Open page" : OPEN_LABEL[node.kind]

  return (
    <aside aria-label={`${typeLabel}: ${node.label}`} className={cn("surface-panel flex min-h-0 flex-col overflow-hidden", className)} data-graph-inspector={node.kind}>
      <div className="flex items-center gap-1 border-b border-subtle px-2 py-1.5">
        {canGoBack ? (
          <IconButton aria-label="Back to previous selection" tooltip="Back" shortcut="Backspace" onClick={onBack}>
            <ArrowLeft />
          </IconButton>
        ) : null}
        <span className="min-w-0 flex-1 truncate px-1 text-eyebrow text-tertiary">{typeLabel}</span>
        {graphTab && tabActions && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton aria-label="More actions" tooltip="More">
                  <MoreHorizontal />
                </IconButton>
              }
            />
            <DropdownMenuContent align="end" className="w-56">
              <TabMenuItems graphTab={graphTab} actions={tabActions} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <IconButton aria-label="Close details" tooltip="Close" shortcut="Esc" onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex items-start gap-3 px-4 pt-4">
          <NodeIcon node={node} tile />
          <div className="min-w-0 flex-1">
            <h2 className="text-h1 break-words text-foreground">{node.label}</h2>
            <p className="mt-0.5 text-meta text-tertiary">{facts.join(" · ")}</p>
          </div>
          {tab && tabActions && (
            <IconButton
              aria-label={tab.isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={tab.isFavorite === true}
              tooltip={tab.isFavorite ? "Favorite" : "Add to favorites"}
              className={cn("-mt-1 -mr-2", tab.isFavorite && "text-favorite-accent")}
              onClick={tabActions.toggleFavorite}
            >
              <Star fill={tab.isFavorite ? "currentColor" : "none"} fillOpacity={tab.isFavorite ? 0.2 : 1} />
            </IconButton>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 px-4 pt-4">
          <Button type="button" size="lg" onClick={() => onOpen(node)} disabled={node.kind === "session" && (restorePending || !session)}>
            {node.kind === "project" ? <FolderOpen /> : node.kind === "session" ? <Play /> : node.savedTab ? <ExternalLink /> : <ArrowUpRight />}
            {node.kind === "session" ? (restorePending ? "Opening…" : session ? `Restore ${session.tabs.length} ${session.tabs.length === 1 ? "tab" : "tabs"}` : OPEN_LABEL.session) : openLabel}
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
          {graphTab?.section && <Row label="Section">{graphTab.section}</Row>}
          {graphTab?.collection && <Row label="Collection">{graphTab.collection.name}</Row>}
          {node.provider && (
            <Row label="From">
              <ProviderBadge provider={node.provider} />
            </Row>
          )}
          {item?.url && (
            <Row label="Address">
              <button type="button" className="flex min-w-0 items-center gap-1 text-left text-link hover:underline" onClick={() => (tabActions ? tabActions.openPage(false) : onOpenUrl(item.url!))}>
                <span className="truncate">{item.domain ?? item.url}</span>
                <ExternalLink aria-hidden className="size-3 shrink-0" />
              </button>
            </Row>
          )}
          {item?.fileName && <Row label="File">{item.fileName}</Row>}
          {item && item.addedAt > 0 && (
            <Row label={node.savedTab ? "Saved" : "Added"}>
              <time dateTime={new Date(item.addedAt).toISOString()} title={formatFullTimestamp(item.addedAt)}>
                {formatRelativeTime(item.addedAt, now)}
              </time>
            </Row>
          )}
          {tab?.lastAccessedAt && <Row label="Last opened">{formatRelativeTime(tab.lastAccessedAt, now)}</Row>}
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

        {tab && onSaveNote && onEditNote && (
          <TabNote
            note={tab.notes ?? ""}
            editing={editingNote}
            onEdit={() => onEditNote(true)}
            onDone={(text) => {
              onEditNote(false)
              if (text !== undefined) onSaveNote(text)
            }}
          />
        )}

        {session && (
          <Section title={`Tabs · ${session.tabs.length}`}>
            <ul className="flex flex-col">
              {session.tabs.slice(0, 8).map((sessionTab) => (
                <li key={sessionTab.id}>
                  <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-xs px-2 py-1 text-left text-body-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground" onClick={() => onOpenUrl(sessionTab.url)}>
                    <span className="min-w-0 flex-1 truncate">{tabLabel(sessionTab)}</span>
                    <ExternalLink aria-hidden className="size-3 shrink-0 opacity-60" />
                  </button>
                </li>
              ))}
            </ul>
            {session.tabs.length > 8 && <p className="px-2 pt-1 text-meta text-tertiary">and {session.tabs.length - 8} more</p>}
          </Section>
        )}

        {projectItems.map(([kind, list]) => (
          <Section key={kind} title={`${PROJECT_GROUP_LABEL[kind] ?? kind} · ${list.length}`}>
            <NodeList entries={list.slice(0, PER_KIND).map((other) => ({ node: other }))} now={now} onSelect={onSelect} />
            {list.length > PER_KIND && <p className="px-2 pt-1 text-meta text-tertiary">and {list.length - PER_KIND} more</p>}
          </Section>
        ))}

        {relations.map((group) => (
          <Section key={group.key} title={group.title}>
            <NodeList
              entries={group.entries}
              now={now}
              onSelect={onSelect}
              projectName={projectName}
              {...(onRemoveRelation ? { onRemoveRelation } : {})}
              {...(onDependencyType ? { onDependencyType } : {})}
            />
          </Section>
        ))}

        {node.kind !== "project" && relations.length === 0 && (
          <p className="mx-4 mt-4 border-t border-subtle pt-3 text-meta text-tertiary">
            {graphTab && tabActions ? "No other connections yet. Link it to another tab from More, or save the same page in another project." : "No other connections yet. It connects when the same source, an excerpt of it or a session shows up elsewhere."}
          </p>
        )}
        <div className="h-4" />
      </div>
    </aside>
  )
}

const PROJECT_GROUP_LABEL: Record<string, string> = {
  conversation: "Conversations",
  source: "Sources",
  tab: "Saved tabs",
  file: "Files",
  note: "Notes",
  session: "Sessions",
}

/** The person's own note on a saved tab: read in place, edited in place. Enter on its own line, ⌘/Ctrl+Enter saves. */
function TabNote({ note, editing, onEdit, onDone }: { note: string; editing: boolean; onEdit: () => void; onDone: (text: string | undefined) => void }) {
  const [draft, setDraft] = useState(note)
  const [opened, setOpened] = useState(editing)
  if (editing !== opened) {
    setOpened(editing)
    if (editing) setDraft(note)
  }
  if (editing) {
    return (
      <Section title="Note">
        <div className="flex flex-col gap-2 px-2">
          <Textarea
            autoFocus
            aria-label="Note"
            value={draft}
            rows={4}
            placeholder="Why you kept it, what to do with it…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onDone(draft)
              else if (event.key === "Escape") {
                event.stopPropagation()
                onDone(undefined)
              }
            }}
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => onDone(undefined)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => onDone(draft)}>
              Save note
            </Button>
          </div>
        </div>
      </Section>
    )
  }
  if (!note) {
    return (
      <div className="mx-4 mt-3">
        <Button type="button" size="sm" variant="ghost" className="-ml-2" onClick={onEdit}>
          Add a note
        </Button>
      </div>
    )
  }
  return (
    <Section title="Note">
      <button type="button" onClick={onEdit} aria-label="Edit note" className="block w-full rounded-xs px-2 py-1 text-left text-body-sm whitespace-pre-wrap text-foreground outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60">
        {note}
      </button>
    </Section>
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

function NodeList({
  entries,
  now,
  onSelect,
  projectName,
  onRemoveRelation,
  onDependencyType,
}: {
  entries: readonly { node: KnowledgeNode; edge?: KnowledgeEdge }[]
  now: number
  onSelect: (id: string) => void
  projectName?: (id: string) => string | undefined
  onRemoveRelation?: (edge: KnowledgeEdge) => void
  onDependencyType?: (edge: KnowledgeEdge, type: DependencyType | undefined) => void
}) {
  return (
    <ul className="flex flex-col">
      {entries.map(({ node: other, edge }) => {
        const personal = edge && PERSONAL_EDGE_KINDS.has(edge.kind) && onRemoveRelation
        const dependencyType = edge?.dependency?.type
        return (
          <li key={edge?.id ?? other.id} className="group flex items-center gap-0.5">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-xs px-2 py-1.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => onSelect(other.id)}
            >
              <NodeIcon node={other} />
              <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{other.label}</span>
              <span className="shrink-0 text-meta text-tertiary">{dependencyType ? DEPENDENCY_TYPES[dependencyType].name : projectName && other.projectId ? projectName(other.projectId) : formatRelativeTime(other.at, now)}</span>
            </button>
            {personal && edge.kind === "linked" && (
              <IconButton aria-label={`Remove link to ${other.label}`} tooltip="Remove link" className="size-7 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100" onClick={() => onRemoveRelation(edge)}>
                <X />
              </IconButton>
            )}
            {personal && edge.kind === "depends-on" && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <IconButton aria-label={`Dependency on ${other.label}`} tooltip="Dependency" className="size-7 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 max-md:opacity-100">
                      <MoreHorizontal />
                    </IconButton>
                  }
                />
                <DropdownMenuContent align="end" className="w-52">
                  {onDependencyType && (
                    <>
                      <DropdownMenuLabel>Kind of dependency</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={dependencyType ?? "none"} onValueChange={(value) => onDependencyType(edge, value === "none" ? undefined : (value as DependencyType))}>
                        <DropdownMenuRadioItem value="none">No kind</DropdownMenuRadioItem>
                        {DEPENDENCY_TYPE_ORDER.map((type) => (
                          <DropdownMenuRadioItem key={type} value={type}>
                            {DEPENDENCY_TYPES[type].name}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem variant="destructive" onClick={() => onRemoveRelation(edge)}>
                    Remove dependency
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        )
      })}
    </ul>
  )
}
