"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  AgentProviderId,
  CredentialValidation,
  ProviderAuthMethod,
  ProviderConnectionView,
} from "@/lib/agents/credentials/types"

/**
 * The browser's handle on the user's own provider connections.
 *
 * ## The rule this file exists to make structural
 *
 * A credential goes **out** of this hook and never comes back in. `connect`
 * and `rotate` take a secret, put it in one request body, and let it fall out
 * of scope when the call returns. Nothing here stores one: not in state, not
 * in a ref, not in `localStorage`, not in a memo, and not in the returned
 * object.
 *
 * That matters because React state is the most ordinary way a secret ends up
 * somewhere it should not be — a devtools inspection, a component tree
 * snapshot, an error boundary that serializes props, a re-render that keeps a
 * value alive for the life of a tab. The field's value lives in the DOM node
 * the user typed it into, for as long as that dialog is mounted, and that is
 * the whole of its client-side lifetime. `security.test.ts` asserts that this
 * file names no storage API.
 *
 * ## What the server sends back
 *
 * `ProviderConnectionView` — id, provider, auth method, display name, status,
 * timestamps. There is no credential on it, no prefix of one, and no length.
 * A masked prefix is a habit borrowed from dashboards that can revoke a key
 * from the same screen; showing four characters would buy recognition at the
 * cost of putting part of somebody's secret into every screenshot.
 */

export const PROVIDER_CONNECTIONS_ENDPOINT = "/api/agents/provider-connections"

export type ConnectInput = {
  provider: AgentProviderId
  authMethod?: ProviderAuthMethod
  /** Leaves this function's scope in one request body and is never retained. */
  secret: string
  displayName?: string
}

export type ConnectOutcome =
  | { ok: true; connection: ProviderConnectionView }
  | { ok: false; validation: CredentialValidation }

/**
 * A provider that can be connected, as the registry describes it.
 *
 * Server-derived. The UI renders this rather than a table of its own, so a
 * provider gains a Connect button when an adapter is registered for it and not
 * a moment earlier.
 */
export type ConnectableProvider = {
  provider: AgentProviderId
  authMethods: readonly ProviderAuthMethod[]
  input: {
    label: string
    placeholder: string
    issueUrl: string
    explanation: string
  }
}

export type UseProviderConnections = {
  connections: readonly ProviderConnectionView[]
  /** Which providers TabDump can hold credentials for, from the server's registry. */
  connectable: readonly ConnectableProvider[]
  loading: boolean
  /** The deployment cannot store credentials at all. Distinct from "you have none". */
  unavailable: boolean
  /** Whether connections survive a restart here. Rendered, so nobody is surprised. */
  durable: boolean
  /** True while a connect, rotate, revalidate or disconnect is in flight. */
  busy: boolean
  refresh: () => Promise<void>
  connect: (input: ConnectInput) => Promise<ConnectOutcome>
  rotate: (connectionId: string, secret: string) => Promise<ConnectOutcome>
  revalidate: (connectionId: string) => Promise<ConnectOutcome>
  disconnect: (connectionId: string) => Promise<boolean>
  /** This user's connection for a provider, if any. The session-start question. */
  forProvider: (provider: AgentProviderId) => ProviderConnectionView | undefined
  /** How to ask this user for that provider's credential, if TabDump can at all. */
  connectableFor: (provider: AgentProviderId) => ConnectableProvider | undefined
}

/**
 * The failure a request that never reached the service produces.
 *
 * Network errors and malformed responses both land here. `validation_failed`
 * rather than `invalid_credentials`, because a request that did not arrive
 * proves nothing about the key and telling somebody to regenerate a working
 * credential is the worse mistake.
 */
const TRANSPORT_FAILURE: CredentialValidation = {
  code: "validation_failed",
  message: "TabDump could not verify those credentials.",
}

export function useProviderConnections(): UseProviderConnections {
  const [connections, setConnections] = useState<readonly ProviderConnectionView[]>([])
  const [connectable, setConnectable] = useState<readonly ConnectableProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [durable, setDurable] = useState(false)
  const [busy, setBusy] = useState(false)

  // Guards a `setState` after unmount, and guards the list against a stale
  // response overwriting a newer one — the same pattern `use-remote-projects`
  // uses for the same two reasons.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(PROVIDER_CONNECTIONS_ENDPOINT, {
        method: "GET",
        headers: { accept: "application/json" },
      })

      if (!alive.current) return

      if (!response.ok) {
        // A 503 is the deployment saying it cannot hold credentials. Anything
        // else is treated the same way here: the user cannot connect, and the
        // settings page needs to say so rather than show an empty list that
        // looks like "you have none yet".
        setUnavailable(true)
        setConnections([])
        return
      }

      const body = (await response.json()) as {
        ok?: boolean
        value?: {
          connections?: ProviderConnectionView[]
          connectable?: ConnectableProvider[]
          durable?: boolean
        }
      }

      if (!alive.current) return

      setUnavailable(false)
      setConnections(body.value?.connections ?? [])
      setConnectable(body.value?.connectable ?? [])
      setDurable(body.value?.durable === true)
    } catch {
      if (!alive.current) return
      setUnavailable(true)
      setConnections([])
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    /*
      Synchronizing with an external system on mount, which is what effects are
      for: which connections this user holds is the server's to report, and
      there is no way to derive it during render. Same reasoning, and same
      directive, as `use-remote-projects`' list effect.
    */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  /**
   * One mutation, one shape.
   *
   * Every caller below routes through this, so there is exactly one place
   * that builds a request body containing a secret and exactly one place that
   * reads a response — which is what makes "no credential is retained" a
   * property you can check by reading forty lines rather than four hundred.
   */
  const mutate = useCallback(
    async (body: Record<string, unknown>): Promise<ConnectOutcome> => {
      setBusy(true)
      try {
        const response = await fetch(PROVIDER_CONNECTIONS_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })

        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; value?: { connection?: ProviderConnectionView }; validation?: CredentialValidation }
          | null

        if (!payload) return { ok: false, validation: TRANSPORT_FAILURE }

        if (payload.ok && payload.value?.connection) {
          const connection = payload.value.connection
          // Replace this provider's row rather than appending: the server
          // enforces one connection per provider per user, and a list that
          // grew here would drift from what a refresh returns.
          if (alive.current) {
            setConnections((current) => [
              connection,
              ...current.filter((existing) => existing.id !== connection.id && existing.provider !== connection.provider),
            ])
          }
          return { ok: true, connection }
        }

        return { ok: false, validation: payload.validation ?? TRANSPORT_FAILURE }
      } catch {
        return { ok: false, validation: TRANSPORT_FAILURE }
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    []
  )

  const connect = useCallback(
    (input: ConnectInput) =>
      mutate({
        action: "connect",
        provider: input.provider,
        ...(input.authMethod ? { authMethod: input.authMethod } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        secret: input.secret,
      }),
    [mutate]
  )

  const rotate = useCallback(
    (connectionId: string, secret: string) => mutate({ action: "rotate", connectionId, secret }),
    [mutate]
  )

  const revalidate = useCallback(
    (connectionId: string) => mutate({ action: "revalidate", connectionId }),
    [mutate]
  )

  const disconnect = useCallback(async (connectionId: string): Promise<boolean> => {
    setBusy(true)
    try {
      const response = await fetch(PROVIDER_CONNECTIONS_ENDPOINT, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId }),
      })

      if (!response.ok) return false
      if (alive.current) {
        setConnections((current) => current.filter((existing) => existing.id !== connectionId))
      }
      return true
    } catch {
      return false
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])

  const forProvider = useCallback(
    (provider: AgentProviderId) => connections.find((entry) => entry.provider === provider),
    [connections]
  )

  const connectableFor = useCallback(
    (provider: AgentProviderId) => connectable.find((entry) => entry.provider === provider),
    [connectable]
  )

  return useMemo(
    () => ({
      connections,
      connectable,
      loading,
      unavailable,
      durable,
      busy,
      refresh,
      connect,
      rotate,
      revalidate,
      disconnect,
      forProvider,
      connectableFor,
    }),
    [
      connections,
      connectable,
      loading,
      unavailable,
      durable,
      busy,
      refresh,
      connect,
      rotate,
      revalidate,
      disconnect,
      forProvider,
      connectableFor,
    ]
  )
}
