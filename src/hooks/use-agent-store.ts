"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ingestObservation } from "@/lib/agents/adapter"
import { pruneOrphanedArtifacts, recordArtifactWork } from "@/lib/agents/artifacts"
import { appendRunEvent } from "@/lib/agents/events"
import { addRunLink, removeRunLink, pruneRunLinks } from "@/lib/agents/links"
import { recordWorkItemEvidence } from "@/lib/agents/work-item-evidence"
import {
  loadAgentState,
  saveAgentState,
  defaultAgentState,
} from "@/lib/agents/persistence"
import {
  createAgent,
  deleteAgent,
  deleteAgentAndRuns,
  updateAgent,
} from "@/lib/agents/registry"
import {
  createRun,
  deleteRun,
  transitionRunStatus,
  updateRun,
} from "@/lib/agents/runs"
import {
  createWorkItem,
  deleteWorkItem,
  transitionWorkItem,
  updateWorkItem,
} from "@/lib/agents/work-items"
import { createTimestamp } from "@/lib/timestamps"
import type { AgentAdapterObservation } from "@/lib/agents/adapter"
import type { RecordArtifactWorkInput } from "@/lib/agents/artifacts"
import type { AppendRunEventInput } from "@/lib/agents/events"
import type { AddRunLinkInput } from "@/lib/agents/links"
import type { CreateAgentInput, UpdateAgentPatch } from "@/lib/agents/registry"
import type { CreateRunInput, UpdateRunPatch } from "@/lib/agents/runs"
import type { RecordWorkItemEvidenceInput } from "@/lib/agents/work-item-evidence"
import type { CreateWorkItemInput, UpdateWorkItemPatch } from "@/lib/agents/work-items"
import type {
  AgentFailureReason,
  AgentRunStatus,
  AgentState,
  AgentWorkItemStatus,
} from "@/lib/agents/types"

const SAVE_DEBOUNCE_MS = 400

/**
 * React access to the agent domain.
 *
 * Follows the shape useDependencyStore already established: load once on
 * mount, hold the domain in React state, save it back on a debounce. The
 * store is deliberately thin — every mutation below is the corresponding pure
 * reducer with the clock read once, here, at the point the user's action
 * actually happens.
 *
 * This is infrastructure for later phases. There is no UI in this phase, and
 * nothing here observes any real agent: the domain is driven by explicit
 * calls, or by observations handed to `ingest` from an adapter the caller
 * owns.
 */
export function useAgentStore(validTabIds?: Set<string>) {
  /**
   * Loaded once, in the initialiser, rather than in an effect.
   *
   * `readOnly` rides along with the state because both come from the same
   * read: it is set when the stored state was written by a *newer* build than
   * this one, and while it is true the save effect stands down, so an older
   * tab that happens to open the key cannot flatten agent history it does not
   * understand. The user still gets a working (empty) session; they just do
   * not get to overwrite the real data with it.
   */
  const [store, setStore] = useState<{ state: AgentState; readOnly: boolean }>(() => {
    if (typeof window === "undefined") return { state: defaultAgentState(), readOnly: false }
    const load = loadAgentState()
    return { state: load.state, readOnly: load.status === "unsupported" }
  })

  const state = store.state

  /**
   * The newest state, readable synchronously.
   *
   * Reducers need their input the moment they are called, but a `setState`
   * updater does not run until React gets around to rendering — so a mutation
   * cannot both compose correctly with an earlier one in the same tick and
   * report whether it was refused. Holding the value in a ref, and advancing
   * it at the same instant as the setState, gives both: two calls in one
   * event handler see each other's work, and each returns its own outcome.
   */
  const stateRef = useRef(state)

  const commit = useCallback((next: AgentState) => {
    stateRef.current = next
    setStore((current) => ({ ...current, state: next }))
  }, [])

  /**
   * Links to tabs that no longer exist are dropped at read time rather than
   * by a reactive effect — the same approach useDependencyStore takes, so a
   * tab or workspace deletion is reflected on the very next render with no
   * synchronisation step of its own.
   *
   * `validTabIds` is optional: a caller that has no tab list (a test, or a
   * consumer that only cares about runs) gets the state unpruned rather than
   * having every link silently disappear.
   */
  const visible = useMemo(
    () => (validTabIds ? pruneRunLinks(state, validTabIds) : state),
    [state, validTabIds]
  )

  useEffect(() => {
    if (store.readOnly) return
    const timer = setTimeout(() => {
      saveAgentState(visible)
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [visible, store.readOnly])

  /**
   * Runs a reducer against the newest state and keeps the result if it
   * succeeded.
   *
   * Returns the failure reason, or null on success, so a caller can tell a
   * refused cross-workspace link from one that went through. A refusal leaves
   * state entirely untouched — no re-render, nothing written.
   */
  const apply = useCallback(
    <R extends { ok: true; state: AgentState } | { ok: false; reason: AgentFailureReason }>(
      reducer: (current: AgentState) => R
    ): AgentFailureReason | null => {
      const result = reducer(stateRef.current)
      if (!result.ok) return result.reason
      commit(result.state)
      return null
    },
    [commit]
  )

  return useMemo(
    () => ({
      state: visible,
      agents: visible.agents,
      runs: visible.runs,
      links: visible.links,
      events: visible.events,
      artifacts: visible.artifacts,
      artifactLinks: visible.artifactLinks,
      workItems: visible.workItems,

      createAgent: (input: CreateAgentInput) => {
        const now = createTimestamp()
        return apply((current) => createAgent(current, input, now))
      },
      updateAgent: (agentId: string, patch: UpdateAgentPatch) => {
        const now = createTimestamp()
        return apply((current) => updateAgent(current, agentId, patch, now))
      },
      deleteAgent: (agentId: string) => apply((current) => deleteAgent(current, agentId)),
      deleteAgentAndRuns: (agentId: string) =>
        apply((current) => deleteAgentAndRuns(current, agentId)),

      createRun: (input: CreateRunInput) => {
        const now = createTimestamp()
        return apply((current) => createRun(current, input, now))
      },
      updateRun: (runId: string, patch: UpdateRunPatch) => {
        const now = createTimestamp()
        return apply((current) => updateRun(current, runId, patch, now))
      },
      transitionRunStatus: (runId: string, next: AgentRunStatus) => {
        const now = createTimestamp()
        return apply((current) => transitionRunStatus(current, runId, next, now))
      },
      deleteRun: (runId: string) => apply((current) => deleteRun(current, runId)),

      addRunLink: (input: AddRunLinkInput) => {
        const now = createTimestamp()
        return apply((current) => addRunLink(current, input, now))
      },
      removeRunLink: (linkId: string) => apply((current) => removeRunLink(current, linkId)),

      /**
       * Records that a run worked on a project file.
       *
       * The artifact is resolved into the run's own workspace and the path is
       * re-normalised by the domain, so a caller cannot file a run's work
       * under someone else's project by passing a different workspace.
       */
      recordArtifactWork: (input: RecordArtifactWorkInput) => {
        const now = createTimestamp()
        return apply((current) => recordArtifactWork(current, input, now))
      },

      /** Drops artifacts no run refers to any more. Explicit: pruning discards real history. */
      pruneOrphanedArtifacts: () => commit(pruneOrphanedArtifacts(stateRef.current)),

      /**
       * Work items.
       *
       * Read-write over the *record* of work, never over the work itself:
       * these create, describe, re-state and delete Hubble's knowledge of a
       * unit of work. None of them reaches the agent, and there is
       * deliberately no operation here that would — no run, no retry, no
       * assign. Transitions go through `transitionWorkItem` alone, which is
       * the only thing that enforces the lifecycle.
       */
      createWorkItem: (input: CreateWorkItemInput) => {
        const now = createTimestamp()
        return apply((current) => createWorkItem(current, input, now))
      },
      updateWorkItem: (workItemId: string, patch: UpdateWorkItemPatch) => {
        const now = createTimestamp()
        return apply((current) => updateWorkItem(current, workItemId, patch, now))
      },
      transitionWorkItem: (workItemId: string, next: AgentWorkItemStatus) => {
        const now = createTimestamp()
        return apply((current) => transitionWorkItem(current, workItemId, next, now))
      },
      deleteWorkItem: (workItemId: string) =>
        apply((current) => deleteWorkItem(current, workItemId)),

      /**
       * Records that one thing is evidence for one work item.
       *
       * The only way a task-level association enters the domain, and it is
       * write-only in the sense that matters: nothing derives these rows.
       * The domain refuses any target the work item's run does not already
       * touch, so this cannot reach a tab, file or event outside the run.
       */
      recordWorkItemEvidence: (input: RecordWorkItemEvidenceInput) => {
        const now = createTimestamp()
        return apply((current) => recordWorkItemEvidence(current, input, now))
      },

      appendRunEvent: (input: Omit<AppendRunEventInput, "timestamp"> & { timestamp?: number }) => {
        const timestamp = input.timestamp ?? createTimestamp()
        return apply((current) => appendRunEvent(current, { ...input, timestamp }))
      },

      /**
       * Folds an adapter observation into the domain.
       *
       * The only entry point a provider integration needs: it hands over what
       * it saw and the agent identity it belongs to, and the domain decides
       * whether that creates a run, updates one, or — with no workspace
       * mapping — does nothing at all.
       */
      ingest: (agentId: string, observation: AgentAdapterObservation) => {
        const now = createTimestamp()
        return apply((current) => ingestObservation(current, { agentId, observation, now }))
      },

      /**
       * The domain as it stands *right now*, including mutations made earlier
       * in this same tick.
       *
       * The values above (`agents`, `runs`, …) are the rendered snapshot and
       * are one render behind a mutation just made — fine for rendering,
       * wrong for a caller that creates something and immediately needs to
       * look it up. An observer feeding a batch of updates hits exactly that:
       * it creates the agent and must attribute the very same batch to it.
       */
      getState: () => stateRef.current,

      /** Replaces the whole domain. For tests and for an explicit reload. */
      reset: (next?: AgentState) => commit(next ?? defaultAgentState()),
    }),
    [visible, apply, commit]
  )
}

/**
 * The store's public shape, for the surfaces that are handed one.
 *
 * The store is mounted once, at the shell, and passed down — so the views
 * that read it need a name for what they are receiving. Derived from the hook
 * rather than written out, so it cannot drift from what the hook returns.
 */
export type AgentStoreApi = ReturnType<typeof useAgentStore>
