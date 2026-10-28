"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "@/lib/time-format"
import { FieldRow } from "@/components/settings/sections/section-ui"

type Device = { id: string; label: string; createdAt: number; lastUsedAt: number | null }
/** `now` is when the list was read, so relative times don't read the clock during render. */
type State = { kind: "loading" } | { kind: "ready"; devices: Device[]; now: number } | { kind: "error" }

/**
 * Settings → Account on the web: the Hubble Desktop installs signed in to
 * this account, each with Disconnect — which deletes its device credential
 * (src/lib/auth/device.ts), so that app is signed out on its next request.
 * Renders nothing when there are none.
 */
export function ConnectedDesktops() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/desktop/devices", { credentials: "same-origin", cache: "no-store" })
      const body = (await response.json()) as { devices?: Device[] }
      setState(response.ok && Array.isArray(body.devices) ? { kind: "ready", devices: body.devices, now: Date.now() } : { kind: "error" })
    } catch {
      setState({ kind: "error" })
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading from the server on mount
    void load()
  }, [load])

  async function disconnect(device: Device) {
    setBusy(device.id)
    try {
      const response = await fetch("/api/auth/desktop/devices", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revoke: device.id }),
      })
      if (!response.ok) throw new Error()
      toast.success(`Disconnected ${device.label}`)
      await load()
    } catch {
      toast.error("Couldn't disconnect it. Try again.")
    } finally {
      setBusy(null)
    }
  }

  if (state.kind !== "ready" || state.devices.length === 0) return null
  const { now } = state
  return (
    <>
      {state.devices.map((device) => (
        <FieldRow
          key={device.id}
          label={device.label}
          description={`Signed in ${formatRelativeTime(device.createdAt, now)?.toLowerCase() ?? ""}${device.lastUsedAt ? ` · active ${formatRelativeTime(device.lastUsedAt, now)?.toLowerCase() ?? ""}` : ""}`}
        >
          <Button type="button" variant="outline" size="sm" disabled={busy === device.id} onClick={() => void disconnect(device)}>
            {busy === device.id ? "Disconnecting…" : "Disconnect"}
          </Button>
        </FieldRow>
      ))}
    </>
  )
}
