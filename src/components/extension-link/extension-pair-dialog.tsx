"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { DesktopPairingRequest } from "@/lib/platform"

/** How the dialog reaches Rust (src/lib/platform/desktop.ts `desktopExtensionLink`). */
export type PairingApi = {
  pendingPairings(): Promise<DesktopPairingRequest[]>
  answerPairing(id: string, approve: boolean): Promise<void>
  onPairRequested(handler: () => void): Promise<() => void>
}

/**
 * How long Connect stays unavailable after a request appears. Hubble brings
 * its window to the front for each request, so without this a click the
 * person was already making somewhere else could land on Connect the instant
 * the dialog appears (measured: a trusted click ~0.5 s after it opened).
 */
export const CONNECT_ARM_MS = 1500

/** "482913" → "482 913", as the extension's popup shows it. */
export function formatPairingCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

/**
 * "Connect Hubble for Chrome?" — the person's half of pairing
 * (src-tauri/src/extension_link.rs).
 *
 * Shown when an extension asks to pair (Rust focuses the window and emits
 * the request), and on start-up for a request that arrived first. The code
 * is the one the extension's popup shows, so the person can tell the request
 * they made from one they didn't. Nothing is connected unless they press
 * Connect; closing the dialog declines.
 */
export function ExtensionPairDialog({ api }: { api: PairingApi | undefined }) {
  const [pending, setPending] = useState<DesktopPairingRequest[]>([])
  const [busy, setBusy] = useState(false)
  // The request Connect is armed for: only after it has been on screen CONNECT_ARM_MS.
  const [armedFor, setArmedFor] = useState<string | null>(null)
  const currentId = pending[0]?.id

  useEffect(() => {
    if (!currentId) return
    const timer = setTimeout(() => setArmedFor(currentId), CONNECT_ARM_MS)
    return () => clearTimeout(timer)
  }, [currentId])

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      setPending(await api.pendingPairings())
    } catch {
      // Nothing to show; the extension's attempt simply expires.
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    let active = true
    let unlisten: (() => void) | undefined
    void api.onPairRequested(() => void refresh()).then((stop) => {
      if (active) unlisten = stop
      else stop()
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading what Rust already holds on mount
    void refresh()
    return () => {
      active = false
      unlisten?.()
    }
  }, [api, refresh])

  const current = pending[0]
  if (!api || !current) return null

  const armed = armedFor === current.id

  async function answer(approve: boolean) {
    if (!api || !current) return
    // Belt and braces: an approval that arrives before Connect was armed is not one.
    if (approve && armedFor !== current.id) return
    setBusy(true)
    try {
      await api.answerPairing(current.id, approve)
      if (approve) toast.success("Hubble for Chrome is connected", { description: "It can now save into your projects and use them in AI chats." })
    } catch (error) {
      toast.error("Couldn't answer that request", { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && void answer(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Hubble for Chrome?</DialogTitle>
          <DialogDescription>
            Only connect if you just chose Connect in Hubble for Chrome and it shows this code. Once connected, it can list your projects, save into them, and bring what you saved into an AI chat.
          </DialogDescription>
        </DialogHeader>
        <p aria-label="Pairing code" className="text-center font-mono text-[28px] tracking-[0.2em] text-foreground">
          {formatPairingCode(current.code)}
        </p>
        <p className="text-meta text-tertiary">
          {current.label} · extension {current.extensionId}
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void answer(false)}>
            Don&rsquo;t connect
          </Button>
          <Button type="button" disabled={busy || !armed} onClick={() => void answer(true)}>
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
