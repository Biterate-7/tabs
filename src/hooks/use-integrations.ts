"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { ActivityView } from "@/lib/integrations/activity-labels"
import type { ProjectContextRecord, ProposalStep, ProposalStatus, WorkspaceNoteRecord } from "@/lib/integrations/records"
import type { ConnectionTestResult, ConnectionView } from "@/lib/integrations/service"
import type { IntegrationClient, PermissionLevel } from "@/lib/integrations/scopes"
import type { McpTokenView } from "@/lib/mcp/tokens"

/**
 * The AI Integrations pane's client for /api/integrations.
 *
 * Holds what the server reported and nothing it did not: a connection is
 * "connected" because the server saw the client call Hubble, and a test
 * passed because the server's test said so. The one thing it holds that the
 * server never sends twice is a freshly minted token, kept in memory only
 * until dismissed and never written to storage.
 */

export const INTEGRATIONS_ENDPOINT = "/api/integrations"

export type ProposalViewModel = {
  proposalId: string
  workspaceId: string
  status: ProposalStatus
  tabCount: number
  changes: string[]
  steps: ProposalStep[]
  summary?: string
  createdAt: number
  expiresAt: number
  result?: { verified: boolean }
  failure?: string
  client: IntegrationClient
  clientName: string
  connectionId: string
}

export type IntegrationsData = {
  mcpUrl: string
  connections: ConnectionView[]
  proposals: ProposalViewModel[]
  activity: ActivityView[]
  workspaces: { id: string; name: string; updatedAt: number }[]
  legacyTokens: McpTokenView[]
}

export type IntegrationsState =
  | { kind: "loading" }
  | { kind: "ready"; data: IntegrationsData }
  | { kind: "signed-out" }
  | { kind: "unavailable" }
  | { kind: "error" }

export type CreatedToken = { token: string; connection: ConnectionView }

type Envelope<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } }

async function call<T>(path: string, init?: RequestInit): Promise<{ ok: true; value: T } | { ok: false; message: string; status: number }> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    })
    const body = (await response.json()) as Envelope<T>
    if (body.ok) return { ok: true, value: body.value }
    return { ok: false, message: body.error?.message ?? "Hubble could not do that.", status: response.status }
  } catch {
    return { ok: false, message: "Hubble could not reach the server. Check your connection.", status: 0 }
  }
}

export function useIntegrations(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true
  const [state, setState] = useState<IntegrationsState>({ kind: "loading" })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [tests, setTests] = useState<Record<string, ConnectionTestResult | "running" | { failed: string }>>({})
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const result = await call<IntegrationsData>(INTEGRATIONS_ENDPOINT)
    if (!alive.current) return
    if (result.ok) return setState({ kind: "ready", data: result.value })
    if (result.status === 401) return setState({ kind: "signed-out" })
    if (result.status === 503) return setState({ kind: "unavailable" })
    setState({ kind: "error" })
  }, [])

  useEffect(() => {
    // Synchronizing with the server on mount: which connections exist and
    // what they did is the server's to report.
    if (!enabled) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [enabled, refresh])

  /** Runs one mutation with a busy marker and the server's error sentence, then refreshes. */
  const act = useCallback(
    async <T,>(key: string, path: string, init: RequestInit): Promise<T | undefined> => {
      setBusy(key)
      setError(null)
      try {
        const result = await call<T>(path, init)
        if (!result.ok) {
          setError(result.message)
          return undefined
        }
        await refresh()
        return result.value
      } finally {
        if (alive.current) setBusy(null)
      }
    },
    [refresh]
  )

  const createToken = useCallback(
    async (input: { client: IntegrationClient; label: string; permission: PermissionLevel; workspaceIds: string[] }) => {
      const value = await act<CreatedToken>("create", `${INTEGRATIONS_ENDPOINT}/connections`, { method: "POST", body: JSON.stringify(input) })
      if (value) setCreated(value)
      return value
    },
    [act]
  )

  const updateConnection = useCallback(
    (connectionId: string, patch: { permission?: PermissionLevel; workspaceIds?: string[] }) =>
      act(`update:${connectionId}`, `${INTEGRATIONS_ENDPOINT}/connections`, { method: "PATCH", body: JSON.stringify({ connectionId, ...patch }) }),
    [act]
  )

  const revokeConnection = useCallback(
    (connectionId: string) =>
      act(`revoke:${connectionId}`, `${INTEGRATIONS_ENDPOINT}/connections`, { method: "DELETE", body: JSON.stringify({ connectionId }) }),
    [act]
  )

  const revokeLegacyToken = useCallback(
    (tokenId: string) => act(`legacy:${tokenId}`, "/api/mcp/tokens", { method: "DELETE", body: JSON.stringify({ tokenId }) }),
    [act]
  )

  const decideProposal = useCallback(
    (proposalId: string, action: "approve" | "decline" | "apply") =>
      act(`proposal:${proposalId}`, `${INTEGRATIONS_ENDPOINT}/proposals`, { method: "POST", body: JSON.stringify({ proposalId, action }) }),
    [act]
  )

  const testConnection = useCallback(async (connectionId: string) => {
    setTests((current) => ({ ...current, [connectionId]: "running" }))
    const result = await call<ConnectionTestResult>(`${INTEGRATIONS_ENDPOINT}/test`, { method: "POST", body: JSON.stringify({ connectionId }) })
    if (!alive.current) return
    setTests((current) => ({ ...current, [connectionId]: result.ok ? result.value : { failed: result.message } }))
  }, [])

  return {
    state,
    busy,
    error,
    created,
    tests,
    refresh,
    createToken,
    updateConnection,
    revokeConnection,
    revokeLegacyToken,
    decideProposal,
    testConnection,
    dismissCreated: () => setCreated(null),
    clearError: () => setError(null),
  }
}

export type UseIntegrations = ReturnType<typeof useIntegrations>

export type ProjectMemory = { context: ProjectContextRecord | null; notes: WorkspaceNoteRecord[]; notesTotal: number }

/** What AI clients saved about one workspace, for the person to read and remove. */
export function useProjectMemory(workspaceId: string | null) {
  const [memory, setMemory] = useState<ProjectMemory | "loading" | { failed: string } | null>(null)

  const load = useCallback(async () => {
    if (!workspaceId) return setMemory(null)
    setMemory("loading")
    const result = await call<ProjectMemory>(`${INTEGRATIONS_ENDPOINT}/context?workspaceId=${encodeURIComponent(workspaceId)}`)
    setMemory(result.ok ? result.value : { failed: result.message })
  }, [workspaceId])

  useEffect(() => {
    // Loads when the person picks a workspace.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const remove = useCallback(
    async (target: { noteId?: string }) => {
      if (!workspaceId) return
      await call(`${INTEGRATIONS_ENDPOINT}/context`, { method: "DELETE", body: JSON.stringify({ workspaceId, ...target }) })
      await load()
    },
    [workspaceId, load]
  )

  return { memory, reload: load, deleteNote: (noteId: string) => remove({ noteId }), clear: () => remove({}) }
}
