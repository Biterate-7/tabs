"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { McpTokenView } from "@/lib/mcp/tokens"

/**
 * The signed-in user's Claude Desktop (MCP) connections.
 *
 * A thin client for /api/mcp/tokens. The one thing it holds that the server
 * never sends twice is `created.token` — the new token, kept in memory only
 * until the user dismisses it, and never written to storage.
 */

export const MCP_TOKENS_ENDPOINT = "/api/mcp/tokens"

export type McpTokensState =
  | { kind: "loading" }
  | { kind: "ready"; tokens: McpTokenView[] }
  | { kind: "signed-out" }
  | { kind: "unavailable" }
  | { kind: "error" }

export type UseMcpTokens = {
  state: McpTokensState
  /** The token just created, shown once. */
  created: { token: string; name: string } | null
  error: string | null
  busy: boolean
  create: (name: string) => Promise<void>
  revoke: (tokenId: string) => Promise<void>
  dismissCreated: () => void
}

type Envelope<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } }

export function useMcpTokens(): UseMcpTokens {
  const [state, setState] = useState<McpTokensState>({ kind: "loading" })
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(MCP_TOKENS_ENDPOINT, { headers: { accept: "application/json" } })
      if (!alive.current) return
      if (response.status === 401) return setState({ kind: "signed-out" })
      if (response.status === 503) return setState({ kind: "unavailable" })
      const body = (await response.json()) as Envelope<{ tokens: McpTokenView[] }>
      if (!alive.current) return
      setState(body.ok ? { kind: "ready", tokens: body.value.tokens } : { kind: "error" })
    } catch {
      if (alive.current) setState({ kind: "error" })
    }
  }, [])

  useEffect(() => {
    /*
      Synchronizing with an external system on mount: which connections this
      user holds is for the server to report. Same reasoning, and the same
      directive, as use-provider-connections.
    */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const create = useCallback(
    async (name: string) => {
      setBusy(true)
      setError(null)
      try {
        const response = await fetch(MCP_TOKENS_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        })
        const body = (await response.json()) as Envelope<{ token: string; connection: McpTokenView }>
        if (!body.ok) {
          setError(body.error?.message ?? "TabDump could not create that connection.")
          return
        }
        setCreated({ token: body.value.token, name: body.value.connection.name })
        await refresh()
      } catch {
        setError("TabDump could not create that connection.")
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const revoke = useCallback(
    async (tokenId: string) => {
      setBusy(true)
      setError(null)
      try {
        const response = await fetch(MCP_TOKENS_ENDPOINT, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tokenId }),
        })
        if (!response.ok) setError("TabDump could not revoke that connection.")
        await refresh()
      } catch {
        setError("TabDump could not revoke that connection.")
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  return { state, created, error, busy, create, revoke, dismissCreated: () => setCreated(null) }
}
