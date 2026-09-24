"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { PLATFORM_PROVIDERS, platformProvider } from "@/lib/agents/platform/catalog"
import { createPlatformConnector } from "@/lib/agents/platform/connector"
import { connectionPhase, phaseSentence, sessionAvailability } from "@/lib/agents/platform/lifecycle"
import {
  EMPTY_ROSTER,
  approveAgent,
  forgetAgent,
  identityFor,
  loadAgentRoster,
  recordAgentSession,
  saveAgentRoster,
} from "@/lib/agents/platform/roster"
import type { PlatformSurface } from "@/lib/agents/platform/catalog"
import type { AgentPlatformConnector } from "@/lib/agents/platform/connector"
import type { ConnectionPhase } from "@/lib/agents/platform/lifecycle"
import type { AgentIdentity, AgentRoster } from "@/lib/agents/platform/roster"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { AgentPermissionScope } from "@/lib/agents/control/permissions"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type {
  ProviderConnectionView,
  ProviderDetection,
  RuntimeErrorCode,
  RuntimeProviderStatus,
  RuntimeStatus,
} from "@/lib/agents/runtime/protocol"

/**
 * The agent connector platform, as a React surface (Phase J).
 *
 * Holds the three things the connect flow and the roster need and nothing
 * else: the persisted roster of connected agents, what the runtime last said
 * is installed on this machine, and what each agent last said about its
 * connection. Every phase shown anywhere is *derived* from those three plus
 * the runtime status the caller already has — see `connectionPhase` — so no
 * component holds its own idea of whether an agent is connected.
 *
 * Every action goes through `AgentPlatformConnector`, whose one implementation
 * speaks the typed runtime protocol. There is no provider branch in this hook.
 */

export type UseAgentPlatform = {
  roster: AgentRoster
  /** `null` until the machine has been asked. */
  detections: readonly ProviderDetection[] | null
  /** Whether the runtime is on this machine, so detection means something. */
  thisMachine: boolean
  connections: Partial<Record<AgentProviderId, ProviderConnectionView>>
  /** The provider an action is in flight for. */
  pending: AgentProviderId | null
  /** Which action that is — so reaching an agent and waiting on its sign-in read differently. */
  pendingAction: PendingAction | null
  errors: Partial<Record<AgentProviderId, RuntimeErrorCode>>
  /** Where TabDump is running, for connectors that only work on one surface. */
  surface: PlatformSurface
  connectorFor: (provider: AgentProviderId) => AgentPlatformConnector
  phaseOf: (provider: AgentProviderId) => ConnectionPhase
  /** The one sentence a person reads about where this agent stands. */
  sentenceOf: (provider: AgentProviderId) => string
  /** Whether TabDump will start a session with it, and if not, why. */
  sessionsFor: (provider: AgentProviderId) => { available: true } | { available: false; reason: string }
  /** The runtime's latest word on a provider: a connect/sign-in reply, else its status. */
  statusOf: (provider: AgentProviderId) => RuntimeProviderStatus | ProviderConnectionView | undefined
  identity: (provider: AgentProviderId) => AgentIdentity | undefined
  detect: () => Promise<void>
  connect: (provider: AgentProviderId) => Promise<boolean>
  authenticate: (provider: AgentProviderId, methodId: string) => Promise<boolean>
  approve: (provider: AgentProviderId, scopes: readonly AgentPermissionScope[]) => void
  disconnect: (provider: AgentProviderId) => Promise<void>
  recordSession: (provider: AgentProviderId, sessionId: string, workspaceId?: string) => void
}

export type PendingAction = "connect" | "authenticate" | "disconnect"

export function useAgentPlatform(options: {
  client: RuntimeClient
  status: RuntimeStatus | null
  /** Whether the user's own provider key is usable, for providers that sign in that way. */
  providerKeyConnected?: (provider: AgentProviderId) => boolean | undefined
  /** Whether a TabDump MCP token exists, for the MCP client. */
  mcpTokenIssued?: boolean
  /** Where TabDump is running. Absent means the web. */
  surface?: PlatformSurface
  now?: () => number
}): UseAgentPlatform {
  const { client, status, providerKeyConnected, mcpTokenIssued } = options
  const surface = options.surface ?? "web"
  const now = options.now ?? Date.now

  // Read once, lazily, exactly as the control plane's projects are
  // (use-agent-projects): the command centre renders only in the browser.
  const [roster, setRoster] = useState<AgentRoster>(() =>
    typeof window === "undefined" ? EMPTY_ROSTER : loadAgentRoster()
  )
  const [detections, setDetections] = useState<readonly ProviderDetection[] | null>(null)
  const [thisMachine, setThisMachine] = useState(false)
  const [connections, setConnections] = useState<Partial<Record<AgentProviderId, ProviderConnectionView>>>({})
  const [pending, setPending] = useState<AgentProviderId | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [errors, setErrors] = useState<Partial<Record<AgentProviderId, RuntimeErrorCode>>>({})
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const update = useCallback((next: (current: AgentRoster) => AgentRoster) => {
    setRoster((current) => {
      const updated = next(current)
      saveAgentRoster(updated)
      return updated
    })
  }, [])

  const connectors = useMemo(() => {
    const map = new Map<AgentProviderId, AgentPlatformConnector>()
    for (const entry of PLATFORM_PROVIDERS) map.set(entry.provider, createPlatformConnector(entry.provider, client))
    return map
  }, [client])

  const connectorFor = useCallback((provider: AgentProviderId) => connectors.get(provider)!, [connectors])

  const setError = useCallback((provider: AgentProviderId, code: RuntimeErrorCode | undefined) => {
    setErrors((current) => {
      const next = { ...current }
      if (code) next[provider] = code
      else delete next[provider]
      return next
    })
  }, [])

  const detect = useCallback(async () => {
    if (!status?.executable) return
    const reply = await client.send({ name: "detect_providers" })
    if (!alive.current || !reply.ok) return
    setThisMachine(reply.value.thisMachine)
    setDetections(reply.value.detections)
  }, [client, status?.executable])

  // Asked once the runtime is known to execute. Detection is a PATH walk on
  // the server — cheap, and it runs nothing.
  useEffect(() => {
    if (!status?.executable) return
    void detect()
  }, [detect, status?.executable])

  const run = useCallback(
    async (
      provider: AgentProviderId,
      kind: PendingAction,
      action: () => Promise<{ ok: true; value: ProviderConnectionView } | { ok: false; error: { code: RuntimeErrorCode } }>
    ): Promise<boolean> => {
      setPending(provider)
      setPendingAction(kind)
      setError(provider, undefined)
      try {
        const reply = await action()
        if (!alive.current) return false
        if (!reply.ok) {
          setError(provider, reply.error.code)
          return false
        }
        setConnections((current) => ({ ...current, [provider]: reply.value }))
        return true
      } finally {
        if (alive.current) {
          setPending(null)
          setPendingAction(null)
        }
      }
    },
    [setError]
  )

  const connect = useCallback(
    (provider: AgentProviderId) => run(provider, "connect", () => connectorFor(provider).connect()),
    [connectorFor, run]
  )

  const authenticate = useCallback(
    (provider: AgentProviderId, methodId: string) =>
      run(provider, "authenticate", () => connectorFor(provider).authenticate(methodId)),
    [connectorFor, run]
  )

  /*
    Agents the user already approved are asked, once per runtime, whether
    they are still signed in — so "Connected" after a restart is the agent's
    answer today rather than an approval remembered from last week (Phase
    J.2). Only installed agents that TabDump can start, one at a time, and
    never an MCP client, which TabDump does not start.
  */
  const refreshedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!status?.executable || !detections) return
    if (refreshedFor.current === status.runtimeId) return
    refreshedFor.current = status.runtimeId
    const approved = roster.agents
      .map((agent) => agent.provider)
      .filter((provider) => {
        const spec = platformProvider(provider)
        if (!spec || spec.transport === "mcp") return false
        const detection = detections.find((entry) => entry.provider === provider)
        return spec.transport === "sdk" ? Boolean(detection?.installed || status.environment !== "local") : Boolean(detection?.launchable)
      })
    void (async () => {
      for (const provider of approved) {
        if (!alive.current) return
        await connect(provider)
      }
    })()
  }, [connect, detections, roster.agents, status])

  const approve = useCallback(
    (provider: AgentProviderId, scopes: readonly AgentPermissionScope[]) => {
      const spec = platformProvider(provider)
      update((current) => approveAgent(current, { provider, name: spec?.displayName ?? provider, scopes, now: now() }))
    },
    [now, update]
  )

  const disconnect = useCallback(
    async (provider: AgentProviderId) => {
      const spec = platformProvider(provider)
      // An MCP client has no runtime connection to end; forgetting it is the
      // whole of disconnecting. Its token is revoked in Settings, where it lives.
      if (spec && spec.transport !== "mcp" && status?.executable) {
        await run(provider, "disconnect", () => connectorFor(provider).disconnect())
      }
      if (!alive.current) return
      update((current) => forgetAgent(current, provider))
      setConnections((current) => {
        const next = { ...current }
        delete next[provider]
        return next
      })
    },
    [connectorFor, run, status?.executable, update]
  )

  const recordSession = useCallback(
    (provider: AgentProviderId, sessionId: string, workspaceId?: string) => {
      update((current) =>
        recordAgentSession(current, { provider, sessionId, ...(workspaceId ? { workspaceId } : {}), now: now() })
      )
    },
    [now, update]
  )

  const identity = useCallback((provider: AgentProviderId) => identityFor(roster, provider), [roster])

  const statusOf = useCallback(
    (provider: AgentProviderId) =>
      connections[provider] ?? status?.providers.find((entry) => entry.provider === provider),
    [connections, status]
  )

  const phaseOf = useCallback(
    (provider: AgentProviderId): ConnectionPhase => {
      const spec = platformProvider(provider)
      if (!spec) return "error"
      const reported = statusOf(provider)
      const detection = detections?.find((entry) => entry.provider === provider)
      const approved = identityFor(roster, provider)
      const keyConnected = providerKeyConnected?.(provider)
      return connectionPhase({
        provider: spec,
        surface,
        connecting: pending === provider && pendingAction === "connect",
        authenticating: pending === provider && pendingAction === "authenticate",
        executable: status?.executable ?? false,
        local: status?.environment === "local",
        ...(detection ? { detection } : {}),
        ...(reported ? { status: reported } : {}),
        ...(keyConnected !== undefined ? { providerKeyConnected: keyConnected } : {}),
        ...(mcpTokenIssued !== undefined ? { mcpTokenIssued } : {}),
        ...(approved ? { approvedScopes: approved.approvedScopes } : {}),
      })
    },
    [detections, mcpTokenIssued, pending, pendingAction, providerKeyConnected, roster, status, statusOf, surface]
  )

  const sentenceOf = useCallback(
    (provider: AgentProviderId): string => {
      const spec = platformProvider(provider)
      if (!spec) return ""
      const installed = detections?.find((entry) => entry.provider === provider)?.installed
      return phaseSentence(spec, phaseOf(provider), { surface, ...(installed !== undefined ? { installed } : {}) })
    },
    [detections, phaseOf, surface]
  )

  const sessionsFor = useCallback(
    (provider: AgentProviderId) => {
      const spec = platformProvider(provider)
      if (!spec) return { available: false as const, reason: "" }
      return sessionAvailability(spec, statusOf(provider))
    },
    [statusOf]
  )

  return {
    roster,
    detections,
    thisMachine,
    connections,
    pending,
    pendingAction,
    errors,
    surface,
    connectorFor,
    phaseOf,
    sentenceOf,
    sessionsFor,
    statusOf,
    identity,
    detect,
    connect,
    authenticate,
    approve,
    disconnect,
    recordSession,
  }
}
