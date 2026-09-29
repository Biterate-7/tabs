"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { PLATFORM_PROVIDERS, platformProvider } from "@/lib/agents/platform/catalog"
import { createPlatformConnector } from "@/lib/agents/platform/connector"
import {
  connectionPhase,
  describeReadiness,
  phaseSentence,
  sessionAvailability,
  sessionPrerequisite,
} from "@/lib/agents/platform/lifecycle"
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
import type {
  AgentReadiness,
  ConnectionAction,
  ConnectionFacts,
  ConnectionPhase,
  SessionPrerequisite,
} from "@/lib/agents/platform/lifecycle"
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
  /** Where Hubble is running, for connectors that only work on one surface. */
  surface: PlatformSurface
  connectorFor: (provider: AgentProviderId) => AgentPlatformConnector
  phaseOf: (provider: AgentProviderId) => ConnectionPhase
  /** Installed, reachable, signed in, which method, can a session start — derived, no secrets. */
  readinessOf: (provider: AgentProviderId) => AgentReadiness | undefined
  /** The one sentence a person reads about where this agent stands. */
  sentenceOf: (provider: AgentProviderId) => string
  /** Whether Hubble will start a session with it, and if not, why. */
  sessionsFor: (provider: AgentProviderId) => { available: true } | { available: false; reason: string }
  /** Whether a session may start with it now, and if not, the sentence and the action that fix it. */
  prerequisiteFor: (provider: AgentProviderId) => SessionPrerequisite
  /** The runtime's latest word on a provider: a connect/sign-in reply, else its status. */
  statusOf: (provider: AgentProviderId) => RuntimeProviderStatus | ProviderConnectionView | undefined
  identity: (provider: AgentProviderId) => AgentIdentity | undefined
  detect: () => Promise<void>
  connect: (provider: AgentProviderId) => Promise<boolean>
  /** Asks again after a failure — re-handshaking first when the runtime was lost. */
  retry: (provider: AgentProviderId) => Promise<boolean>
  authenticate: (provider: AgentProviderId, methodId: string) => Promise<boolean>
  approve: (provider: AgentProviderId, scopes: readonly AgentPermissionScope[]) => void
  disconnect: (provider: AgentProviderId) => Promise<void>
  recordSession: (provider: AgentProviderId, sessionId: string, workspaceId?: string) => void
}

export type PendingAction = "connect" | "authenticate" | "disconnect"

/**
 * How long the runtime may keep *reporting* an agent as `connecting` before
 * Hubble calls it a timeout (Agent Authentication & Runtime). The requests
 * this surface sends are bounded by the runtime client; this bounds the one
 * transient state a status poll can carry, so no row says "Connecting…" for
 * longer than this.
 */
export const CONNECTING_STALL_MS = 30_000

export function useAgentPlatform(options: {
  client: RuntimeClient
  status: RuntimeStatus | null
  /** Whether the user's own provider key is usable, for providers that sign in that way. */
  providerKeyConnected?: (provider: AgentProviderId) => boolean | undefined
  /** Whether a Hubble MCP token exists, for the MCP client. */
  mcpTokenIssued?: boolean
  /** Where Hubble is running. Absent means the web. */
  surface?: PlatformSurface
  now?: () => number
  /** Overrides `CONNECTING_STALL_MS`. For tests. */
  stallMs?: number
}): UseAgentPlatform {
  const { client, status, providerKeyConnected, mcpTokenIssued } = options
  const surface = options.surface ?? "web"
  const now = options.now ?? Date.now
  const stallMs = options.stallMs ?? CONNECTING_STALL_MS

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
  /*
    How the last connect or sign-in failed, per provider — what turns a
    failure into a terminal phase (timeout, sign-in failed, connection lost)
    rather than a banner beside a stale one. Keyed by provider, so one agent's
    failure can never colour another's state.
  */
  const [failures, setFailures] = useState<Partial<Record<AgentProviderId, { action: ConnectionAction; code: RuntimeErrorCode }>>>({})
  /* Providers the runtime kept reporting as `connecting` past the deadline. */
  const [stalled, setStalled] = useState<ReadonlySet<AgentProviderId>>(() => new Set())
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

  const setFailure = useCallback(
    (provider: AgentProviderId, failure: { action: ConnectionAction; code: RuntimeErrorCode } | undefined) => {
      setFailures((current) => {
        if (!failure && !(provider in current)) return current
        const next = { ...current }
        if (failure) next[provider] = failure
        else delete next[provider]
        return next
      })
    },
    []
  )

  const run = useCallback(
    async (
      provider: AgentProviderId,
      kind: PendingAction,
      action: () => Promise<{ ok: true; value: ProviderConnectionView } | { ok: false; error: { code: RuntimeErrorCode } }>
    ): Promise<boolean> => {
      setPending(provider)
      setPendingAction(kind)
      setError(provider, undefined)
      // A new attempt replaces the last one's outcome. Only this provider's.
      setFailure(provider, undefined)
      try {
        const reply = await action()
        if (!alive.current) return false
        if (!reply.ok) {
          setError(provider, reply.error.code)
          if (kind !== "disconnect") setFailure(provider, { action: kind, code: reply.error.code })
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
    [setError, setFailure]
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
    Asks the agent again after a failure. When the runtime itself was lost (a
    restart), the client has forgotten which runtime it spoke to, and every
    command would be refused until it handshakes — so it handshakes first.
    The same connect otherwise: bounded, and it settles into a phase.
  */
  const retry = useCallback(
    async (provider: AgentProviderId) => {
      if (!client.runtimeId() || failures[provider]?.code === "runtime_disconnected") await client.status()
      return connect(provider)
    },
    [client, connect, failures]
  )

  /*
    Agents the user already approved are asked, once per runtime, whether
    they are still signed in — so "Connected" after a restart is the agent's
    answer today rather than an approval remembered from last week (Phase
    J.2). Only installed agents that Hubble can start, one at a time, and
    never an MCP client, which Hubble does not start.
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

  /*
    The watchdog (Agent Authentication & Runtime). Every request this hook
    sends is bounded by the runtime client, but a *status* can still say
    `connecting` — and on a hosted runtime it once said so forever. A
    provider still reported as connecting after `stallMs` is shown as a
    timeout with a Retry, never as "Connecting…" indefinitely.
  */
  const connectingKey = PLATFORM_PROVIDERS.filter((entry) => statusOf(entry.provider)?.connection === "connecting")
    .map((entry) => entry.provider)
    .join(",")
  useEffect(() => {
    const connecting = connectingKey ? (connectingKey.split(",") as AgentProviderId[]) : []
    // Synchronizing with the runtime's report: a provider that stopped
    // connecting is no longer stalled.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStalled((current) => {
      const kept = [...current].filter((provider) => connecting.includes(provider))
      return kept.length === current.size ? current : new Set(kept)
    })
    if (connecting.length === 0) return
    const timer = setTimeout(() => {
      if (alive.current) setStalled((current) => new Set([...current, ...connecting]))
    }, stallMs)
    return () => clearTimeout(timer)
  }, [connectingKey, stallMs])

  const factsOf = useCallback(
    (provider: AgentProviderId): ConnectionFacts | undefined => {
      const spec = platformProvider(provider)
      if (!spec) return undefined
      const reported = statusOf(provider)
      const detection = detections?.find((entry) => entry.provider === provider)
      const approved = identityFor(roster, provider)
      const keyConnected = providerKeyConnected?.(provider)
      const failure = failures[provider]
      return {
        provider: spec,
        surface,
        connecting: pending === provider && pendingAction === "connect",
        authenticating: pending === provider && pendingAction === "authenticate",
        ...(failure ? { failure } : {}),
        ...(stalled.has(provider) ? { stalled: true } : {}),
        executable: status?.executable ?? false,
        local: status?.environment === "local",
        ...(detection ? { detection } : {}),
        ...(reported ? { status: reported } : {}),
        ...(keyConnected !== undefined ? { providerKeyConnected: keyConnected } : {}),
        ...(mcpTokenIssued !== undefined ? { mcpTokenIssued } : {}),
        ...(approved ? { approvedScopes: approved.approvedScopes } : {}),
      }
    },
    [detections, failures, mcpTokenIssued, pending, pendingAction, providerKeyConnected, roster, stalled, status, statusOf, surface]
  )

  const phaseOf = useCallback(
    (provider: AgentProviderId): ConnectionPhase => {
      const facts = factsOf(provider)
      return facts ? connectionPhase(facts) : "error"
    },
    [factsOf]
  )

  const readinessOf = useCallback(
    (provider: AgentProviderId): AgentReadiness | undefined => {
      const facts = factsOf(provider)
      return facts ? describeReadiness(facts) : undefined
    },
    [factsOf]
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

  const prerequisiteFor = useCallback(
    (provider: AgentProviderId): SessionPrerequisite => {
      const spec = platformProvider(provider)
      if (!spec) return { ok: false, reason: "" }
      return sessionPrerequisite({
        provider: spec,
        phase: phaseOf(provider),
        approved: Boolean(identityFor(roster, provider)),
        sessions: sessionsFor(provider),
        surface,
      })
    },
    [phaseOf, roster, sessionsFor, surface]
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
    readinessOf,
    sentenceOf,
    sessionsFor,
    prerequisiteFor,
    statusOf,
    identity,
    detect,
    connect,
    retry,
    authenticate,
    approve,
    disconnect,
    recordSession,
  }
}
