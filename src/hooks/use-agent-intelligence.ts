"use client"

import { useMemo } from "react"
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index"
import { getHighlightedObjectIds } from "@/lib/agents/intelligence/relationships"
import { getWorkspaceAgentActivity } from "@/lib/agents/intelligence/workspace-activity"
import type { AgentDomainIndex } from "@/lib/agents/intelligence/domain-index"
import type { WorkspaceAgentActivity } from "@/lib/agents/intelligence/types"
import type { SpatialId } from "@/lib/agents/spatial/types"
import type { AgentState } from "@/lib/agents/types"

/**
 * The derived intelligence layer, memoised for rendering.
 *
 * This hook owns exactly one thing: building the index **once per state
 * object** so that the many questions a render asks share the grouping cost.
 * Everything it returns is a pure function of `(state, workspaceId,
 * selectedId)`, so there is no effect, no subscription, no interval and no
 * local state to fall out of sync.
 *
 * It is read-only with respect to the agent domain, in the same way
 * `useAgentSpatial` is, and for a stronger reason: this layer is *derived*.
 * It has no state of its own to write, so there is nothing here that could
 * change a run, a work item, or a relationship even if someone tried.
 *
 * Observation still belongs to the Phase 12 observer. There is exactly one
 * observer in the app and it is not here.
 */
export type AgentIntelligenceLayer = {
  /** Grouped view of the domain. Pass to any intelligence selector. */
  index: AgentDomainIndex
  /** What is happening across the current workspace. */
  activity: WorkspaceAgentActivity
  /**
   * The workspace objects the current selection touches.
   *
   * Empty when nothing is selected — highlighting is per selection, never
   * global, so the canvas does not become a permanent web of agent edges.
   */
  highlighted: {
    workItemIds: Set<string>
    artifactIds: Set<string>
    tabIds: Set<string>
  }
}

export type UseAgentIntelligenceInput = {
  /** Domain state, straight from useAgentStore. */
  state: AgentState
  workspaceId: string
  /** The current agent-layer selection, so highlighting can follow it. */
  selectedId?: SpatialId | null
}

export function useAgentIntelligence(
  input: UseAgentIntelligenceInput
): AgentIntelligenceLayer {
  const { state, workspaceId, selectedId } = input

  // Keyed on the state object itself. Every domain operation replaces the
  // state rather than mutating it, so an unchanged reference means unchanged
  // data and the index is safely reused.
  const index = useMemo(() => buildAgentDomainIndex(state), [state])

  const activity = useMemo(
    () => getWorkspaceAgentActivity(index, workspaceId),
    [index, workspaceId]
  )

  /**
   * Only a run selection highlights anything.
   *
   * An agent or a file has no single set of "things it touched" — an agent
   * spans many runs, and a file is reached *by* runs rather than reaching
   * them. Highlighting for those would either mean unioning every run (the
   * unreadable case) or inventing a rule. So the answer is simply empty, and
   * the canvas stays quiet until a run is selected.
   */
  const highlighted = useMemo(() => {
    const runId = selectedId?.startsWith("run:") ? selectedId.slice("run:".length) : null
    return getHighlightedObjectIds(index, runId)
  }, [index, selectedId])

  return useMemo(
    () => ({ index, activity, highlighted }),
    [index, activity, highlighted]
  )
}
