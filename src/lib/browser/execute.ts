import { sendBrowserCommand } from "./bridge"
import type { BrowserRevertStep } from "./undo"
import type { BrowserCommandResult, BrowserTabInfo, BrowserWindowInfo } from "./protocol"

/**
 * The one place a browser action Gemini decided on actually reaches Chrome.
 * The server-side action layer (src/lib/actions/browser-write.ts) validates
 * arguments and — for open_workspace_in_browser — resolves which URLs are
 * involved, but it can never call chrome.* itself (see AGENTS.md's
 * architectural constraint). Once the server's response reports one of
 * these actions as `ok`, the client (useAskTabDump) calls this for each one
 * to actually perform it, then folds any failures back into what the user
 * is told — never reporting success for a browser action that didn't
 * actually happen, per AGENTS.md section 15.
 */
export type BrowserActionExecution = {
  name: string
  ok: boolean
  message: string
  /** A single step for most actions; an array only for a bulk action (bulk_pin_tabs/bulk_unpin_tabs) that reverts per-tab — see runBrowserExecutions' flattening below. */
  revert?: BrowserRevertStep | BrowserRevertStep[]
}

/** Names that need a real post-hoc extension call — read actions and import_browser_tabs_to_workspace (a pure store mutation) don't. */
const EXECUTABLE_BROWSER_ACTIONS = new Set([
  "open_url",
  "open_tabs",
  "open_workspace_in_browser",
  "close_tab",
  "close_tabs",
  "pin_tab",
  "unpin_tab",
  "bulk_pin_tabs",
  "bulk_unpin_tabs",
  "move_tabs_to_window",
  "create_browser_window",
])

export function needsBrowserExecution(name: string): boolean {
  return EXECUTABLE_BROWSER_ACTIONS.has(name)
}

async function executeOpenTabs(urls: string[], newWindow: boolean, verb: string): Promise<BrowserActionExecution> {
  if (urls.length === 0) return { name: "open_tabs", ok: false, message: "There were no URLs to open." }

  const res = await sendBrowserCommand<{ urls: string[]; newWindow: boolean }, { opened: BrowserTabInfo[]; failed: { url: string; error: string }[] }>(
    "open_tabs",
    { urls, newWindow }
  )
  if (!res.ok) return { name: "open_tabs", ok: false, message: `Couldn't reach the browser extension: ${res.error}` }

  const { opened, failed } = res.result
  const revert: BrowserRevertStep | undefined = opened.length > 0 ? { kind: "close_tabs", tabIds: opened.map((t) => t.tabId) } : undefined

  if (failed.length > 0) {
    return {
      name: "open_tabs",
      ok: opened.length > 0,
      message: `${verb} ${opened.length} of ${urls.length} tab${urls.length === 1 ? "" : "s"} — ${failed.length} couldn't be opened.`,
      revert,
    }
  }
  return { name: "open_tabs", ok: true, message: `${verb} ${opened.length} tab${opened.length === 1 ? "" : "s"}.`, revert }
}

/**
 * `args`/`data` are exactly what the server's PerformedAction/AppliedAction
 * carried for this action (see BROWSER_ACTION_NAMES in src/lib/actions/plan.ts) —
 * `args` are the model's already-validated parameters, `data` is what the
 * action's own run() computed server-side (used only by
 * open_workspace_in_browser, which resolves a workspace to real URLs
 * server-side since that's ordinary WorkspaceStore data, not a chrome.* call).
 */
export async function executeBrowserAction(name: string, args: unknown, data: unknown): Promise<BrowserActionExecution> {
  switch (name) {
    case "open_url": {
      const a = args as { url: string }
      const res = await sendBrowserCommand<{ url: string }, { tab: BrowserTabInfo; alreadyOpen: boolean }>("open_url", { url: a.url })
      if (!res.ok) return { name, ok: false, message: `Couldn't open ${a.url}: ${res.error}` }
      if (res.result.alreadyOpen) {
        // No new tab was created, so there's nothing for Undo to close.
        return { name, ok: true, message: `${a.url} was already open — switched to that tab.` }
      }
      return { name, ok: true, message: `Opened ${a.url}.`, revert: { kind: "close_tabs", tabIds: [res.result.tab.tabId] } }
    }

    case "open_tabs": {
      const a = args as { urls: string[]; newWindow?: boolean }
      return { ...(await executeOpenTabs(a.urls, Boolean(a.newWindow), "Opened")), name }
    }

    case "open_workspace_in_browser": {
      const d = data as { urls: string[]; workspaceName: string }
      const result = await executeOpenTabs(d.urls, false, `Opened "${d.workspaceName}" —`)
      return { ...result, name };
    }

    case "close_tab": {
      const a = args as { tabId: number }
      const res = await sendBrowserCommand<{ tabId: number }, { closed: boolean }>("close_tab", { tabId: a.tabId })
      return res.ok
        ? { name, ok: true, message: "Closed 1 tab." }
        : { name, ok: false, message: `Couldn't close that tab: ${res.error}` }
    }

    case "close_tabs": {
      const a = args as { tabIds: number[] }
      const res = await sendBrowserCommand<{ tabIds: number[] }, { closed: number[]; failed: { tabId: number; error: string }[] }>(
        "close_tabs",
        { tabIds: a.tabIds }
      )
      if (!res.ok) return { name, ok: false, message: `Couldn't close tabs: ${res.error}` }
      const { closed, failed } = res.result
      if (failed.length > 0) {
        return {
          name,
          ok: closed.length > 0,
          message: `Closed ${closed.length} of ${a.tabIds.length} tabs — ${failed.length} couldn't be closed.`,
        }
      }
      return { name, ok: true, message: `Closed ${closed.length} tab${closed.length === 1 ? "" : "s"}.` }
    }

    case "pin_tab":
    case "unpin_tab": {
      const a = args as { tabId: number }
      const pinned = name === "pin_tab"
      const res = await sendBrowserCommand<{ tabId: number; pinned: boolean }, { previousPinned: boolean }>(name, {
        tabId: a.tabId,
        pinned,
      })
      if (!res.ok) return { name, ok: false, message: `Couldn't ${pinned ? "pin" : "unpin"} that tab: ${res.error}` }
      return {
        name,
        ok: true,
        message: pinned ? "Pinned the tab." : "Unpinned the tab.",
        revert: { kind: "restore_pinned", tabId: a.tabId, pinned: res.result.previousPinned },
      }
    }

    case "bulk_pin_tabs":
    case "bulk_unpin_tabs": {
      const a = args as { tabIds: number[] }
      const pinned = name === "bulk_pin_tabs"
      // No dedicated bulk extension command exists for pin/unpin (unlike
      // close_tabs) — fan out to the same single-tab "pin_tab"/"unpin_tab"
      // extension command per id, exactly as if the agent had called
      // pin_tab/unpin_tab that many times, just without the extra Gemini
      // round-trips. One BrowserRevertStep per successfully-pinned tab, so
      // Undo restores each tab's own previous pinned state individually.
      const results = await Promise.all(
        a.tabIds.map((tabId) =>
          sendBrowserCommand<{ tabId: number; pinned: boolean }, { previousPinned: boolean }>(pinned ? "pin_tab" : "unpin_tab", { tabId, pinned })
        )
      )
      const succeeded = a.tabIds
        .map((tabId, i) => ({ tabId, res: results[i] }))
        .filter((x): x is { tabId: number; res: Extract<BrowserCommandResult<{ previousPinned: boolean }>, { ok: true }> } => x.res.ok)
      const failedCount = a.tabIds.length - succeeded.length
      const revert: BrowserRevertStep[] = succeeded.map((s) => ({ kind: "restore_pinned", tabId: s.tabId, pinned: s.res.result.previousPinned }))

      if (succeeded.length === 0) {
        return { name, ok: false, message: `Couldn't ${pinned ? "pin" : "unpin"} any of those tabs.` }
      }
      return {
        name,
        ok: true,
        message:
          failedCount > 0
            ? `${pinned ? "Pinned" : "Unpinned"} ${succeeded.length} of ${a.tabIds.length} tabs — ${failedCount} couldn't be ${pinned ? "pinned" : "unpinned"}.`
            : `${pinned ? "Pinned" : "Unpinned"} ${succeeded.length} tab${succeeded.length === 1 ? "" : "s"}.`,
        revert,
      }
    }

    case "move_tabs_to_window": {
      const a = args as { tabIds: number[]; windowId: number }
      const res = await sendBrowserCommand<{ tabIds: number[]; windowId: number }, { moved: BrowserTabInfo[] }>("move_tabs_to_window", a)
      return res.ok
        ? { name, ok: true, message: `Moved ${a.tabIds.length} tab${a.tabIds.length === 1 ? "" : "s"}.` }
        : { name, ok: false, message: `Couldn't move those tabs: ${res.error}` }
    }

    case "create_browser_window": {
      const a = args as { urls?: string[]; focused?: boolean }
      const res = await sendBrowserCommand<{ urls: string[]; focused?: boolean }, { window: BrowserWindowInfo }>("create_browser_window", {
        urls: a.urls ?? [],
        focused: a.focused,
      })
      if (!res.ok) return { name, ok: false, message: `Couldn't create a new window: ${res.error}` }
      const tabIds = res.result.window.tabIds
      return {
        name,
        ok: true,
        message: "Created a new browser window.",
        revert: tabIds.length > 0 ? { kind: "close_tabs", tabIds } : undefined,
      }
    }

    default:
      return { name, ok: true, message: "" }
  }
}

export async function executeBrowserRevert(revert: BrowserRevertStep): Promise<{ ok: boolean; error?: string }> {
  if (revert.kind === "close_tabs") {
    const res = await sendBrowserCommand<{ tabIds: number[] }, { closed: number[] }>("close_tabs", { tabIds: revert.tabIds })
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  }

  const res = await sendBrowserCommand<{ tabId: number; pinned: boolean }, unknown>(revert.pinned ? "pin_tab" : "unpin_tab", {
    tabId: revert.tabId,
    pinned: revert.pinned,
  })
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

/**
 * Runs every step of a (usually one-step) BrowserUndoEntry's revert plan in
 * order, continuing past a failed step rather than aborting — a partial
 * undo is still more honest and useful than stopping at the first error.
 */
export async function executeBrowserReverts(steps: BrowserRevertStep[]): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = []
  for (const step of steps) {
    const result = await executeBrowserRevert(step)
    if (!result.ok) errors.push(result.error ?? "Unknown error.")
  }
  return { ok: errors.length === 0, errors }
}
