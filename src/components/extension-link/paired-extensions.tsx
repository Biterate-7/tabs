"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { FieldRow } from "@/components/settings/sections/section-ui"
import { formatRelativeTime } from "@/lib/time-format"
import type { DesktopExtensionLink } from "@/lib/platform"

export type PairedExtensionsApi = {
  list(): Promise<DesktopExtensionLink[]>
  revoke(id: string): Promise<boolean>
}

type State = { kind: "loading" } | { kind: "ready"; links: DesktopExtensionLink[]; now: number } | { kind: "error" }

/**
 * Settings → Chrome extension on Hubble Desktop: each Hubble for Chrome
 * paired with this app, with Disconnect. Disconnecting deletes its token
 * here, so it can't ask or save anything until it is paired again.
 */
export function PairedExtensions({ api }: { api: PairedExtensionsApi }) {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState({ kind: "ready", links: await api.list(), now: Date.now() })
    } catch {
      setState({ kind: "error" })
    }
  }, [api])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading Rust's list on mount
    void load()
  }, [load])

  async function disconnect(link: DesktopExtensionLink) {
    setBusy(link.id)
    try {
      await api.revoke(link.id)
      toast.success("Disconnected Hubble for Chrome")
    } catch {
      toast.error("Couldn't disconnect it. Try again.")
    } finally {
      setBusy(null)
      await load()
    }
  }

  if (state.kind === "loading") return null
  if (state.kind === "error") {
    return (
      <FieldRow label="Connected" description="Couldn't read the connected extensions.">
        <span />
      </FieldRow>
    )
  }
  if (state.links.length === 0) {
    return (
      <FieldRow label="Connected" description="Not connected yet. In Chrome, open Hubble for Chrome and choose Connect to Hubble Desktop.">
        <span />
      </FieldRow>
    )
  }
  const { now } = state
  return (
    <>
      {state.links.map((link) => (
        <FieldRow
          key={link.id}
          label={link.label}
          description={`Connected ${formatRelativeTime(link.createdAt, now)?.toLowerCase() ?? ""}${link.lastUsedAt ? ` · used ${formatRelativeTime(link.lastUsedAt, now)?.toLowerCase() ?? ""}` : ""} · extension ${link.extensionId.slice(0, 8)}…`}
        >
          <Button type="button" variant="outline" size="sm" disabled={busy === link.id} onClick={() => void disconnect(link)}>
            {busy === link.id ? "Disconnecting…" : "Disconnect"}
          </Button>
        </FieldRow>
      ))}
    </>
  )
}
