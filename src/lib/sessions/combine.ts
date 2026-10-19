import { MAX_SESSION_TABS } from "./types"
import type { SavedTab, TabSession } from "./types"

/**
 * Starting work from one or more saved sessions: the person picks sessions,
 * unticks the tabs they don't want, and opens the rest together.
 *
 * Pure, and read-only over the sessions it is given — combining never
 * changes a saved session. The launch list is transient until the person
 * explicitly saves it as a new session.
 */

/** One tab of a launch, still pointing at where it came from. */
export type LaunchTab = SavedTab & { sessionId: string; key: string }

export type LaunchPlan = {
  tabs: LaunchTab[]
  /** Tabs left out because the same address was already in the list. */
  duplicatesSkipped: number
  /** True when more tabs were chosen than one launch opens (MAX_SESSION_TABS); the rest are left out. */
  truncated: boolean
}

/** The key a tab is selected by: unique across sessions. */
export function launchKey(sessionId: string, tabId: string): string {
  return `${sessionId}:${tabId}`
}

/**
 * The form two addresses are compared in when duplicates are skipped.
 *
 * Deliberately close to exact: only what the URL standard already says is the
 * same address (scheme and host case, a default port, an empty path) is
 * folded together. Query strings and fragments are kept — on many apps they
 * are the document (`?id=…`, `#/inbox/…`), so two links that differ there
 * are two different tabs.
 */
export function comparableUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/**
 * The tabs a launch opens, in a fixed order: sessions in the order the person
 * chose them, and each session's tabs in their saved order.
 *
 * `sessionIds` may name sessions that no longer exist (deleted while the
 * launcher was open); they contribute nothing. With `dedupe`, a tab whose
 * address is already in the list is skipped and counted — the first
 * occurrence wins, so the order above decides which copy stays.
 */
export function buildLaunchPlan(
  sessions: readonly TabSession[],
  sessionIds: readonly string[],
  excludedKeys: ReadonlySet<string>,
  options: { dedupe: boolean }
): LaunchPlan {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const seenUrls = new Set<string>()
  const seenSessions = new Set<string>()
  const tabs: LaunchTab[] = []
  let duplicatesSkipped = 0
  let truncated = false

  for (const sessionId of sessionIds) {
    if (seenSessions.has(sessionId)) continue
    seenSessions.add(sessionId)
    const session = byId.get(sessionId)
    if (!session) continue
    for (const tab of session.tabs) {
      const key = launchKey(session.id, tab.id)
      if (excludedKeys.has(key)) continue
      if (options.dedupe) {
        const comparable = comparableUrl(tab.url)
        if (seenUrls.has(comparable)) {
          duplicatesSkipped += 1
          continue
        }
        seenUrls.add(comparable)
      }
      if (tabs.length >= MAX_SESSION_TABS) {
        truncated = true
        continue
      }
      tabs.push({ ...tab, sessionId: session.id, key })
    }
  }

  return { tabs, duplicatesSkipped, truncated }
}

/** How many of the chosen tabs would be skipped as duplicates — so the switch can say what it does. */
export function countDuplicates(sessions: readonly TabSession[], sessionIds: readonly string[], excludedKeys: ReadonlySet<string>): number {
  return buildLaunchPlan(sessions, sessionIds, excludedKeys, { dedupe: true }).duplicatesSkipped
}
