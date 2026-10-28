"use client"

import { useEffect, useState } from "react"
import { SmartOrganizeDialog, type SmartOrganizeStatus } from "@/components/organize/smart-organize-dialog"
import { readChromeTabs, readingChromeMessage } from "@/lib/browser/read-tabs"
import { isDesktop } from "@/lib/platform/detect"
import { EXTENSION_DOWNLOAD_URL, getExtensionInstallInfo } from "@/lib/extension-config"
import { MAX_SMART_ITEMS, itemsFromBrowserTabs, normalWindowIds } from "@/lib/organize/smart/items"
import { proposeSmartOrganization } from "@/lib/organize/smart/group"
import { subjectName } from "@/lib/product/subjects"
import type { SmartProposal } from "@/lib/organize/smart/types"
import type { Workspace } from "@/lib/workspace/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Smart Organize for the tabs open in Chrome — from Home or ⌘K.
 *
 * Chrome's tabs are read through Hubble for Chrome's existing
 * `list_browser_tabs` command (the bridge "+ Add → Browser tabs" uses); no new
 * permission is involved. Hubble Desktop has no such bridge — Chrome sends
 * tabs to it, never the other way — so there the dialog says so and points at
 * the path that does work, instead of pretending.
 */
export function OpenTabsOrganize({
  open,
  onOpenChange,
  workspaces,
  subjects,
  onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every workspace, to know what is already saved. */
  workspaces: readonly Workspace[]
  /** The subjects a group can go to (the store minus an untouched default). */
  subjects: readonly Workspace[]
  onApply: (proposal: SmartProposal) => void
}) {
  const [attempt, setAttempt] = useState(0)
  if (!open) return null
  return (
    <OpenTabsSession
      key={attempt}
      onOpenChange={onOpenChange}
      workspaces={workspaces}
      subjects={subjects}
      onRetry={() => setAttempt((value) => value + 1)}
      onApply={onApply}
    />
  )
}

/** One read of Chrome's tabs and the review that follows. Remounted (by key) for "Try again". */
function OpenTabsSession({
  onOpenChange,
  workspaces,
  subjects,
  onRetry,
  onApply,
}: {
  onOpenChange: (open: boolean) => void
  workspaces: readonly Workspace[]
  subjects: readonly Workspace[]
  onRetry: () => void
  onApply: (proposal: SmartProposal) => void
}) {
  // What Hubble held when the tabs were read. The proposal is built against it
  // once; later store changes (a source finishing its reading) must not reset
  // the person's edits. The apply step re-checks against the live store.
  const [snapshot] = useState(() => ({ workspaces, subjects }))
  // In Hubble Desktop the reading goes through the browser, where the person approves it (readChromeTabs).
  const [status, setStatus] = useState<SmartOrganizeStatus>(() => ({ kind: "loading", message: readingChromeMessage(isDesktop()) }))

  useEffect(() => {
    let alive = true
    // Windows too, only to leave out private (incognito) ones: Chrome hands their tabs over as well when the extension is allowed there.
    void readChromeTabs().then((reading) => {
      if (!alive) return
      if (!reading.ok && (reading.reason === "declined" || reading.reason === "failed")) {
        setStatus({ kind: "error", message: reading.reason === "declined" ? "Nothing was sent from Chrome." : (reading.message ?? "Chrome didn't send your tabs.") })
        return
      }
      if (!reading.ok && reading.reason === "unavailable") {
        const install = getExtensionInstallInfo()
        setStatus({
          kind: "unavailable",
          title: "Hubble for Chrome isn't connected",
          message: (
            <>
              This needs{" "}
              {install.mode === "store" ? (
                <a className="text-link hover:underline" href={install.url} target="_blank" rel="noreferrer">
                  Hubble for Chrome
                </a>
              ) : (
                <a className="text-link hover:underline" href={EXTENSION_DOWNLOAD_URL} download>
                  Hubble for Chrome
                </a>
              )}
              . Saved tabs can be organized from their project: <span className="font-medium text-foreground">⋯ → Organize tabs</span>.
            </>
          ),
        })
        return
      }
      if (!reading.ok || !reading.windows) {
        // Without the window list, a private window's tabs can't be told apart. Show nothing rather than risk them.
        setStatus({ kind: "error", message: "Couldn't check which of your Chrome windows are private, so nothing was read. Try again." })
        return
      }
      try {
        const { items, skipped, privateSkipped, truncated } = itemsFromBrowserTabs(reading.tabs, snapshot.workspaces, {
          selfOrigin: reading.selfOrigin,
          normalWindowIds: normalWindowIds(reading.windows),
        })
        if (items.length === 0) {
          setStatus({
            kind: "empty",
            message:
              privateSkipped > 0
                ? "The only web pages open are in private windows, which Smart Organize leaves alone."
                : "No web pages are open in Chrome right now — only new tabs and browser pages, which Hubble can't save.",
          })
          return
        }
        const proposal = proposeSmartOrganization(items, { mode: "open-tabs", subjects: snapshot.subjects }, { truncated })
        const notes = [
          skipped > 0 ? `${plural(skipped, "browser page was", "browser pages were")} skipped (new tabs, settings, Hubble itself).` : null,
          privateSkipped > 0 ? `${plural(privateSkipped, "tab", "tabs")} in private windows ${privateSkipped === 1 ? "was" : "were"} left alone.` : null,
          truncated > 0 ? `Only the first ${MAX_SMART_ITEMS} tabs were looked at; ${truncated} more were left as they are.` : null,
        ].filter(Boolean)
        setStatus({ kind: "ready", proposal, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) })
      } catch {
        setStatus({ kind: "error", message: "Something went wrong while grouping your tabs. Nothing was changed." })
      }
    })
    return () => {
      alive = false
    }
  }, [snapshot])

  return (
    <SmartOrganizeDialog
      open
      onOpenChange={onOpenChange}
      mode="open-tabs"
      places={snapshot.subjects.map((workspace) => ({ id: workspace.id, name: subjectName(workspace) }))}
      status={status}
      onRetry={onRetry}
      onConfirm={onApply}
    />
  )
}
