"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { getConnectorManager } from "@/lib/agents/connectors/app-manager"
import type { ConnectorManager, ConnectorView } from "@/lib/agents/connectors/manager"
import type { AgentProviderId } from "@/lib/agents/connectors/types"

/**
 * React access to the connector layer.
 *
 * Thin on purpose. The manager owns every connector, its own lifecycle and
 * the user's persisted intent; this hook subscribes to it, re-reads the view
 * models when something changes, and exposes the two actions a user can take.
 * It owns no connector, starts no timer and holds no state that could drift
 * out of step with the manager's.
 *
 * Safe to mount on more than one surface at once — the settings page and the
 * workspace both do. Each mount adds one status listener and removes it on
 * unmount; neither constructs anything, so there is no version of this where
 * opening settings starts a second poll against the user's machine.
 */

export type UseAgentConnectorsOptions = {
  /**
   * Whether to connect what the user previously enabled.
   *
   * Off by default, and the default is the important one: a surface that only
   * *displays* connector state must not be the thing that starts observation.
   * Exactly one mount in the app passes true.
   */
  restore?: boolean
  /** Injected in tests so a suite can drive a manager it owns. */
  manager?: ConnectorManager
}

export type AgentConnectorsApi = {
  /** One view per registered provider, in catalog order. */
  connectors: ConnectorView[]
  view: (provider: AgentProviderId) => ConnectorView | undefined
  connect: (provider: AgentProviderId) => Promise<void>
  disconnect: (provider: AgentProviderId) => void
  /** Providers the user has enabled, whatever state they are actually in. */
  enabledCount: number
  /** Providers currently reporting `connected`. Never inferred from intent. */
  connectedCount: number
  manager: ConnectorManager
}

export function useAgentConnectors(
  options: UseAgentConnectorsOptions = {}
): AgentConnectorsApi {
  const { restore = false } = options

  /**
   * The manager, resolved once.
   *
   * Lazy state rather than a ref so it is never written during render, and so
   * its identity is stable — which is what keeps the subscription effect
   * below from tearing down and re-establishing on every render.
   */
  const [manager] = useState<ConnectorManager>(() => options.manager ?? getConnectorManager())

  /**
   * A counter, not a copy of the views.
   *
   * The views are derived from live connector state, so storing them would
   * mean holding a snapshot that the manager could move past. Bumping a
   * version on every status change and re-deriving keeps one source of truth
   * and makes a stale render impossible.
   */
  const [version, setVersion] = useState(0)

  useEffect(() => {
    return manager.watchStatus(() => setVersion((current) => current + 1))
  }, [manager])

  useEffect(() => {
    if (!restore) return
    void manager.restore()
  }, [manager, restore])

  const connectors = useMemo(() => {
    // `version` is the dependency that matters: it is what says the
    // underlying connector state moved.
    void version
    return manager.list()
  }, [manager, version])

  const connect = useCallback(
    async (provider: AgentProviderId) => {
      await manager.connect(provider)
      // Connecting settles into a state the status watcher may already have
      // reported; bumping again is cheap and guarantees the final state is
      // rendered even for a connector that never emitted a transition.
      setVersion((current) => current + 1)
    },
    [manager]
  )

  const disconnect = useCallback(
    (provider: AgentProviderId) => {
      manager.disconnect(provider)
      setVersion((current) => current + 1)
    },
    [manager]
  )

  return useMemo(
    () => ({
      connectors,
      view: (provider: AgentProviderId) => connectors.find((entry) => entry.descriptor.provider === provider),
      connect,
      disconnect,
      enabledCount: connectors.filter((entry) => entry.enabled).length,
      connectedCount: connectors.filter((entry) => entry.status.kind === "connected").length,
      manager,
    }),
    [connectors, connect, disconnect, manager]
  )
}
