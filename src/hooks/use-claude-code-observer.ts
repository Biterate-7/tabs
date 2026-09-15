"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createClaudeCodeAdapter } from "@/lib/agents/claude-code/adapter"
import {
  findWorkspaceForProject,
  loadProjectMappings,
  removeProjectMapping,
  saveProjectMappings,
  setProjectMapping,
} from "@/lib/agents/claude-code/mapping"
import { CLAUDE_CODE_AGENT_NAME, CLAUDE_CODE_PROVIDER } from "@/lib/agents/claude-code/types"
import { normalizeUrl } from "@/lib/tabs/normalize"
import { createTimestamp } from "@/lib/timestamps"
import type { ClaudeCodeAdapter, ClaudeCodeAdapterOptions } from "@/lib/agents/claude-code/adapter"
import type { ProjectMappingState } from "@/lib/agents/claude-code/mapping"
import type { ClaudeDiscoveredSession } from "@/lib/agents/claude-code/types"
import type { AgentAdapterObservation } from "@/lib/agents/adapter"
import type { useAgentStore } from "./use-agent-store"

/**
 * Wires the Claude Code adapter into the Phase 11 agent store.
 *
 * Its whole job is the joining-up: take observations from the adapter, attach
 * a workspace from the explicit mapping, and hand them to the domain. It
 * parses nothing, reads no files, and knows no transcript format — those live
 * on the server side of `src/lib/agents/claude-code/`.
 *
 * It also does not reimplement any domain rule. Run identity, terminal-status
 * protection, event retention, sticky metadata and workspace validation are
 * all Phase 11's, reached through `store.ingest` (which calls
 * `ingestObservation`) and `store.addRunLink`.
 */

export type ClaudeCodeTabIndex = {
  /** Tabs of one workspace, by normalized URL. Used for exact-match context linking. */
  workspaceId: string
  tabsByNormalizedUrl: Map<string, string>
}

export type UseClaudeCodeObserverOptions = {
  store: ReturnType<typeof useAgentStore>
  /** Off by default: nothing polls a user's machine unless asked to. */
  enabled?: boolean
  /**
   * Tab indexes per workspace, for URL context links. Omit to skip linking
   * entirely — the feature is optional and costs nothing when absent.
   */
  tabIndexes?: ClaudeCodeTabIndex[]
  adapterOptions?: ClaudeCodeAdapterOptions
}

export function useClaudeCodeObserver(options: UseClaudeCodeObserverOptions) {
  const { store, enabled = false, tabIndexes, adapterOptions } = options

  const [mappings, setMappings] = useState<ProjectMappingState>(() => {
    if (typeof window === "undefined") return { version: 1, mappings: [] }
    return loadProjectMappings()
  })
  const [sessions, setSessions] = useState<ClaudeDiscoveredSession[]>([])
  const [available, setAvailable] = useState(false)

  /**
   * The live values the poll callback needs.
   *
   * Held in refs so the subscription can be established once and survive
   * every mapping or tab change: rebuilding it on each render would tear down
   * and restart the poll loop constantly, and would lose the adapter's
   * cursor along with it.
   */
  const mappingsRef = useRef(mappings)
  const tabIndexRef = useRef(tabIndexes)
  const storeRef = useRef(store)

  // Synced in effects rather than during render: a ref written while
  // rendering is a side effect React is entitled to discard or repeat. The
  // poll that reads them is timer-driven and always lands well after the
  // effects for the render that produced its inputs.
  useEffect(() => {
    mappingsRef.current = mappings
  }, [mappings])

  useEffect(() => {
    tabIndexRef.current = tabIndexes
  }, [tabIndexes])

  useEffect(() => {
    storeRef.current = store
  }, [store])

  /**
   * One adapter for the life of the hook.
   *
   * Held in state with a lazy initialiser rather than a ref, so it is created
   * exactly once without being written during render — and so its identity is
   * stable, which is what keeps the subscription effect below from tearing
   * down and restarting the poll loop (losing its cursor) on every render.
   */
  const [adapter] = useState<ClaudeCodeAdapter>(() =>
    createClaudeCodeAdapter({
      ...adapterOptions,
      // Session listing and availability arrive with each poll rather than
      // being read back on a timer of our own — one loop for the whole
      // feature, which is the point of the adapter owning the schedule.
      onPoll: (polled) => {
        setSessions(polled.sessions)
        setAvailable(polled.available)
        adapterOptions?.onPoll?.(polled)
      },
    })
  )

  useEffect(() => {
    if (typeof window === "undefined") return
    saveProjectMappings(mappings)
  }, [mappings])

  /**
   * Resolves the single provider-level Agent, creating it only if absent.
   *
   * One Agent for Claude Code, many runs beneath it — never one Agent per
   * session. The lookup is by provider, so repeated polling finds the
   * existing identity instead of minting another.
   */
  const resolveAgentId = useCallback((): string | null => {
    const current = storeRef.current

    // Read through getState rather than the rendered `agents` array: an agent
    // created moments ago in this same batch is already in the live state but
    // not yet in the render, and attributing the rest of the batch to it is
    // the whole point of resolving an id here.
    const existing = current
      .getState()
      .agents.find((agent) => agent.provider === CLAUDE_CODE_PROVIDER)
    if (existing) return existing.id

    const failure = current.createAgent({
      provider: CLAUDE_CODE_PROVIDER,
      name: CLAUDE_CODE_AGENT_NAME,
    })
    if (failure) return null

    return (
      current.getState().agents.find((agent) => agent.provider === CLAUDE_CODE_PROVIDER)?.id ?? null
    )
  }, [])

  /**
   * Attaches a workspace to an observation, if the project has been mapped.
   *
   * Returns the observation unchanged when it has not. Phase 11 then reports
   * it as `unattached` and creates nothing, which preserves the discovery
   * without inventing a home for it — and the same session attaches on a
   * later poll once the user maps its project.
   */
  const attachWorkspace = useCallback(
    (observation: AgentAdapterObservation): AgentAdapterObservation => {
      if (!observation.projectKey) return observation

      const workspaceId = findWorkspaceForProject(mappingsRef.current, observation.projectKey)
      return workspaceId ? { ...observation, workspaceId } : observation
    },
    []
  )

  /**
   * Links an observed URL to an existing tab, when one matches exactly.
   *
   * Exact normalized match only, within the run's own workspace, using
   * TabDump's existing `normalizeUrl` so an agent visiting a saved page links
   * to the same tab the user would have. No tab is ever created, and no fuzzy
   * matching is attempted: a near-miss link is worse than no link, because it
   * asserts a relationship that did not happen.
   */
  const linkUrl = useCallback((runId: string, workspaceId: string, rawUrl: string) => {
    const indexes = tabIndexRef.current
    if (!indexes) return

    const index = indexes.find((entry) => entry.workspaceId === workspaceId)
    if (!index) return

    let normalized: string
    try {
      normalized = normalizeUrl(new URL(rawUrl))
    } catch {
      return
    }

    const tabId = index.tabsByNormalizedUrl.get(normalized)
    if (!tabId) return

    // Through the domain, never around it: addRunLink is what enforces that
    // the tab and the run share a workspace.
    storeRef.current.addRunLink({ runId, tabId, role: "context", tabWorkspaceId: workspaceId })
  }, [])

  const handleObservations = useCallback(
    (incoming: AgentAdapterObservation[]) => {
      const agentId = resolveAgentId()
      if (!agentId) return

      for (const raw of incoming) {
        const observation = attachWorkspace(raw)
        storeRef.current.ingest(agentId, observation)

        if (!observation.url || !observation.workspaceId) continue

        // Live state again: the run may have been created by an earlier
        // observation in this very batch.
        const run = storeRef.current
          .getState()
          .runs.find(
            (candidate) =>
              candidate.agentId === agentId && candidate.externalId === observation.externalId
          )
        if (run) linkUrl(run.id, run.workspaceId, observation.url)
      }
    },
    [attachWorkspace, linkUrl, resolveAgentId]
  )

  useEffect(() => {
    if (!enabled) return

    // One subscription, one loop. The adapter stops its timer as soon as the
    // last subscriber leaves, so unmounting ends all polling.
    return adapter.subscribe(handleObservations)
  }, [adapter, enabled, handleObservations])

  return useMemo(
    () => ({
      available,
      sessions,
      mappings: mappings.mappings,

      /** Sessions with no workspace mapping yet — discovered, deliberately unattached. */
      unmappedSessions: sessions.filter(
        (session) => !findWorkspaceForProject(mappings, session.projectPath)
      ),

      mapProject: (projectPath: string, workspaceId: string) =>
        setMappings((current) =>
          setProjectMapping(current, projectPath, workspaceId, createTimestamp())
        ),

      unmapProject: (projectPath: string) =>
        setMappings((current) => removeProjectMapping(current, projectPath)),

      /** Polls immediately instead of waiting for the next tick. */
      refresh: () => adapter.refresh(),
    }),
    [adapter, available, mappings, sessions]
  )
}
