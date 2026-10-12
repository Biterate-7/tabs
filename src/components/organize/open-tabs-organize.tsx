"use client"

import { useEffect, useState } from "react"
import { SmartOrganizeDialog, type SmartOrganizeStatus } from "@/components/organize/smart-organize-dialog"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { sendBrowserCommand } from "@/lib/browser/bridge"
import { EXTENSION_DOWNLOAD_URL, getExtensionInstallInfo } from "@/lib/extension-config"
import { MAX_SMART_ITEMS, itemsFromBrowserTabs, normalWindowIds } from "@/lib/organize/smart/items"
import { proposeSmartOrganization } from "@/lib/organize/smart/group"
import { subjectName } from "@/lib/product/subjects"
import type { BrowserTabInfo, BrowserWindowInfo } from "@/lib/browser/protocol"
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
  const isDesktop = useIsDesktop()
  const [attempt, setAttempt] = useState(0)
  if (!open) return null
  if (isDesktop) {
    return (
      <SmartOrganizeDialog
        open
        onOpenChange={onOpenChange}
        mode="open-tabs"
        places={[]}
        status={{
          kind: "unavailable",
          title: "Hubble Desktop can't see your Chrome tabs",
          message: (
            <>
              Send tabs here with Hubble for Chrome (right-click a tab → Add to Hubble), then open the subject they landed in and choose{" "}
              <span className="font-medium text-foreground">⋯ → Organize tabs</span>. Organizing open tabs directly works in Hubble on the web.
            </>
          ),
        }}
        onConfirm={() => undefined}
      />
    )
  }
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
  const [status, setStatus] = useState<SmartOrganizeStatus>({ kind: "loading", message: "Reading the tabs open in Chrome…" })

  useEffect(() => {
    let alive = true
    // Windows too, only to leave out private (incognito) ones: Chrome hands their tabs over as well when the extension is allowed there.
    void Promise.all([
      sendBrowserCommand<Record<string, never>, { tabs: BrowserTabInfo[] }>("list_browser_tabs", {}, { timeoutMs: 2500 }),
      sendBrowserCommand<Record<string, never>, { windows: BrowserWindowInfo[] }>("list_browser_windows", {}, { timeoutMs: 2500 }),
    ]).then(([result, windows]) => {
      if (!alive) return
      if (!result.ok) {
        const install = getExtensionInstallInfo()
        setStatus({
          kind: "unavailable",
          title: "Hubble for Chrome isn't connected",
          message: (
            <>
              Organizing open tabs reads them through{" "}
              {install.mode === "store" ? (
                <a className="text-link hover:underline" href={install.url} target="_blank" rel="noreferrer">
                  Hubble for Chrome
                </a>
              ) : (
                <a className="text-link hover:underline" href={EXTENSION_DOWNLOAD_URL} download>
                  Hubble for Chrome
                </a>
              )}
              . Tabs already saved in a subject can be organized from that subject: <span className="font-medium text-foreground">⋯ → Organize tabs</span>.
            </>
          ),
        })
        return
      }
      if (!windows.ok) {
        // Without the window list, a private window's tabs can't be told apart. Show nothing rather than risk them.
        setStatus({ kind: "error", message: "Couldn't check which of your Chrome windows are private, so nothing was read. Try again." })
        return
      }
      try {
        const { items, skipped, privateSkipped, truncated } = itemsFromBrowserTabs(result.result.tabs, snapshot.workspaces, {
          selfOrigin: window.location.origin,
          normalWindowIds: normalWindowIds(windows.result.windows),
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
