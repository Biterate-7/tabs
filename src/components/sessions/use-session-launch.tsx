"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useBrowserConnected } from "@/hooks/use-tab-sessions"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { createTimestamp } from "@/lib/timestamps"
import { describeRestore } from "@/lib/sessions/messages"
import { markSessionRestored } from "@/lib/sessions/model"
import { writeSessions } from "@/lib/sessions/persistence"
import { restoreTabs } from "@/lib/sessions/restore"
import { CONFIRM_OPEN_ABOVE } from "@/lib/sessions/types"
import type { Notice } from "@/lib/sessions/messages"
import type { RestoreOutcome, RestoreTab } from "@/lib/sessions/restore"

/** What one launch opens, and which saved sessions it came from (their "last opened" is recorded on success). */
export type LaunchRequest = { tabs: RestoreTab[]; sessionIds: string[] }

export function showNotice(notice: Notice) {
  const notify = notice.tone === "error" ? toast.error : notice.tone === "warning" ? toast.warning : toast.success
  notify(notice.title, notice.description ? { description: notice.description } : undefined)
}

/**
 * Opening saved tabs from any surface (Home's Resume, the Sessions page's
 * launcher): asks first above CONFIRM_OPEN_ABOVE tabs, refuses a second
 * launch while one is running, reports exactly what Chrome did, and records
 * "last opened" on the sessions only once Chrome has opened at least one tab.
 *
 * The tabs are copied when the launch starts, so a session renamed, edited or
 * deleted while Chrome opens them changes nothing about this launch.
 */
export function useSessionLaunch() {
  const connected = useBrowserConnected()
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState<LaunchRequest | null>(null)
  // A ref as well as state: two clicks in one frame both see the state as it was before either.
  const running = useRef(false)

  async function run(request: LaunchRequest): Promise<RestoreOutcome | undefined> {
    if (running.current) return undefined
    running.current = true
    setPending(true)
    try {
      const outcome = await restoreTabs(request.tabs, { connected })
      showNotice(describeRestore(outcome, request.tabs.length))
      if (outcome.kind === "opened" && outcome.opened > 0) {
        const now = createTimestamp()
        // Only a time is recorded; if storage refuses it the tabs are still open and the session unchanged.
        for (const id of new Set(request.sessionIds)) writeSessions((state) => markSessionRestored(state, id, now))
      }
      return outcome
    } finally {
      running.current = false
      setPending(false)
    }
  }

  /** Starts a launch, or asks first when it is large. Resolves with the outcome once Chrome answers (undefined when it asked or was refused). */
  function launch(request: LaunchRequest): Promise<RestoreOutcome | undefined> {
    if (running.current || request.tabs.length === 0) return Promise.resolve(undefined)
    if (request.tabs.length > CONFIRM_OPEN_ABOVE) {
      setConfirming(request)
      return Promise.resolve(undefined)
    }
    return run(request)
  }

  function confirm(): Promise<RestoreOutcome | undefined> {
    const request = confirming
    setConfirming(null)
    return request ? run(request) : Promise.resolve(undefined)
  }

  return { launch, confirm, cancel: () => setConfirming(null), confirming, pending }
}

/**
 * Where a launch's tabs go: a new Chrome window through Hubble for Chrome, or
 * — in Hubble Desktop, which can't ask the extension — the default browser
 * (src/lib/sessions/restore.ts).
 */
export function useLaunchDestination(): string {
  return useIsDesktop() ? "in your default browser" : "in a new Chrome window"
}

/** "Open 32 tabs?" — shown by whichever surface started a large launch. */
export function LaunchConfirmDialog({
  request,
  onConfirm,
  onCancel,
}: {
  request: LaunchRequest | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const destination = useLaunchDestination()
  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Open {request?.tabs.length ?? 0} tabs?</AlertDialogTitle>
          <AlertDialogDescription>They open {destination}. Your current tabs stay as they are.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button type="button" onClick={onConfirm}>
            Open {request?.tabs.length ?? 0} tabs
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
