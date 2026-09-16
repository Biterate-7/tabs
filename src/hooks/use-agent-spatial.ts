"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { placeAgentScene } from "@/lib/agents/spatial/placement"
import {
  loadAgentLayout,
  positionsForWorkspace,
  saveAgentLayout,
  setAgentFilter,
  setNodePosition,
} from "@/lib/agents/spatial/persistence"
import { buildAgentSpatialScene, emphasizedEdgeIds } from "@/lib/agents/spatial/scene"
import type { AgentLayoutState, Point } from "@/lib/agents/spatial/persistence"
import type {
  AgentSpatialFilter,
  AgentSpatialScene,
  SpatialId,
} from "@/lib/agents/spatial/types"
import type { AgentState } from "@/lib/agents/types"

const SAVE_DEBOUNCE_MS = 400

export type AgentSpatialLayer = {
  scene: AgentSpatialScene
  /** Spatial id → world position. Everything in `scene.nodes` has an entry. */
  positions: Map<SpatialId, Point>
  /** Edge ids to draw prominently, given the current selection. */
  emphasized: Set<string>
  filter: AgentSpatialFilter
  /** Which provider's runs are shown; null means all of them. */
  providerFilter: string | null
  /** Providers with runs in this workspace. Empty until at least one has worked here. */
  providers: string[]
  selectedId: SpatialId | null
  setFilter: (filter: AgentSpatialFilter) => void
  setProviderFilter: (provider: string | null) => void
  select: (id: SpatialId | null) => void
  /** Records a drag. Layout only — this cannot change agent state. */
  moveNode: (id: SpatialId, point: Point) => void
  /** True when the workspace has agent work that the current filter hides. */
  hiddenRunCount: number
}

export type UseAgentSpatialInput = {
  /** Domain state, straight from useAgentStore. */
  state: AgentState
  workspaceId: string
  /** Where the tab graph currently sits, so the agent column can clear it. */
  tabBounds?: { minX: number; maxX: number; minY: number; maxY: number } | null
  /** Clock, injected for tests; defaults to the wall clock. */
  now?: number
}

/**
 * The agent layer, ready for the canvas to draw.
 *
 * Read-only with respect to the agent domain. It selects, filters, places and
 * remembers where things were dragged — and has no path that could change a
 * run's status, delete a run, or touch a relationship. That is deliberate:
 * this phase observes agent work, and a canvas that could mutate it would be a
 * different and much riskier product.
 *
 * It also owns no polling. Observation belongs to the Phase 12 observer, which
 * feeds the store; this hook reads what the store already holds. There is
 * exactly one observer in the app, and it is not here.
 */
export function useAgentSpatial(input: UseAgentSpatialInput): AgentSpatialLayer {
  const { state, workspaceId, tabBounds, now } = input

  const [layout, setLayout] = useState<AgentLayoutState>(() => {
    if (typeof window === "undefined") {
      return { version: 1, positions: {}, filter: "active" }
    }
    return loadAgentLayout()
  })

  /**
   * The provider filter, held in React state rather than in the persisted
   * layout.
   *
   * Not persisted on purpose: a saved provider filter is a way to come back
   * tomorrow, see one agent's work, and conclude the others did nothing. The
   * status filter is safe to remember because it is about *recency*, which
   * the user can read off the pills; a hidden provider has no such tell.
   */
  const [providerFilter, setProviderFilter] = useState<string | null>(null)

  /**
   * Selection remembers which workspace it belongs to.
   *
   * Derived rather than cleared by an effect: a run selected in one workspace
   * means nothing in another, so instead of reacting to the switch, the
   * selection simply does not apply unless the workspace matches. That is pure,
   * needs no effect, and has the nicer behaviour of restoring what was
   * selected when the user comes back.
   */
  const [selection, setSelection] = useState<{ workspaceId: string; id: SpatialId } | null>(null)
  const selectedId = selection && selection.workspaceId === workspaceId ? selection.id : null

  const select = useCallback(
    (id: SpatialId | null) => {
      setSelection(id ? { workspaceId, id } : null)
    },
    [workspaceId]
  )

  useEffect(() => {
    if (typeof window === "undefined") return
    const timer = setTimeout(() => {
      saveAgentLayout(layout)
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [layout])

  /**
   * "Now", derived from the data rather than from the wall clock.
   *
   * The only thing this decides is how recent a finished run has to be to stay
   * in the default view — a six-hour window, where sub-second accuracy is
   * meaningless. Taking it from the newest thing the agent domain knows about
   * makes the whole derivation pure (so it is stable across renders, and
   * React's purity rules are satisfied without an interval or an effect), and
   * it behaves better besides: come back to a workspace after a week away and
   * the last thing your agent did is still on screen, instead of everything
   * having aged out because the wall clock moved and the work did not.
   */
  const derivedNow = useMemo(() => {
    let latest = 0
    for (const run of state.runs) {
      if (run.updatedAt > latest) latest = run.updatedAt
    }
    return latest
  }, [state.runs])

  const scene = useMemo(
    () =>
      buildAgentSpatialScene(state, {
        agents: state.agents,
        runs: state.runs,
        artifacts: state.artifacts,
        workspaceId,
        filter: layout.filter,
        providerFilter,
        selectedId,
        now: now ?? derivedNow,
      }),
    [state, workspaceId, layout.filter, providerFilter, selectedId, now, derivedNow]
  )

  const pinned = useMemo(
    () => positionsForWorkspace(layout, workspaceId),
    [layout, workspaceId]
  )

  const positions = useMemo(
    () => placeAgentScene({ scene, pinned, tabBounds }),
    [scene, pinned, tabBounds]
  )

  const emphasized = useMemo(() => emphasizedEdgeIds(scene, selectedId), [scene, selectedId])

  const setFilter = useCallback((filter: AgentSpatialFilter) => {
    setLayout((current) => setAgentFilter(current, filter))
  }, [])

  const moveNode = useCallback(
    (id: SpatialId, point: Point) => {
      setLayout((current) => setNodePosition(current, workspaceId, id, point))
    },
    [workspaceId]
  )

  return useMemo(
    () => ({
      scene,
      positions,
      emphasized,
      filter: layout.filter,
      providerFilter,
      providers: scene.providers,
      selectedId,
      setFilter,
      setProviderFilter,
      select,
      moveNode,
      hiddenRunCount: scene.hiddenRunCount,
    }),
    [
      scene,
      positions,
      emphasized,
      layout.filter,
      providerFilter,
      selectedId,
      setFilter,
      select,
      moveNode,
    ]
  )
}
