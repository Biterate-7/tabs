import { formatRelativeTime } from "@/lib/time-format"
import type { RestoreOutcome } from "./restore"
import type { SessionWriteError, TabSession } from "./types"

/**
 * The words for what happened, one place for each outcome, so Home and the
 * Sessions page say the same thing. Honest about partial results: "Opened 10
 * of 12 tabs" is never rounded up to "Opened".
 */

export type Notice = { tone: "success" | "warning" | "error"; title: string; description?: string }

const tabs = (count: number) => `${count} ${count === 1 ? "tab" : "tabs"}`

export function describeRestore(outcome: RestoreOutcome, requested: number): Notice {
  switch (outcome.kind) {
    case "opened": {
      if (outcome.failed.length === 0) return { tone: "success", title: `Opened ${tabs(outcome.opened)} ${outcome.inBrowser ? "in your browser" : "in a new window"}` }
      if (outcome.opened === 0) return { tone: "error", title: `${outcome.inBrowser ? "Your browser" : "Chrome"} didn't open any of the tabs`, description: outcome.failed[0]?.error }
      return {
        tone: "warning",
        title: `Opened ${outcome.opened} of ${tabs(outcome.opened + outcome.failed.length)}`,
        description: `${outcome.failed.length} couldn't be opened. The saved session is unchanged.`,
      }
    }
    case "empty":
      return { tone: "error", title: "Nothing to open", description: "None of the chosen tabs is a web page Chrome can open." }
    case "busy":
      return { tone: "warning", title: "Already opening tabs", description: "Wait for the current launch to finish." }
    case "no-extension":
      return { tone: "error", title: "Hubble for Chrome isn't connected", description: "Install or turn on Hubble for Chrome, then try again. Nothing was opened." }
    case "outdated":
      return {
        tone: "error",
        title: "Update Hubble for Chrome",
        description: `This version opens up to 50 tabs at once; this launch has ${requested}. Nothing was opened.`,
      }
    case "timeout":
      return { tone: "warning", title: "Chrome hasn't confirmed yet", description: "Tabs may still be opening — check for a new window before trying again." }
    case "failed":
      return { tone: "error", title: "Couldn't open the tabs", description: outcome.message }
  }
}

export function describeWriteError(error: SessionWriteError): string {
  switch (error) {
    case "empty":
      return "A session needs at least one tab."
    case "too-many-tabs":
      return "That's more tabs than one session can hold (200)."
    case "too-many-sessions":
      return "You have too many saved sessions. Delete some first."
    case "missing":
      return "That session was deleted."
    case "conflict":
      return "This session changed in another tab. Close this and open it again to see the latest."
    case "storage-failed":
      return "Your browser's storage refused the change (it may be full). Nothing was changed."
    case "read-only":
      return "These sessions were saved by a newer version of Hubble. Reload Hubble to change them."
  }
}

/** "Opened yesterday" or "Saved 2 hr ago" — whichever happened last. Empty when neither time is known. */
export function lastActivityLabel(session: Pick<TabSession, "updatedAt" | "lastRestoredAt">, now: number): string {
  const restored = session.lastRestoredAt ?? 0
  const opened = restored >= session.updatedAt
  const verb = opened ? "Opened" : "Saved"
  const when = formatRelativeTime(opened ? restored : session.updatedAt, now)
  // Only the first letter: "Yesterday" reads "yesterday", but "3 Oct" stays "3 Oct".
  return when ? `${verb} ${when.charAt(0).toLowerCase()}${when.slice(1)}` : ""
}
