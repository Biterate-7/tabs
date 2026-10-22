"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { toast } from "sonner"
import { ArrowUpRight, ChevronDown, Copy, ListTree, Maximize2, MessageSquareShare, Minus, Network, PanelLeftOpen, Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { KIND_BG_CLASS } from "@/components/ui/kind-glyph"
import { Kbd } from "@/components/ui/kbd"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { LaunchConfirmDialog, useSessionLaunch } from "@/components/sessions/use-session-launch"
import { GraphLinkDialog } from "@/components/graph/graph-link-dialog"
import type { GraphLinkDialogMode } from "@/components/graph/graph-link-dialog"
import { GatherDialog } from "@/components/workspace/gather-dialog"
import { useCollectionStore } from "@/hooks/use-collection-store"
import { useDependencyStore } from "@/hooks/use-dependency-store"
import { useTabLinks } from "@/hooks/use-tab-links"
import { useTabSessions } from "@/hooks/use-tab-sessions"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { useGraphAppearance } from "@/hooks/use-graph-appearance"
import { getCollectionForTab, getCollectionsForWorkspace } from "@/lib/collections/relations"
import { validateAddTabToCollection } from "@/lib/collections/validation"
import { dependenciesOf } from "@/lib/dependencies/relations"
import { validateDependency } from "@/lib/dependencies/validation"
import { buildGraphNodes, buildWorkspaceLookup } from "@/lib/graph/relations"
import { adjacency, buildKnowledgeGraph, itemNodeId } from "@/lib/knowledge-graph/build"
import { createKnowledgeLayout } from "@/lib/knowledge-graph/layout"
import { loadKnowledgeGraphState, saveKnowledgeGraphState } from "@/lib/knowledge-graph/persistence"
import { nodeInDirection, searchNodes } from "@/lib/knowledge-graph/view"
import { subjectName } from "@/lib/product/subjects"
import { copyText } from "@/lib/workspace/export"
import { cn } from "@/lib/utils"
import type { DependencyType } from "@/lib/dependencies/types"
import type { Camera, Direction, Insets } from "@/lib/knowledge-graph/view"
import type { GraphNodeKind, KnowledgeEdge, KnowledgeNode, Point } from "@/lib/knowledge-graph/types"
import type { KnowledgeItemRef } from "@/lib/memory/items"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"
import { KnowledgeGraphCanvas } from "./knowledge-graph-canvas"
import type { GraphCanvasHandle } from "./knowledge-graph-canvas"
import { GraphAppearanceControl } from "./graph-appearance"
import { GraphInspector } from "./graph-inspector"
import { GraphHoverCard } from "./graph-hover-card"
import { GraphList } from "./graph-list"
import { NodeIcon } from "./node-icon"
import { TabMenuItems } from "./tab-actions"
import type { GraphTab, GraphTabActions } from "./tab-actions"
import { announceNode, NODE_KIND_LABEL } from "./describe"

/** What the "Show" chips filter by: each kind of node, with saved tabs apart from the sources Hubble has read. */
type FilterKind = Exclude<GraphNodeKind, "project"> | "tab"
const FILTER_KINDS: readonly FilterKind[] = ["conversation", "source", "tab", "file", "note", "session"]
const FILTER_LABEL: Record<FilterKind, string> = { conversation: "Conversations", source: "Sources", tab: "Saved tabs", file: "Files", note: "Notes", session: "Sessions" }
const ALL_KINDS: Record<FilterKind, boolean> = { conversation: true, source: true, tab: true, file: true, note: true, session: true }
const filterOf = (node: KnowledgeNode): FilterKind | undefined => (node.kind === "project" ? undefined : node.savedTab ? "tab" : node.kind)
const INSPECTOR_W = 344
/** How many neighbours a selection frames; a hub with hundreds frames its nearest. */
const FRAME_LIMIT = 40

/** Changes to saved tabs, made through the shell so they land exactly as the project view's would. */
export type KnowledgeGraphTabActions = {
  open: (workspaceId: string, tabId: string, options?: { newTab?: boolean }) => void
  update: (workspaceId: string, tabId: string, patch: Partial<Pick<Tab, "notes" | "isFavorite">>) => void
  move: (workspaceId: string, tabIds: string[], targetWorkspaceId: string) => void
  remove: (workspaceId: string, tabIds: string[]) => void
}

export type KnowledgeGraphViewProps = {
  workspaces: readonly Workspace[]
  /**
   * Every workspace in the store. The stores of tab relationships
   * (collections, dependencies, links) are kept in step with where every
   * tab lives, so they must see all of them. Defaults to `workspaces`.
   */
  allWorkspaces?: readonly Workspace[]
  now: number
  /** Sessions are part of the graph where they exist (not in Hubble Desktop). */
  showSessions: boolean
  onOpenItem: (workspaceId: string, ref: KnowledgeItemRef) => void
  onOpenProject: (workspaceId: string) => void
  onUseInAi?: (workspaceId: string, refs: KnowledgeItemRef[]) => void
  onOpenUrl: (url: string) => void
  onOpenSessions?: () => void
  onNewProject?: () => void
  /** Absent: saved tabs can be explored, not changed. */
  tabActions?: KnowledgeGraphTabActions
  onOpenSidebar?: () => void
  /** A node to select on arrival ("Show in graph"). A new nonce selects it again. */
  focus?: { nodeId: string; nonce: number }
}

/**
 * The Graph: everything the person keeps, as one connected space.
 *
 * Projects hold neighbourhoods; conversations, sources, files, notes, every
 * tab saved into a project and browser sessions sit in them and connect
 * across them wherever the records prove a relationship — and wherever the
 * person drew one themselves (a link, a dependency). Selecting anything
 * brings it and its relationships forward, quiets the rest, travels the
 * camera there and opens an inspector with what Hubble knows and what can
 * be done; opening it goes to the real thing. A saved tab can be managed
 * here as in its project: opened, noted, favourited, filed in a collection,
 * moved, linked, removed — from the inspector or by right-clicking it.
 * Search, filters, zoom, a keyboard path through every node and a list view
 * of the same data make it usable without the canvas at all.
 */
export function KnowledgeGraphView(props: KnowledgeGraphViewProps) {
  const { workspaces, now } = props
  const allWorkspaces = props.allWorkspaces ?? workspaces
  const { sessions: allSessions } = useTabSessions()
  const sessions = useMemo(() => (props.showSessions ? allSessions : []), [props.showSessions, allSessions])
  const launcher = useSessionLaunch()
  const reducedMotion = useReducedMotion()
  const appearance = useGraphAppearance()

  // ---- saved tabs and the relationships the person made between them ----
  const tabIndex = useMemo(() => {
    const map = new Map<string, { workspace: Workspace; tab: Tab }>()
    for (const workspace of allWorkspaces) for (const tab of workspace.tabs) map.set(tab.id, { workspace, tab })
    return map
  }, [allWorkspaces])
  const validTabIds = useMemo(() => new Set(tabIndex.keys()), [tabIndex])
  const dependencyStore = useDependencyStore(validTabIds)
  const collectionStore = useCollectionStore(allWorkspaces)
  const tabLinks = useTabLinks(validTabIds)

  const graph = useMemo(
    () => buildKnowledgeGraph({ workspaces, sessions, links: tabLinks.links, dependencies: dependencyStore.dependencies }),
    [workspaces, sessions, tabLinks.links, dependencyStore.dependencies]
  )
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
    const shown = (node: KnowledgeNode) => {
      const filter = filterOf(node)
      return !filter || kinds[filter]
    }
    for (const node of graph.nodes) {
      if (!shown(node)) continue
      if (projectFilter === "all") keep.add(node.id)
      else if (node.id === `p:${projectFilter}` || node.projectId === projectFilter) keep.add(node.id)
    }
    // With one project chosen, what connects to it from elsewhere stays in view.
    if (projectFilter !== "all") {
      for (const id of [...keep]) {
        for (const other of neighbours.get(id) ?? []) {
          const node = byId.get(other)
          if (node && shown(node)) keep.add(other)
        }
      }
    }
    const nodes = graph.nodes.filter((node) => keep.has(node.id))
    const edges = graph.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target))
    return { nodes, edges, ids: keep }
  }, [graph, kinds, projectFilter, neighbours, byId])

  const counts = useMemo(() => {
    const out: Record<FilterKind, number> = { conversation: 0, source: 0, tab: 0, file: 0, note: 0, session: 0 }
    for (const node of graph.nodes) {
      const filter = filterOf(node)
      if (filter && (projectFilter === "all" || node.projectId === projectFilter)) out[filter] += 1
    }
    return out
  }, [graph, projectFilter])
  // Saved tabs get a chip of their own only where there are any: most people's graphs have none.
  const hasSavedTabs = useMemo(() => graph.nodes.some((node) => node.savedTab), [graph])

  const results = useMemo(() => searchNodes(visible.nodes, query, (id) => names.get(id)), [visible.nodes, query, names])
  const matches = useMemo(() => new Set(results.map((node) => node.id)), [results])

  const highlighted = useMemo(() => new Set(selected ? (edgesOf.get(selected) ?? []).map((edge) => edge.id) : []), [selected, edgesOf])
  const emphasised = useMemo<ReadonlySet<string> | null>(() => {
    if (selected) return new Set([selected, ...(neighbours.get(selected) ?? [])])
    if (query.trim() && matches.size > 0) return matches
    if (hover) return new Set([hover.id, ...(neighbours.get(hover.id) ?? [])])
    return null
  }, [selected, neighbours, query, matches, hover])

  // The galaxy's core: all projects, joined to each by a spoke — or, with one project chosen, that project.
  const root = useMemo(() => {
    if (projectFilter !== "all") return undefined
    const projects = graph.nodes.filter((node) => node.kind === "project").length
    const items = graph.nodes.length - projects
    return { label: "All projects", detail: `${projects} ${projects === 1 ? "PROJECT" : "PROJECTS"} · ${items} ${items === 1 ? "ITEM" : "ITEMS"}` }
  }, [graph, projectFilter])
  const coreProject = selectedNode ? (selectedNode.kind === "project" ? selectedNode.id : selectedNode.projectId ? `p:${selectedNode.projectId}` : undefined) : projectFilter !== "all" ? `p:${projectFilter}` : undefined

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

  // Choosing a project travels to it; going back to all projects frames the whole galaxy.
  const framedFilter = useRef(projectFilter)
  useEffect(() => {
    if (!positions || framedFilter.current === projectFilter) return
    framedFilter.current = projectFilter
    if (projectFilter === "all") canvas.current?.fit()
    else canvas.current?.fit(visible.nodes.filter((node) => node.id === `p:${projectFilter}` || node.projectId === projectFilter).map((node) => node.id))
  }, [projectFilter, positions, visible.nodes])

  /** Asks the camera to frame `ids`. The nonce only has to differ from the last one, so the same frame can be asked for twice. */
  function frame(ids: string[]) {
    setFocusRequest((previous) => ({ ids, nonce: (previous?.nonce ?? 0) + 1 }))
  }

  function frameIdsFor(id: string): string[] {
    const near = [...(neighbours.get(id) ?? [])].filter((other) => visible.ids.has(other))
    const node = byId.get(id)
    // A project frames its own neighbourhood; anything else frames itself and what it connects to.
    if (node?.kind === "project") return [id, ...near.filter((other) => byId.get(other)?.projectId === id.slice(2))].slice(0, FRAME_LIMIT)
    return [id, ...near].slice(0, FRAME_LIMIT)
  }

  function select(id: string | undefined, options: { fromHistory?: boolean; frame?: boolean } = {}) {
    if (id === selected) {
      if (id && options.frame !== false) frame(frameIdsFor(id))
      return
    }
    if (!options.fromHistory && selected && id) setHistory((list) => [...list.slice(-30), selected])
    if (!id) setHistory([])
    setSelected(id)
    if (id) {
      setFocused(id)
      const node = byId.get(id)
      if (node) setAnnouncement(`Selected ${announceNode(node, node.projectId ? names.get(node.projectId) : undefined, neighbours.get(id)?.size ?? 0, now)}`)
      if (options.frame !== false) frame(frameIdsFor(id))
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
    // A saved tab opens as the page itself, in the browser: the graph stays where it is.
    if (node.savedTab && node.projectId && node.item) return props.onOpenItem(node.projectId, node.item.ref)
    const go = () => {
      if (node.kind === "project") props.onOpenProject(node.id.slice(2))
      else if (node.projectId && node.item) props.onOpenItem(node.projectId, node.item.ref)
    }
    if (mode === "list" || reducedMotion) return go()
    // Into the thing: the camera travels toward it as the graph fades, then the resource opens.
    setLeaving(true)
    canvas.current?.diveInto(node.id, go)
  }

  function reuseInAi(node: KnowledgeNode) {
    if (!props.onUseInAi) return
    if (node.kind === "project") props.onUseInAi(node.id.slice(2), [])
    else if (node.projectId && node.item) props.onUseInAi(node.projectId, [node.item.ref])
  }

  // ---- saved tabs: what can be done to one from here ----
  const [menu, setMenu] = useState<{ id: string; point: Point } | null>(null)
  const [linkDialog, setLinkDialog] = useState<{ mode: GraphLinkDialogMode; tabId: string } | null>(null)
  const [gather, setGather] = useState<{ workspaceId: string; tabId: string } | null>(null)
  /** The node whose note is open for editing in the inspector. */
  const [editingNote, setEditingNote] = useState<string | undefined>(undefined)
  /** A selected tab on its way to another project: chosen again, and travelled to, once it lands there. */
  const [following, setFollowing] = useState<{ id: string; project: string } | undefined>(undefined)
  if (following && byId.has(following.id)) {
    setFollowing(undefined)
    setSelected(following.id)
    setFocused(following.id)
    frame([following.id, following.project])
  }

  /** The saved tab behind a node: any source, read or not, lives on a tab. */
  function graphTabOf(node: KnowledgeNode | undefined): GraphTab | undefined {
    if (!node?.item || node.item.ref.kind !== "source") return undefined
    const entry = tabIndex.get(node.item.ref.tabId)
    if (!entry) return undefined
    const { workspace, tab } = entry
    const collections = collectionStore.collections
    const collection = getCollectionForTab(collections, tab.id)
    const section = sectionPath(workspace, tab.sectionId)
    return {
      workspaceId: workspace.id,
      tab,
      ...(section ? { section } : {}),
      ...(collection ? { collection: { id: collection.id, name: collection.name } } : {}),
      collections: getCollectionsForWorkspace(collections, workspace.id)
        .filter((entry) => entry.id !== collection?.id)
        .map((entry) => ({ id: entry.id, name: entry.name })),
      // Only a tab Hubble holds no text for moves: a read source's text is stored under its project, and would be left behind.
      projects: tab.resource ? [] : workspaces.filter((entry) => entry.id !== workspace.id).map((entry) => ({ id: entry.id, name: names.get(entry.id) ?? entry.name })),
    }
  }

  function tabActionsFor(node: KnowledgeNode, graphTab: GraphTab): GraphTabActions | undefined {
    const actions = props.tabActions
    if (!actions) return undefined
    const { workspaceId, tab } = graphTab
    return {
      openPage: (newTab) => actions.open(workspaceId, tab.id, newTab ? { newTab: true } : undefined),
      copy: (clean) => {
        void copyText(clean ? tab.normalizedUrl : tab.url).then((ok) => (ok ? toast.success(clean ? "Clean link copied" : "Link copied") : toast.error("Couldn't copy the link")))
      },
      toggleFavorite: () => actions.update(workspaceId, tab.id, { isFavorite: !tab.isFavorite }),
      editNote: () => {
        if (selected !== node.id) select(node.id, { frame: false })
        setEditingNote(node.id)
      },
      moveTo: (target) => {
        // Its node becomes the one in the other project: the selection follows it there once it exists.
        if (selected === node.id) setFollowing({ id: itemNodeId(target, `s:${tab.id}`), project: `p:${target}` })
        actions.move(workspaceId, [tab.id], target)
      },
      addToCollection: (collectionId) => {
        const collection = collectionStore.collections.find((entry) => entry.id === collectionId)
        const validation = validateAddTabToCollection(collectionStore.collections, collectionId, tab.id, workspaceId)
        if (!collection || !validation.ok) {
          if (!validation.ok && validation.reason !== "duplicate") toast.error("Couldn't add that tab to the collection")
          return
        }
        collectionStore.addTabToCollection(collectionId, tab.id)
        toast.success(`Added to ${collection.name}`)
      },
      newCollection: () => setGather({ workspaceId, tabId: tab.id }),
      leaveCollection: () => {
        if (!graphTab.collection) return
        collectionStore.removeTabFromCollection(graphTab.collection.id, tab.id)
        toast.success(`Removed from ${graphTab.collection.name}`)
      },
      linkTo: () => setLinkDialog({ mode: "link", tabId: tab.id }),
      addDependency: () => setLinkDialog({ mode: "dependency", tabId: tab.id }),
      remove: () => {
        if (selected === node.id) select(undefined)
        // The shell removes it and offers Undo, exactly as the project view does.
        actions.remove(workspaceId, [tab.id])
      },
    }
  }

  const tabIdOf = (id: string) => {
    const ref = byId.get(id)?.item?.ref
    return ref?.kind === "source" ? ref.tabId : undefined
  }

  function removeRelation(edge: KnowledgeEdge) {
    const a = tabIdOf(edge.source)
    const b = tabIdOf(edge.target)
    if (!a || !b) return
    if (edge.kind === "linked") {
      tabLinks.remove(a, b)
      toast.success("Link removed", { action: { label: "Undo", onClick: () => tabLinks.add(a, b) } })
    } else if (edge.kind === "depends-on" && edge.dependency) {
      const type = edge.dependency.type
      dependencyStore.removeDependency(edge.dependency.id)
      toast.success("Dependency removed", { action: { label: "Undo", onClick: () => dependencyStore.addDependency(a, b, type) } })
    }
  }

  function setDependencyType(edge: KnowledgeEdge, type: DependencyType | undefined) {
    if (edge.dependency) dependencyStore.updateDependencyType(edge.dependency.id, type)
  }

  // The pickers search every saved tab, in every project: a link or a dependency can cross projects.
  const linkCandidates = useMemo(() => {
    if (!linkDialog) return []
    const lookup = buildWorkspaceLookup([...allWorkspaces])
    return buildGraphNodes(
      allWorkspaces.flatMap((workspace) => workspace.tabs),
      lookup
    ).filter((candidate) => candidate.id !== linkDialog.tabId)
  }, [linkDialog, allWorkspaces])
  const linkSource = linkDialog ? tabIndex.get(linkDialog.tabId) : undefined
  const linkSourceNode = linkSource ? { id: linkSource.tab.id, tab: linkSource.tab, workspaceId: linkSource.workspace.id, workspaceName: linkSource.workspace.name } : null
  const existingDependencies = useMemo(
    () => (linkDialog?.mode === "dependency" ? new Set(dependenciesOf(linkDialog.tabId, dependencyStore.dependencies).map((dependency) => dependency.childTabId)) : undefined),
    [linkDialog, dependencyStore.dependencies]
  )

  function addLink(targetTabId: string) {
    if (!linkDialog) return
    if (tabLinks.add(linkDialog.tabId, targetTabId)) toast.success("Tabs linked")
    else toast.info("Already linked")
  }

  function addDependency(targetTabId: string, type: DependencyType | undefined) {
    if (!linkDialog) return
    const validation = validateDependency(dependencyStore.dependencies, linkDialog.tabId, targetTabId)
    if (!validation.ok) {
      toast.info(validation.reason === "self" ? "A tab can't depend on itself" : "Already a dependency")
      return
    }
    dependencyStore.addDependency(linkDialog.tabId, targetTabId, type)
    toast.success("Dependency added")
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
    if (at && (at.x < 40 || at.y < 80 || at.x > size.width - (selectedNode && wide ? INSPECTOR_W + 40 : 40) || at.y > size.height - 40)) frame([next])
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
  const selectedTab = graphTabOf(selectedNode)
  const selectedTabActions = selectedNode && selectedTab ? tabActionsFor(selectedNode, selectedTab) : undefined
  // A right-click on something since removed shows nothing.
  const menuNode = menu ? byId.get(menu.id) : undefined
  const menuTab = graphTabOf(menuNode)
  const menuTabActions = menuNode && menuTab ? tabActionsFor(menuNode, menuTab) : undefined
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
            {...(selected ? { selected } : {})}
            {...(coreProject ? { core: coreProject } : {})}
            {...(root ? { root } : {})}
            paused={mode === "list" || leaving}
            {...(hover ? { hovered: hover.id } : {})}
            {...(focused ? { focused } : {})}
            matches={matches}
            highlighted={highlighted}
            emphasised={emphasised}
            {...(saved.camera ? { initialCamera: saved.camera } : {})}
            insets={insets}
            reducedMotion={reducedMotion}
            appearance={appearance}
            onHover={(id, point) => setHover(id && point ? { id, point } : null)}
            onSelect={(id) => {
              surface.current?.focus({ preventScroll: true })
              select(id)
            }}
            onOpen={(id) => {
              const node = byId.get(id)
              if (node) open(node)
            }}
            onContextMenu={(id, point) => {
              setHover(null)
              setMenu({ id, point })
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
                      <NodeIcon node={node} />
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
          {FILTER_KINDS.filter((kind) => (kind !== "session" || props.showSessions) && (kind !== "tab" || hasSavedTabs)).map((kind) => (
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
              {/* A saved tab is drawn hollow on the canvas (no text held), and so is its chip's dot. */}
              <span aria-hidden className={cn("size-2 rounded-full transition-opacity", kind === "tab" ? "border border-kind-source" : KIND_BG_CLASS[kind], !kinds[kind] && "opacity-30")} />
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
                if (selected && mode !== "graph") frame(frameIdsFor(selected))
              }}
            >
              <Network />
            </IconButton>
            <IconButton aria-label="List" tooltip="List" aria-pressed={mode === "list"} className={cn(mode === "list" && "bg-surface-selected text-foreground")} onClick={() => setMode("list")}>
              <ListTree />
            </IconButton>
          </div>
          <div className="surface-panel flex h-9 items-center px-1">
            <GraphAppearanceControl reducedMotion={reducedMotion} />
          </div>
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
          {...(props.onUseInAi ? { onUseInAi: reuseInAi } : {})}
          onOpenUrl={props.onOpenUrl}
          {...(props.onOpenSessions ? { onOpenSessions: props.onOpenSessions } : {})}
          {...(selectedTab ? { graphTab: selectedTab } : {})}
          {...(selectedTabActions ? { tabActions: selectedTabActions } : {})}
          {...(selectedTab && props.tabActions
            ? {
                onSaveNote: (text: string) => props.tabActions!.update(selectedTab.workspaceId, selectedTab.tab.id, { notes: text.trim() || undefined }),
                editingNote: editingNote === selectedNode.id,
                onEditNote: (editing: boolean) => setEditingNote(editing ? selectedNode.id : undefined),
                onRemoveRelation: removeRelation,
                onDependencyType: setDependencyType,
              }
            : {})}
          className={cn(
            "absolute z-20",
            wide ? "top-[60px] right-3 bottom-3 w-[344px] animate-[hb-panel-in_var(--duration-slow)_var(--ease-standard)_both]" : "inset-x-2 bottom-2 max-h-[55%] animate-[hb-sheet-in_var(--duration-slow)_var(--ease-standard)_both]"
          )}
        />
      )}

      {/* ---- right-click ---- */}
      {menuNode && menu && (
        <DropdownMenu open onOpenChange={(open) => !open && setMenu(null)}>
          {/* Canvas pixels are not elements: the menu anchors to a point placed where the click was. */}
          <DropdownMenuTrigger nativeButton={false} render={<span aria-hidden className="pointer-events-none absolute size-px" style={{ left: menu.point.x, top: menu.point.y }} />} />
          <DropdownMenuContent align="start" className="w-56" aria-label={`Actions for ${menuNode.label}`}>
            {!menuNode.savedTab && (
              <DropdownMenuItem onClick={() => open(menuNode)}>
                <ArrowUpRight /> {menuNode.kind === "project" ? "Open project" : menuNode.kind === "session" ? "Restore session" : `Open ${nodeTypeNoun(menuNode)}`}
              </DropdownMenuItem>
            )}
            {props.onUseInAi && menuNode.kind !== "session" && (
              <DropdownMenuItem onClick={() => reuseInAi(menuNode)}>
                <MessageSquareShare /> Use in AI
              </DropdownMenuItem>
            )}
            {menuTab && menuTabActions ? (
              <>
                <DropdownMenuSeparator />
                <TabMenuItems graphTab={menuTab} actions={menuTabActions} />
              </>
            ) : (
              menuNode.item?.url && (
                <DropdownMenuItem
                  onClick={() => {
                    void copyText(menuNode.item!.url!).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy the link")))
                  }}
                >
                  <Copy /> Copy link
                </DropdownMenuItem>
              )
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <GraphLinkDialog
        open={linkDialog !== null}
        onOpenChange={(next) => {
          if (!next) setLinkDialog(null)
        }}
        mode={linkDialog?.mode ?? "link"}
        sourceNode={linkSourceNode}
        candidates={linkCandidates}
        existingDependencyTargetIds={existingDependencies}
        onLink={addLink}
        onAddDependency={addDependency}
      />
      <GatherDialog
        open={gather !== null}
        onOpenChange={(next) => {
          if (!next) setGather(null)
        }}
        tabCount={gather ? 1 : 0}
        onConfirm={(name) => {
          if (!gather) return
          collectionStore.createCollection(gather.workspaceId, name, [gather.tabId])
          toast.success(`Gathered into "${name}"`)
          setGather(null)
        }}
      />

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <LaunchConfirmDialog request={launcher.confirming} onConfirm={() => void launcher.confirm()} onCancel={launcher.cancel} />
    </div>
  )
}

/** What a menu's "Open …" names: "conversation", "source", "file", "note". */
function nodeTypeNoun(node: KnowledgeNode): string {
  return node.kind === "conversation" ? "conversation" : node.kind === "file" ? "file" : node.kind === "note" ? "note" : "source"
}

/** Where a tab is filed, as its section's path: "School › Physics". */
function sectionPath(workspace: Workspace, sectionId: string | undefined): string | undefined {
  if (!sectionId) return undefined
  const sections = new Map((workspace.sections ?? []).map((section) => [section.id, section]))
  const path: string[] = []
  let current = sections.get(sectionId)
  // Sections are at most three deep; the bound only guards a corrupted loop.
  while (current && path.length < 4) {
    path.unshift(current.name)
    current = current.parentId ? sections.get(current.parentId) : undefined
  }
  return path.length > 0 ? path.join(" › ") : undefined
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

/** The galaxy in miniature, drawn once: the graph's empty and loading states. */
function EmptyOrbit({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 96 96" className={cn("size-20 text-foreground", spinning && "motion-safe:animate-[spin_9s_linear_infinite]")}>
      <ellipse cx="48" cy="52" rx="44" ry="17" fill="none" stroke="currentColor" strokeOpacity="0.14" />
      <ellipse cx="48" cy="52" rx="26" ry="10" fill="none" stroke="currentColor" strokeOpacity="0.2" />
      <g stroke="var(--graph-filament)" strokeOpacity="0.55" strokeWidth="0.6" fill="none">
        <path d="M48 50 L70 30 M70 30 Q78 20 84 12 M70 30 Q80 24 88 20 M70 30 Q76 16 78 8" />
        <path d="M48 50 L28 34 M28 34 Q20 24 14 18 M28 34 Q18 30 10 30 M28 34 Q24 20 22 12" />
        <path d="M48 50 L58 72 M58 72 Q62 82 66 90 M58 72 Q68 80 74 84" />
      </g>
      <g fill="var(--graph-hub)">
        <circle cx="70" cy="30" r="1.8" />
        <circle cx="28" cy="34" r="1.8" />
        <circle cx="58" cy="72" r="1.6" />
      </g>
      <rect x="44.5" y="46.5" width="7" height="7" fill="var(--graph-filament)" fillOpacity="0.25" stroke="var(--graph-blush)" strokeWidth="0.8" transform="rotate(20 48 50)" />
    </svg>
  )
}
