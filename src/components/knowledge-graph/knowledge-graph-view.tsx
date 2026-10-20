"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { ChevronDown, ListTree, Maximize2, Minus, Network, PanelLeftOpen, Plus, Search, Waypoints, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { KindGlyph, KIND_BG_CLASS } from "@/components/ui/kind-glyph"
import { Kbd } from "@/components/ui/kbd"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { LaunchConfirmDialog, useSessionLaunch } from "@/components/sessions/use-session-launch"
import { useTabSessions } from "@/hooks/use-tab-sessions"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { adjacency, buildKnowledgeGraph } from "@/lib/knowledge-graph/build"
import { createKnowledgeLayout } from "@/lib/knowledge-graph/layout"
import { loadKnowledgeGraphState, saveKnowledgeGraphState } from "@/lib/knowledge-graph/persistence"
import { nodeInDirection, searchNodes } from "@/lib/knowledge-graph/view"
import { subjectName } from "@/lib/product/subjects"
import { cn } from "@/lib/utils"
import type { Camera, Direction, Insets } from "@/lib/knowledge-graph/view"
import type { GraphNodeKind, KnowledgeNode, Point } from "@/lib/knowledge-graph/types"
import type { KnowledgeItemRef } from "@/lib/memory/items"
import type { Workspace } from "@/lib/workspace/types"
import { KnowledgeGraphCanvas } from "./knowledge-graph-canvas"
import type { GraphCanvasHandle } from "./knowledge-graph-canvas"
import { GraphInspector } from "./graph-inspector"
import { GraphHoverCard } from "./graph-hover-card"
import { GraphList } from "./graph-list"
import { announceNode, NODE_KIND_LABEL } from "./describe"

type FilterKind = Exclude<GraphNodeKind, "project">
const FILTER_KINDS: readonly FilterKind[] = ["conversation", "source", "file", "note", "session"]
const FILTER_LABEL: Record<FilterKind, string> = { conversation: "Conversations", source: "Sources", file: "Files", note: "Notes", session: "Sessions" }
const ALL_KINDS: Record<FilterKind, boolean> = { conversation: true, source: true, file: true, note: true, session: true }
const INSPECTOR_W = 344
/** How many neighbours a selection frames; a hub with hundreds frames its nearest. */
const FRAME_LIMIT = 40

export type KnowledgeGraphViewProps = {
  workspaces: readonly Workspace[]
  now: number
  /** Sessions are part of the graph where they exist (not in Hubble Desktop). */
  showSessions: boolean
  onOpenItem: (workspaceId: string, ref: KnowledgeItemRef) => void
  onOpenProject: (workspaceId: string) => void
  onUseInAi?: (workspaceId: string, refs: KnowledgeItemRef[]) => void
  onOpenUrl: (url: string) => void
  onOpenSessions?: () => void
  onNewProject?: () => void
  /** The older map of saved tabs. Absent: not offered. */
  onOpenTabMap?: () => void
  tabMapLocked?: boolean
  tabMapLockedReason?: string
  onOpenSidebar?: () => void
  /** A node to select on arrival ("Show in graph"). A new nonce selects it again. */
  focus?: { nodeId: string; nonce: number }
}

/**
 * The Graph: everything the person keeps, as one connected space.
 *
 * Projects hold neighbourhoods; conversations, sources, files, notes and
 * browser sessions sit in them and connect across them wherever the records
 * prove a relationship. Selecting anything brings it and its relationships
 * forward, quiets the rest, travels the camera there and opens an inspector
 * with what Hubble knows and what can be done; opening it goes to the real
 * thing. Search, filters, zoom, a keyboard path through every node and a
 * list view of the same data make it usable without the canvas at all.
 */
export function KnowledgeGraphView(props: KnowledgeGraphViewProps) {
  const { workspaces, now } = props
  const { sessions: allSessions } = useTabSessions()
  const sessions = useMemo(() => (props.showSessions ? allSessions : []), [props.showSessions, allSessions])
  const launcher = useSessionLaunch()
  const reducedMotion = useReducedMotion()

  const graph = useMemo(() => buildKnowledgeGraph({ workspaces, sessions }), [workspaces, sessions])
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph])
  const neighbours = useMemo(() => adjacency(graph), [graph])
  const edgesOf = useMemo(() => {
    const map = new Map<string, typeof graph.edges>()
    for (const edge of graph.edges) {
      map.set(edge.source, [...(map.get(edge.source) ?? []), edge])
      map.set(edge.target, [...(map.get(edge.target) ?? []), edge])
    }
    return map
  }, [graph])
  const names = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, subjectName(workspace)])), [workspaces])
  const projectName = (id: string) => names.get(id)
  // Layout depends on structure only: a renamed conversation does not move anything.
  const structure = useMemo(() => `${graph.nodes.map((node) => node.id).join("\n")}#${graph.edges.map((edge) => edge.id).join("\n")}`, [graph])

  // ---- layout ----
  const saved = useMemo(() => (typeof window === "undefined" ? { version: 1 as const, positions: {} } : loadKnowledgeGraphState()), [])
  const [positions, setPositions] = useState<Record<string, Point> | null>(null)
  const [arranging, setArranging] = useState(0)
  const positionsRef = useRef<Record<string, Point>>(saved.positions)
  const cameraRef = useRef<Camera | undefined>(saved.camera)
  const graphRef = useRef(graph)
  useEffect(() => {
    graphRef.current = graph
  }, [graph])
  useEffect(() => {
    const current = graphRef.current
    const layout = createKnowledgeLayout(current, positionsRef.current)
    let cancelled = false
    let ticks = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = () => {
      if (cancelled) return
      const done = layout.step(60)
      ticks += 60
      if (!done) {
        setArranging(Math.min(0.99, ticks / layout.totalTicks))
        timer = setTimeout(run, 0)
        return
      }
      const next = layout.positions()
      positionsRef.current = { ...positionsRef.current, ...next }
      setPositions(next)
      setArranging(0)
      saveKnowledgeGraphState({ version: 1, positions: next, ...(cameraRef.current ? { camera: cameraRef.current } : {}) }, new Set(current.nodes.map((node) => node.id)))
    }
    timer = setTimeout(run, 0)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [structure])

  // ---- view state ----
  const [mode, setMode] = useState<"graph" | "list">("graph")
  const [kinds, setKinds] = useState<Record<FilterKind, boolean>>(ALL_KINDS)
  const [projectFilter, setProjectFilter] = useState<string>("all")
  const [query, setQuery] = useState("")
  const [resultIndex, setResultIndex] = useState(0)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [history, setHistory] = useState<string[]>([])
  const [hover, setHover] = useState<{ id: string; point: Point } | null>(null)
  const [focused, setFocused] = useState<string | undefined>(undefined)
  const [announcement, setAnnouncement] = useState("")
  const [focusRequest, setFocusRequest] = useState<{ ids: string[]; nonce: number } | null>(null)
  const [zoom, setZoom] = useState(saved.camera?.k ?? 1)
  const [leaving, setLeaving] = useState(false)
  const [size, setSize] = useState({ width: 1200, height: 800 })
  const canvas = useRef<GraphCanvasHandle>(null)
  const surface = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const element = surface.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const wide = size.width >= 768

  // A selection that no longer exists (deleted elsewhere) quietly clears.
  const selectedNode = selected ? byId.get(selected) : undefined

  // ---- what is shown ----
  const visible = useMemo(() => {
    const keep = new Set<string>()
    for (const node of graph.nodes) {
      if (node.kind !== "project" && !kinds[node.kind]) continue
      if (projectFilter === "all") keep.add(node.id)
      else if (node.id === `p:${projectFilter}` || node.projectId === projectFilter) keep.add(node.id)
    }
    // With one project chosen, what connects to it from elsewhere stays in view.
    if (projectFilter !== "all") {
      for (const id of [...keep]) {
        for (const other of neighbours.get(id) ?? []) {
          const node = byId.get(other)
          if (node && (node.kind === "project" || kinds[node.kind])) keep.add(other)
        }
      }
    }
    const nodes = graph.nodes.filter((node) => keep.has(node.id))
    const edges = graph.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target))
    return { nodes, edges, ids: keep }
  }, [graph, kinds, projectFilter, neighbours, byId])

  const counts = useMemo(() => {
    const out: Record<FilterKind, number> = { conversation: 0, source: 0, file: 0, note: 0, session: 0 }
    for (const node of graph.nodes) if (node.kind !== "project" && (projectFilter === "all" || node.projectId === projectFilter)) out[node.kind] += 1
    return out
  }, [graph, projectFilter])

  const results = useMemo(() => searchNodes(visible.nodes, query, (id) => names.get(id)), [visible.nodes, query, names])
  const matches = useMemo(() => new Set(results.map((node) => node.id)), [results])

  const highlighted = useMemo(() => new Set(selected ? (edgesOf.get(selected) ?? []).map((edge) => edge.id) : []), [selected, edgesOf])
  const emphasised = useMemo<ReadonlySet<string> | null>(() => {
    if (selected) return new Set([selected, ...(neighbours.get(selected) ?? [])])
    if (query.trim() && matches.size > 0) return matches
    if (hover) return new Set([hover.id, ...(neighbours.get(hover.id) ?? [])])
    return null
  }, [selected, neighbours, query, matches, hover])

  const projectItems = useMemo(() => {
    const map = new Map<string, number>()
    for (const node of graph.nodes) if (node.kind === "project") map.set(node.id, node.size ?? 0)
    return map
  }, [graph])

  const insets: Insets = selectedNode ? (wide ? { right: INSPECTOR_W + 24, top: 56 } : { bottom: Math.round(size.height * 0.55), top: 96 }) : { top: wide ? 56 : 96, bottom: 56 }

  // ---- camera ----
  const didFit = useRef(false)
  useEffect(() => {
    if (!positions || didFit.current) return
    didFit.current = true
    if (!saved.camera) canvas.current?.fit(undefined, { animate: false })
  }, [positions, saved.camera])

  useEffect(() => {
    if (!focusRequest || !positions) return
    canvas.current?.fit(focusRequest.ids)
  }, [focusRequest, positions])

  function frameIdsFor(id: string): string[] {
    const near = [...(neighbours.get(id) ?? [])].filter((other) => visible.ids.has(other))
    const node = byId.get(id)
    // A project frames its own neighbourhood; anything else frames itself and what it connects to.
    if (node?.kind === "project") return [id, ...near.filter((other) => byId.get(other)?.projectId === id.slice(2))].slice(0, FRAME_LIMIT)
    return [id, ...near].slice(0, FRAME_LIMIT)
  }

  function select(id: string | undefined, options: { fromHistory?: boolean; frame?: boolean } = {}) {
    if (id === selected) {
      if (id && options.frame !== false) setFocusRequest({ ids: frameIdsFor(id), nonce: Date.now() })
      return
    }
    if (!options.fromHistory && selected && id) setHistory((list) => [...list.slice(-30), selected])
    if (!id) setHistory([])
    setSelected(id)
    if (id) {
      setFocused(id)
      const node = byId.get(id)
      if (node) setAnnouncement(`Selected ${announceNode(node, node.projectId ? names.get(node.projectId) : undefined, neighbours.get(id)?.size ?? 0, now)}`)
      if (options.frame !== false) setFocusRequest({ ids: frameIdsFor(id), nonce: Date.now() })
    }
  }

  function back() {
    const previous = history[history.length - 1]
    if (!previous) return
    setHistory((list) => list.slice(0, -1))
    select(byId.has(previous) ? previous : undefined, { fromHistory: true })
  }

  // "Show in graph" from elsewhere: select it once the layout has placed it.
  const [seenFocus, setSeenFocus] = useState<number | undefined>(undefined)
  if (props.focus && positions && props.focus.nonce !== seenFocus && byId.has(props.focus.nodeId)) {
    setSeenFocus(props.focus.nonce)
    setSelected(props.focus.nodeId)
    setFocused(props.focus.nodeId)
    setFocusRequest({ ids: frameIdsFor(props.focus.nodeId), nonce: props.focus.nonce })
  }

  function open(node: KnowledgeNode) {
    if (node.kind === "session") {
      const session = sessions.find((entry) => entry.id === node.sessionId)
      if (session) void launcher.launch({ tabs: session.tabs.map((tab) => ({ url: tab.url, ...(tab.pinned ? { pinned: true } : {}) })), sessionIds: [session.id] })
      return
    }
    const go = () => {
      if (node.kind === "project") props.onOpenProject(node.id.slice(2))
      else if (node.projectId && node.item) props.onOpenItem(node.projectId, node.item.ref)
    }
    if (mode === "list" || reducedMotion) return go()
    // Into the thing: the camera travels toward it as the graph fades, then the resource opens.
    setLeaving(true)
    canvas.current?.diveInto(node.id, go)
  }

  function useInAi(node: KnowledgeNode) {
    if (!props.onUseInAi) return
    if (node.kind === "project") props.onUseInAi(node.id.slice(2), [])
    else if (node.projectId && node.item) props.onUseInAi(node.projectId, [node.item.ref])
  }

  function moveFocus(direction: Direction) {
    const from = focused && visible.ids.has(focused) ? focused : selected
    const ids = visible.nodes.map((node) => node.id)
    let next: string | undefined
    if (!from || !positions?.[from]) next = visible.nodes.filter((node) => node.kind === "project").sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]?.id ?? ids[0]
    else next = nodeInDirection(from, direction, positions, ids)
    if (!next) return
    setFocused(next)
    const node = byId.get(next)
    if (node) setAnnouncement(announceNode(node, node.projectId ? names.get(node.projectId) : undefined, neighbours.get(next)?.size ?? 0, now))
    const at = canvas.current?.screenOf(next)
    if (at) setHover({ id: next, point: at })
    // Keep the keyboard's place in view.
    if (at && (at.x < 40 || at.y < 80 || at.x > size.width - (selectedNode && wide ? INSPECTOR_W + 40 : 40) || at.y > size.height - 40)) setFocusRequest({ ids: [next], nonce: Date.now() })
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    // The list is navigated like any list: Tab between its rows.
    if (mode === "list" && event.key !== "/" && event.key !== "Escape") return
    const arrows: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }
    if (arrows[event.key] && !(event.altKey && event.key === "ArrowLeft")) {
      event.preventDefault()
      moveFocus(arrows[event.key]!)
    } else if (event.key === "Enter" && focused) {
      event.preventDefault()
      const node = byId.get(focused)
      if (node) open(node)
    } else if (event.key === " " && focused) {
      event.preventDefault()
      select(focused)
    } else if (event.key === "Escape") {
      if (selected) select(undefined)
      else setFocused(undefined)
      setHover(null)
    } else if (event.key === "Backspace" || (event.altKey && event.key === "ArrowLeft")) {
      event.preventDefault()
      back()
    } else if (event.key === "+" || event.key === "=") canvas.current?.zoomBy(1.35)
    else if (event.key === "-") canvas.current?.zoomBy(1 / 1.35)
    else if (event.key === "0") canvas.current?.fit()
    else if (event.key === "/") {
      event.preventDefault()
      searchInput.current?.focus()
    }
  }

  // "/" from anywhere on the page goes to the graph's search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== "/" || event.metaKey || event.ctrlKey || target?.closest("input, textarea, [contenteditable=true]")) return
      event.preventDefault()
      searchInput.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  function onSearchKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setResultIndex((index) => Math.min(results.length - 1, index + 1))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setResultIndex((index) => Math.max(0, index - 1))
    } else if (event.key === "Enter") {
      const node = results[resultIndex]
      if (node) {
        event.preventDefault()
        select(node.id)
        setResultsOpen(false)
      }
    } else if (event.key === "Escape") {
      if (query) setQuery("")
      else surface.current?.focus()
    }
  }

  const session = selectedNode?.kind === "session" ? sessions.find((entry) => entry.id === selectedNode.sessionId) : undefined
  const hoverNode = hover && mode === "graph" ? byId.get(hover.id) : undefined
  const isEmpty = graph.nodes.length === 0
  const filteredOut = !isEmpty && visible.nodes.length === 0
  const kindsOff = FILTER_KINDS.some((kind) => !kinds[kind])
  const edgeCount = visible.edges.filter((edge) => edge.kind !== "contains").length

  if (isEmpty) {
    return (
      <div className="relative flex min-h-screen flex-col" data-knowledge-graph data-empty>
        {props.onOpenSidebar && (
          <div className="absolute top-2 left-2 md:hidden">
            <IconButton aria-label="Open sidebar" onClick={props.onOpenSidebar}>
              <PanelLeftOpen />
            </IconButton>
          </div>
        )}
        <div className="m-auto flex max-w-sm flex-col items-center gap-4 px-6 text-center animate-enter">
          <EmptyOrbit />
          <div>
            <h1 className="text-title text-foreground">Your work, connected</h1>
            <p className="mt-2 text-body text-muted-foreground">Projects, AI conversations, files and sessions appear here as you save them, linked wherever they share a source.</p>
          </div>
          {props.onNewProject && (
            <Button type="button" size="lg" onClick={props.onNewProject}>
              <Plus /> New project
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-screen min-h-[480px] overflow-hidden bg-background" data-knowledge-graph>
      <div
        ref={surface}
        tabIndex={0}
        role="application"
        aria-roledescription="knowledge graph"
        aria-label={`Knowledge graph: ${visible.nodes.length} items. Arrow keys move between items, Space shows details, Enter opens, slash searches.`}
        onKeyDown={onKeyDown}
        className={cn(
          "absolute inset-0 outline-none transition-opacity duration-(--duration-slow) ease-(--ease-standard) focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
          leaving && "opacity-0"
        )}
      >
        {/* The canvas stays mounted under the list, so its camera survives a trip to the list and back. */}
        {positions && (
          <KnowledgeGraphCanvas
            ref={canvas}
            nodes={visible.nodes}
            edges={visible.edges}
            positions={positions}
            projectItems={projectItems}
            {...(selected ? { selected } : {})}
            {...(selectedNode ? { selectedProject: selectedNode.kind === "project" ? selectedNode.id : selectedNode.projectId ? `p:${selectedNode.projectId}` : undefined } : {})}
            {...(hover ? { hovered: hover.id } : {})}
            {...(focused ? { focused } : {})}
            matches={matches}
            highlighted={highlighted}
            emphasised={emphasised}
            {...(saved.camera ? { initialCamera: saved.camera } : {})}
            insets={insets}
            reducedMotion={reducedMotion}
            onHover={(id, point) => setHover(id && point ? { id, point } : null)}
            onSelect={(id) => {
              surface.current?.focus({ preventScroll: true })
              select(id)
            }}
            onOpen={(id) => {
              const node = byId.get(id)
              if (node) open(node)
            }}
            onCameraChange={(camera) => {
              cameraRef.current = camera
              setZoom(camera.k)
              saveKnowledgeGraphState({ version: 1, positions: positionsRef.current, camera }, new Set(graphRef.current.nodes.map((node) => node.id)))
            }}
          />
        )}
        {mode === "graph" && !positions && <Arranging progress={arranging} />}
        {mode === "list" && (
          <div className="absolute inset-0 z-[1] overflow-y-auto bg-background animate-fade">
            <GraphList
              nodes={query.trim() ? visible.nodes.filter((node) => matches.has(node.id) || node.kind === "project") : visible.nodes}
              degree={(id) => [...(neighbours.get(id) ?? [])].filter((other) => visible.ids.has(other)).length}
              projectName={projectName}
              now={now}
              {...(selected ? { selected } : {})}
              onSelect={(id) => select(id, { frame: false })}
              onOpen={open}
            />
          </div>
        )}
      </div>

      {hoverNode && hover && !leaving && (
        <GraphHoverCard node={hoverNode} point={hover.point} bounds={size} {...(hoverNode.projectId ? { projectName: names.get(hoverNode.projectId) } : {})} now={now} selected={selected === hoverNode.id} />
      )}

      {/* ---- toolbar ---- */}
      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2">
        {props.onOpenSidebar && (
          <div className="pointer-events-auto surface-panel p-0.5 md:hidden">
            <IconButton aria-label="Open sidebar" onClick={props.onOpenSidebar}>
              <PanelLeftOpen />
            </IconButton>
          </div>
        )}
        <div className="pointer-events-auto relative w-full max-w-72 min-w-0 flex-1 sm:flex-none">
          <div className="surface-panel flex h-9 items-center gap-2 px-2.5">
            <Search aria-hidden className="size-3.5 shrink-0 text-tertiary" />
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setResultIndex(0)
                setResultsOpen(true)
              }}
              onKeyDown={onSearchKey}
              placeholder="Find in graph"
              aria-label="Find in graph"
              role="combobox"
              aria-expanded={query.trim().length > 0 && resultsOpen}
              onFocus={() => setResultsOpen(true)}
              aria-controls="graph-results"
              aria-activedescendant={results[resultIndex] ? `graph-result-${resultIndex}` : undefined}
              className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-tertiary"
            />
            {query ? (
              <IconButton aria-label="Clear search" className="-mr-1 size-6" onClick={() => setQuery("")}>
                <X />
              </IconButton>
            ) : (
              <Kbd className="max-sm:hidden">/</Kbd>
            )}
          </div>
          {query.trim() && resultsOpen && (
            <ul id="graph-results" role="listbox" aria-label="Matches" className="surface-panel mt-1.5 max-h-80 overflow-y-auto p-1 animate-fade">
              {results.length === 0 ? (
                <li className="px-2 py-2 text-body-sm text-muted-foreground">Nothing in view matches.</li>
              ) : (
                results.slice(0, 12).map((node, index) => (
                  <li key={node.id} id={`graph-result-${index}`} role="option" aria-selected={index === resultIndex}>
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseEnter={() => setResultIndex(index)}
                      onClick={() => {
                        select(node.id)
                        setResultsOpen(false)
                      }}
                      className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left", index === resultIndex && "bg-surface-hover")}
                    >
                      {node.kind === "project" ? <WorkspaceAvatar workspace={{ name: node.label }} size={16} /> : <KindGlyph kind={node.kind} {...(node.type ? { type: node.type } : {})} />}
                      <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{node.label}</span>
                      <span className="shrink-0 text-meta text-tertiary">{node.kind === "project" ? "Project" : node.projectId ? names.get(node.projectId) : NODE_KIND_LABEL[node.kind]}</span>
                    </button>
                  </li>
                ))
              )}
              {results.length > 0 && <li className="px-2 pt-1 pb-0.5 text-meta text-tertiary">↑↓ to move · Enter to focus</li>}
            </ul>
          )}
        </div>

        <div role="group" aria-label="Show" className="pointer-events-auto surface-panel flex h-9 max-w-full items-center gap-0.5 overflow-x-auto px-1">
          {FILTER_KINDS.filter((kind) => kind !== "session" || props.showSessions).map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={kinds[kind]}
              onClick={() => setKinds((current) => ({ ...current, [kind]: !current[kind] }))}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-body-sm transition-[background-color,color,opacity] duration-(--duration-fast) ease-(--ease-color) outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                kinds[kind] ? "text-foreground hover:bg-surface-hover" : "text-tertiary opacity-70 hover:opacity-100"
              )}
            >
              <span aria-hidden className={cn("size-2 rounded-full transition-opacity", KIND_BG_CLASS[kind], !kinds[kind] && "opacity-30")} />
              {FILTER_LABEL[kind]}
              <span className="text-meta text-tertiary tabular-nums">{counts[kind]}</span>
            </button>
          ))}
        </div>

        <div className="pointer-events-auto ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="secondary" size="lg" className="surface-panel h-9 max-w-48 border-border" aria-label="Choose project">
                  <span className="truncate">{projectFilter === "all" ? "All projects" : (names.get(projectFilter) ?? "Project")}</span>
                  <ChevronDown className="opacity-60" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="max-h-80 min-w-52">
              <DropdownMenuRadioGroup value={projectFilter} onValueChange={(value) => setProjectFilter(String(value))}>
                <DropdownMenuRadioItem value="all">All projects</DropdownMenuRadioItem>
                {workspaces.map((workspace) => (
                  <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
                    {names.get(workspace.id)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div role="group" aria-label="View as" className="surface-panel flex h-9 items-center gap-0.5 px-1">
            <IconButton
              aria-label="Graph"
              tooltip="Graph"
              aria-pressed={mode === "graph"}
              className={cn(mode === "graph" && "bg-surface-selected text-foreground")}
              onClick={() => {
                setMode("graph")
                // Back from the list with something chosen there: travel to it.
                if (selected && mode !== "graph") setFocusRequest({ ids: frameIdsFor(selected), nonce: Date.now() })
              }}
            >
              <Network />
            </IconButton>
            <IconButton aria-label="List" tooltip="List" aria-pressed={mode === "list"} className={cn(mode === "list" && "bg-surface-selected text-foreground")} onClick={() => setMode("list")}>
              <ListTree />
            </IconButton>
          </div>
          {props.onOpenTabMap && (
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="surface-panel h-9 border-border max-sm:hidden"
              onClick={props.onOpenTabMap}
              disabled={props.tabMapLocked}
              title={props.tabMapLocked ? props.tabMapLockedReason : "Your saved tabs, mapped by site and section"}
            >
              <Waypoints /> Tab map
            </Button>
          )}
        </div>
      </div>

      {/* ---- zoom ---- */}
      {mode === "graph" && positions && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
          <div className="surface-panel flex h-9 items-center gap-0.5 px-1">
            <IconButton aria-label="Zoom out" tooltip="Zoom out" shortcut="−" onClick={() => canvas.current?.zoomBy(1 / 1.35)}>
              <Minus />
            </IconButton>
            <span className="w-11 text-center text-meta text-muted-foreground tabular-nums" aria-label={`Zoom ${Math.round(zoom * 100)} percent`}>
              {Math.round(zoom * 100)}%
            </span>
            <IconButton aria-label="Zoom in" tooltip="Zoom in" shortcut="+" onClick={() => canvas.current?.zoomBy(1.35)}>
              <Plus />
            </IconButton>
            <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
            <IconButton aria-label="Fit everything" tooltip="Fit everything" shortcut="0" onClick={() => canvas.current?.fit()}>
              <Maximize2 />
            </IconButton>
          </div>
          <p className="text-meta text-tertiary max-sm:hidden" data-graph-stats>
            {visible.nodes.length} items · {edgeCount} {edgeCount === 1 ? "link" : "links"} across projects
          </p>
        </div>
      )}

      {filteredOut && (
        <div className="absolute inset-0 z-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-body text-muted-foreground">Nothing matches these filters.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setKinds(ALL_KINDS)
                setProjectFilter("all")
              }}
            >
              Show everything
            </Button>
          </div>
        </div>
      )}
      {!filteredOut && kindsOff && mode === "graph" && (
        <button type="button" className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 surface-panel px-3 py-1.5 text-meta text-muted-foreground hover:text-foreground max-sm:hidden" onClick={() => setKinds(ALL_KINDS)}>
          Some kinds are hidden · Show all
        </button>
      )}

      {/* ---- inspector ---- */}
      {selectedNode && (
        <GraphInspector
          key={selectedNode.id}
          node={selectedNode}
          edges={edgesOf.get(selectedNode.id) ?? []}
          byId={byId}
          projectName={projectName}
          now={now}
          {...(session ? { session } : {})}
          restorePending={launcher.pending}
          canGoBack={history.length > 0}
          onBack={back}
          onClose={() => {
            select(undefined)
            surface.current?.focus({ preventScroll: true })
          }}
          onSelect={(id) => select(id)}
          onOpen={open}
          {...(props.onUseInAi ? { onUseInAi: useInAi } : {})}
          onOpenUrl={props.onOpenUrl}
          {...(props.onOpenSessions ? { onOpenSessions: props.onOpenSessions } : {})}
          className={cn(
            "absolute z-20",
            wide ? "top-[60px] right-3 bottom-3 w-[344px] animate-[hb-panel-in_var(--duration-slow)_var(--ease-standard)_both]" : "inset-x-2 bottom-2 max-h-[55%] animate-[hb-sheet-in_var(--duration-slow)_var(--ease-standard)_both]"
          )}
        />
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <LaunchConfirmDialog request={launcher.confirming} onConfirm={() => void launcher.confirm()} onCancel={launcher.cancel} />
    </div>
  )
}

function Arranging({ progress }: { progress: number }) {
  return (
    <div className="absolute inset-0 grid place-items-center" role="status">
      <div className="flex flex-col items-center gap-3">
        <EmptyOrbit spinning />
        <p className="text-meta text-tertiary">Arranging your graph{progress > 0 ? ` · ${Math.round(progress * 100)}%` : "…"}</p>
      </div>
    </div>
  )
}

/** The Hubble orbit, drawn once: the graph's empty and loading states. */
function EmptyOrbit({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 96 96" className={cn("size-20 text-foreground", spinning && "motion-safe:animate-[spin_6s_linear_infinite]")}>
      <circle cx="48" cy="48" r="40" fill="none" stroke="currentColor" strokeOpacity="0.14" strokeDasharray="2 5" />
      <circle cx="48" cy="48" r="24" fill="none" stroke="currentColor" strokeOpacity="0.22" />
      <circle cx="48" cy="48" r="7" fill="var(--card)" stroke="currentColor" strokeOpacity="0.6" />
      <circle cx="72" cy="48" r="3.5" fill="var(--kind-conversation)" />
      <rect x="24" y="22" width="6" height="6" rx="2" fill="var(--kind-source)" />
      <path d="M44 84 l5 -5 l5 5 l-5 5 z" fill="var(--kind-note)" />
      <circle cx="85" cy="30" r="2.5" fill="var(--kind-file)" />
    </svg>
  )
}
