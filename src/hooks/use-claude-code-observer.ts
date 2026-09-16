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
import {
  ingestObservationBatch,
  resolveProviderAgentId,
} from "@/lib/agents/connectors/ingest"
import { createTimestamp } from "@/lib/timestamps"
import type { ClaudeCodeAdapter, ClaudeCodeAdapterOptions } from "@/lib/agents/claude-code/adapter"
import type { ProjectMappingState } from "@/lib/agents/claude-code/mapping"
import type { ClaudeDiscoveredSession } from "@/lib/agents/claude-code/types"
import type { ClaudeCodeConnector } from "@/lib/agents/connectors/providers/claude-code"
import type { AgentAdapterObservation } from "@/lib/agents/adapter"
import type { useAgentStore } from "./use-agent-store"

/**
 * Binds Claude Code observation to the agent store.
 *
 * Its whole job is the joining-up: take observations from a Claude Code
 * source, attach a workspace from the explicit mapping, and hand them to the
 * domain. It parses nothing, reads no files, and knows no transcript format —
 * those live on the server side of `src/lib/agents/claude-code/`.
 *
 * Nor does it reimplement any rule. The domain's — run identity,
 * terminal-status protection, event retention, sticky metadata, workspace
 * validation — are reached through `store.ingest` and `store.addRunLink`. The
 * connector layer's — agent identity per provider, batch folding, URL
 * linking — come from `connectors/ingest.ts`, which is provider-neutral and
 * shared with every future provider binding. What is genuinely Claude Code's
 * and lives here is exactly one thing: the project-to-workspace mapping
 * policy, and the session list the user maps with.
 *
 * ## Where the observations come from
 *
 * Preferably from the connector the manager owns — pass `connector`, and this
 * hook subscribes to it rather than starting anything, so the app has one
 * Claude Code poll loop whose lifecycle the user controls from settings.
 *
 * Without one it falls back to constructing its own adapter, which is what
 * the tests exercise and what keeps this hook usable in isolation.
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
  /**
   * The connector the manager owns.
   *
   * When present this hook observes through it and starts nothing of its own,
   * so connecting and disconnecting from settings controls whether anything
   * is read at all. When absent the hook builds its own adapter — the
   * standalone path the tests drive.
   */
  connector?: ClaudeCodeConnector | null
  adapterOptions?: ClaudeCodeAdapterOptions
}

export function useClaudeCodeObserver(options: UseClaudeCodeObserverOptions) {
  const { store, enabled = false, tabIndexes, connector, adapterOptions } = options

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
   * The hook's own adapter — built only when nothing else is supplying
   * observations.
   *
   * Held in state with a lazy initialiser rather than a ref, so it is created
   * exactly once without being written during render — and so its identity is
   * stable, which is what keeps the subscription effect below from tearing
   * down and restarting the poll loop (losing its cursor) on every render.
   *
   * Null when a connector was passed: the manager already owns one, and a
   * second would be a second cursor over the same files.
   */
  const [adapter] = useState<ClaudeCodeAdapter | null>(() =>
    connector
      ? null
      : createClaudeCodeAdapter({
          ...adapterOptions,
          // Session listing and availability arrive with each poll rather
          // than being read back on a timer of our own — one loop for the
          // whole feature, which is the point of the adapter owning the
          // schedule.
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
   * The one genuinely Claude-Code-specific rule in this hook: which workspace
   * a session belongs to.
   *
   * Returns undefined when the project has not been mapped. The domain then
   * reports the observation as `unattached` and creates nothing, which
   * preserves the discovery without inventing a home for it — and the same
   * session attaches on a later poll once the user maps its project.
   */
  const resolveWorkspaceId = useCallback(
    (observation: AgentAdapterObservation): string | undefined => {
      if (!observation.projectKey) return undefined
      return findWorkspaceForProject(mappingsRef.current, observation.projectKey)
    },
    []
  )

  /**
   * Folding observations into the domain, through the provider-neutral path.
   *
   * Agent identity, batch ingestion and URL linking all come from
   * `connectors/ingest.ts` — the same code every future provider binding uses,
   * so none of them can drift into its own idea of what an observation does.
   */
  const handleObservations = useCallback(
    (incoming: AgentAdapterObservation[]) => {
      const agentId = resolveProviderAgentId(
        storeRef.current,
        CLAUDE_CODE_PROVIDER,
        CLAUDE_CODE_AGENT_NAME
      )
      if (!agentId) return

      ingestObservationBatch({
        store: storeRef.current,
        agentId,
        provider: CLAUDE_CODE_PROVIDER,
        observations: incoming,
        resolveWorkspaceId,
        tabIndexes: tabIndexRef.current,
      })
    },
    [resolveWorkspaceId]
  )

  useEffect(() => {
    if (!enabled) return

    // One subscription, one loop. Through the manager's connector when there
    // is one — in which case this hook starts nothing and the user's
    // connect/disconnect decides whether anything is read — and otherwise
    // through the hook's own adapter, which stops its timer as soon as the
    // last subscriber leaves.
    if (connector) return connector.subscribe(handleObservations)
    return adapter?.subscribe(handleObservations)
  }, [adapter, connector, enabled, handleObservations])

  /**
   * Session listing and availability, when the connector is the source.
   *
   * The connector's own status is the availability signal — it is set from
   * the very poll that produced the sessions — so this reads it back on each
   * status change rather than running a second loop to ask again.
   */
  useEffect(() => {
    if (!connector) return

    const sync = () => {
      setSessions(connector.getSessions())
      setAvailable(connector.getStatus().kind === "connected")
    }

    sync()
    return connector.watchStatus(sync)
  }, [connector])

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
      refresh: async () => {
        await (connector ?? adapter)?.refresh()
      },
    }),
    [adapter, connector, available, mappings, sessions]
  )
}
