"use client"

import { useState } from "react"
import { Copy, MonitorSmartphone } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useMcpTokens } from "@/hooks/use-mcp-tokens"

/**
 * Claude Desktop (MCP) — lets Claude Desktop read the user's synced Hubble.
 *
 * Read-only by construction on the server (see src/lib/mcp). This card only
 * mints and revokes the Hubble token that authorises it. The token appears
 * once, beside the exact config snippet that uses it, and is never stored in
 * the browser.
 */

export function claudeDesktopConfigSnippet(token: string, origin: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        hubble: {
          command: "node",
          args: ["<path to Hubble>/scripts/tabdump-mcp-bridge.mjs"],
          env: { TABDUMP_MCP_TOKEN: token, TABDUMP_MCP_URL: `${origin}/api/mcp` },
        },
      },
    },
    null,
    2
  )
}

function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

export function ClaudeDesktopMcpCard() {
  const mcp = useMcpTokens()
  const [name, setName] = useState("Claude Desktop")
  const [copied, setCopied] = useState(false)

  const origin = typeof window === "undefined" ? "" : window.location.origin
  const live = mcp.state.kind === "ready" ? mcp.state.tokens.filter((token) => !token.revoked) : []

  return (
    <div className="rounded-md border border-border p-4" data-testid="claude-desktop-mcp">
      <div className="flex items-center gap-2">
        <MonitorSmartphone className="size-4 text-tertiary" aria-hidden />
        <p className="text-body-sm font-medium text-foreground">Claude Desktop (MCP)</p>
      </div>
      <p className="mt-1 text-meta text-tertiary">
        Let Claude Desktop read your synced workspaces, tabs and collections. Read-only: it cannot change anything in
        Hubble or run anything.
      </p>

      {mcp.state.kind === "loading" && <p className="mt-3 text-meta text-tertiary">Loading…</p>}
      {mcp.state.kind === "signed-out" && (
        <p className="mt-3 text-meta text-tertiary">Sign in to connect Claude Desktop to your synced workspaces.</p>
      )}
      {mcp.state.kind === "unavailable" && (
        <p className="mt-3 text-meta text-tertiary">Claude Desktop connections are not available on this deployment.</p>
      )}
      {mcp.state.kind === "error" && (
        <p className="mt-3 text-meta text-tertiary">Hubble could not load your Claude Desktop connections.</p>
      )}

      {mcp.created && (
        <div className="mt-3 rounded-md border border-subtle p-3" role="status">
          <p className="text-body-sm font-medium text-foreground">
            Connection “{mcp.created.name}” created. Copy this now — it is shown once.
          </p>
          <p className="mt-1 text-meta text-tertiary">
            Add it to Claude Desktop’s config file (Settings → Developer → Edit Config), then restart Claude Desktop.
          </p>
          <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted p-2 text-meta text-foreground" data-testid="mcp-config-snippet">
            {claudeDesktopConfigSnippet(mcp.created.token, origin)}
          </pre>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(claudeDesktopConfigSnippet(mcp.created!.token, origin))
                setCopied(true)
              }}
            >
              <Copy className="size-3.5" aria-hidden />
              {copied ? "Copied" : "Copy config"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setCopied(false)
                mcp.dismissCreated()
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )}

      {mcp.state.kind === "ready" && (
        <>
          {live.length > 0 && (
            <ul className="mt-3 divide-y divide-subtle" aria-label="Claude Desktop connections">
              {live.map((token) => (
                <li key={token.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-body-sm text-foreground">{token.name}</p>
                    <p className="text-meta text-tertiary">
                      …{token.hint} · created {formatDate(token.createdAt)} · expires {formatDate(token.expiresAt)}
                      {token.lastUsedAt ? ` · last used ${formatDate(token.lastUsedAt)}` : " · never used"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={mcp.busy}
                    onClick={() => void mcp.revoke(token.id)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setCopied(false)
              void mcp.create(name)
            }}
          >
            <Input
              aria-label="Connection name"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              className="h-8 max-w-60"
            />
            <Button type="submit" size="sm" disabled={mcp.busy || !name.trim()}>
              Connect Claude Desktop
            </Button>
          </form>
        </>
      )}

      {mcp.error && (
        <p className="mt-2 text-meta text-destructive" role="alert">
          {mcp.error}
        </p>
      )}
    </div>
  )
}
