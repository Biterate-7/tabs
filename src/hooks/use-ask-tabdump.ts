"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createId } from "@/lib/id"
import { askQuestion, applyPlan, applyOrganizationPlan } from "@/lib/ai/ask"
import { attemptUndo, findUndoEntry, markUndone, pushUndoEntry } from "@/lib/undo/history"
import { useBrowserConnection } from "@/hooks/use-browser-connection"
import { fetchBrowserContext } from "@/lib/browser/context"
import { executeBrowserAction, executeBrowserReverts, needsBrowserExecution } from "@/lib/browser/execute"
import { findBrowserUndoEntry, markBrowserUndone, pushBrowserUndoEntry } from "@/lib/browser/undo"
import { computeSemanticClusterHints } from "@/lib/ai/cluster"
import { looksLikeAutoOrganizeIntent } from "@/lib/organize/intent"
import type { UndoEntry } from "@/lib/undo/types"
import type { BrowserRevertStep, BrowserUndoEntry } from "@/lib/browser/undo"
import type { Tab } from "@/lib/tabs/types"
import type { AskMessage, OrganizationPlan, PerformedActionView, SearchResult } from "@/lib/ai/types"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

/**
 * Composes the one UndoAction a message carries out of whichever undo
 * entries this turn actually produced — a turn can produce a store entry, a
 * browser entry, both (e.g. "move these tabs to MUN and open them" —
 * see UndoAction.secondaryEntryId's doc), or neither. `storeId` is always
 * treated as primary when present, purely because it's recorded first
 * chronologically in both runAsk and applyPreview below; the two are
 * otherwise reverted independently and order has no functional effect.
 */
function combineUndo(storeId: string | undefined, browserId: string | undefined): { entryId: string; secondaryEntryId?: string; status: "available" } | undefined {
  if (storeId && browserId) return { entryId: storeId, secondaryEntryId: browserId, status: "available" }
  if (storeId) return { entryId: storeId, status: "available" }
  if (browserId) return { entryId: browserId, status: "available" }
  return undefined
}

const CANCELLED_TEXT = "No changes made."
const UNDONE_TEXT = "↶ Undid that change."
const UNDO_STALE_TEXT = "I can't safely undo that change because the workspace has changed since then."
const BROWSER_UNDO_FAILED_TEXT = "I couldn't fully undo that browser change."

/**
 * Actually carries out every browser action the server validated but could
 * never itself execute (see AGENTS.md's architectural constraint) — the
 * server only ever returns `{ok, args, data}` for these; nothing has
 * touched Chrome yet. Runs them all, then composes an honest result: if
 * anything partially or fully failed, that's what gets shown — never the
 * model's own (now possibly wrong) optimistic phrasing. Returns `null` when
 * there was nothing to execute, so the caller keeps the server's text as-is.
 */
async function runBrowserExecutions(actions: PerformedActionView[] | undefined): Promise<{ text: string; revert: BrowserRevertStep[] } | null> {
  const toRun = (actions ?? []).filter((a) => a.ok && needsBrowserExecution(a.name));
  if (toRun.length === 0) return null;

  const executions = await Promise.all(toRun.map((a) => executeBrowserAction(a.name, a.args, a.data)));
  const text = executions.map((e) => e.message).filter(Boolean).join(" ");
  const revert = executions.flatMap((e) => (e.revert ? (Array.isArray(e.revert) ? e.revert : [e.revert]) : []));
  return { text, revert };
}

/**
 * `allWorkspaces`/`onStoreUpdate` are optional so existing callers (and
 * tests) that only pass (workspaceId, tabs) keep working unchanged — without
 * them, this falls back to the original grounded-Q&A-only "chat" endpoint.
 * Passing both is what turns on Ask TabDump's action-performing "agent"
 * capability: they let a write action's resulting store make it back out
 * to the caller to persist, and let a proposed plan be applied later.
 */
export function useAskTabDump(
  workspaceId: string,
  tabs: Tab[],
  allWorkspaces?: Workspace[],
  onStoreUpdate?: (store: WorkspaceStore) => void
) {
  const [messages, setMessages] = useState<AskMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  // Latest-ref idiom (see use-workspace-shortcuts.ts): lets runAsk/regenerate
  // read the current message list without depending on it and risking a
  // stale closure across the awaited askQuestion() call.
  const messagesRef = useRef<AskMessage[]>(messages)
  const abortRef = useRef<AbortController | null>(null)
  const lastQuestionRef = useRef<string | null>(null)
  // Synchronous double-click guard for applyPreview: a Set (not React
  // state) because it must block a second call that arrives before the
  // first await yields, and state updates aren't guaranteed to have
  // committed by then. See applyPreview below.
  const applyingIdsRef = useRef<Set<string>>(new Set())
  // Same idea, for undoAction below.
  const undoingIdsRef = useRef<Set<string>>(new Set())
  // The undo history lives only as a ref, never as React state: nothing
  // renders it directly (the UI reads each message's own `undo.status`,
  // which IS state — see setMessages below), so there's nothing to
  // re-render for. Keeping it a ref lets pushUndoEntry/markUndone read-
  // then-write it synchronously inside callbacks without waiting on a
  // state update to commit — same reasoning as messagesRef.
  const undoHistoryRef = useRef<UndoEntry[]>([])
  // Parallel to undoHistoryRef, for browser mutations — see
  // src/lib/browser/undo.ts for why this can't reuse the store-diff system
  // above. A message's `undo.entryId` may point into either history;
  // undoAction (below) checks both.
  const browserUndoHistoryRef = useRef<BrowserUndoEntry[]>([])
  // The most recent turn's search_tabs results, so a follow-up like "move
  // those into Physics IA" can resolve "those" without the user repeating
  // the search or supplying tab ids — see askQuestion's recentSearchResults
  // param. A ref (not state) since it's read-then-written inside runAsk,
  // never rendered directly.
  const lastSearchResultsRef = useRef<SearchResult[] | undefined>(undefined)
  const browserConnected = useBrowserConnection()

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  function recordUndoEntry(beforeState: WorkspaceStore, afterState: WorkspaceStore, description: string): UndoEntry {
    const { history, entry } = pushUndoEntry(undoHistoryRef.current, { beforeState, afterState, description })
    undoHistoryRef.current = history
    return entry
  }

  function recordBrowserUndoEntry(description: string, revert: BrowserRevertStep[]): BrowserUndoEntry {
    const { history, entry } = pushBrowserUndoEntry(browserUndoHistoryRef.current, { description, revert })
    browserUndoHistoryRef.current = history
    return entry
  }

  const runAsk = useCallback(
    async (question: string, history: AskMessage[]) => {
      lastQuestionRef.current = question
      const assistantId = createId("ask")
      setMessages([
        ...history,
        { id: createId("ask"), role: "user", text: question },
        { id: assistantId, role: "assistant", text: "", pending: true },
      ])
      setIsSending(true)

      const controller = new AbortController()
      abortRef.current = controller

      // askQuestion() is designed to never reject (every internal failure is
      // caught and returned as {ok:false}), but this try/finally is a
      // deliberate backstop: if anything in that chain ever throws instead —
      // a genuinely unexpected error, not just a handled API failure — this
      // still guarantees isSending resets and the pending bubble resolves,
      // instead of leaving the whole conversation permanently stuck.
      try {
        const store: WorkspaceStore | undefined = allWorkspaces
          ? { version: 1, currentId: workspaceId, workspaces: allWorkspaces }
          : undefined

        let undoEntryId: string | undefined
        let browserUndoEntryId: string | undefined

        // Only bother the extension when it's actually there — a fixed
        // multi-second wait on every single question for users without it
        // installed would be a real regression, not just a missed feature.
        const browserContext = browserConnected ? (await fetchBrowserContext()) ?? undefined : undefined

        // Only pay for the IndexedDB clustering scan when the question
        // plausibly needs it — a cheap, deterministic pre-check (see
        // AGENTS.md section 17). A false negative here just means
        // propose_auto_organize falls back to domain/keyword clustering,
        // not that the feature stops working.
        const semanticClusters =
          store && looksLikeAutoOrganizeIntent(question)
            ? await computeSemanticClusterHints(store.workspaces.map((w) => w.id)).catch(() => [])
            : undefined

        const result = await askQuestion({
          workspaceId,
          tabs,
          question,
          history,
          signal: controller.signal,
          store,
          browserContext,
          semanticClusters,
          recentSearchResults: lastSearchResultsRef.current,
          onStoreUpdate: (after, description) => {
            if (store) undoEntryId = recordUndoEntry(store, after, description || question).id
            onStoreUpdate?.(after)
          },
          onDelta: (delta) => {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)))
          },
        })

        if (result.ok && !("organizePlan" in result)) lastSearchResultsRef.current = result.searchResults ?? lastSearchResultsRef.current

        // Any browser action the server validated hasn't actually happened
        // yet (it can't have — the server never touches chrome.*). Run it
        // for real now, and let the truth of what happened — not Gemini's
        // guess — decide the final wording. See AGENTS.md section 15.
        // propose_auto_organize is read-only (no store mutation, no browser
        // actions) — an organizePlan result skips this entirely.
        const isImmediate = result.ok && !("requiresConfirmation" in result) && !("organizePlan" in result)
        let finalText = isImmediate ? result.text : undefined
        if (isImmediate) {
          const executed = await runBrowserExecutions(result.actions)
          if (executed) {
            finalText = executed.text || result.text
            if (executed.revert.length > 0) {
              browserUndoEntryId = recordBrowserUndoEntry(executed.text || question, executed.revert).id
            }
          }
        }

        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m
            if (!result.ok) return { ...m, text: `Something went wrong: ${result.error}`, pending: false }
            if ("organizePlan" in result) {
              return {
                ...m,
                text: result.text,
                pending: false,
                organizePreview: { plan: result.organizePlan, status: "awaiting" },
              }
            }
            if ("requiresConfirmation" in result) {
              return {
                ...m,
                text: result.text,
                pending: false,
                preview: { plan: result.plan, summary: result.summary, status: "awaiting" },
                ...(result.searchResults ? { searchResults: result.searchResults } : {}),
              }
            }
            const undo = combineUndo(undoEntryId, browserUndoEntryId)
            return {
              ...m,
              text: finalText ?? result.text,
              sources: result.sources,
              pending: false,
              ...(undo ? { undo } : {}),
              ...(result.searchResults ? { searchResults: result.searchResults } : {}),
            }
          })
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : "an unexpected error occurred.";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, text: `Something went wrong: ${message}`, pending: false } : m
          )
        )
      } finally {
        setIsSending(false)
      }
    },
    [workspaceId, tabs, allWorkspaces, onStoreUpdate, browserConnected]
  )

  const send = useCallback(
    (question: string) => {
      const trimmed = question.trim()
      if (!trimmed || isSending) return
      runAsk(trimmed, messagesRef.current)
    },
    [runAsk, isSending]
  )

  const regenerate = useCallback(() => {
    if (!lastQuestionRef.current || isSending) return
    runAsk(lastQuestionRef.current, messagesRef.current.slice(0, -2))
  }, [runAsk, isSending])

  const clear = useCallback(() => {
    abortRef.current?.abort()
    setMessages([])
    lastQuestionRef.current = null
    lastSearchResultsRef.current = undefined
  }, [])

  /**
   * Executes a message's pending plan for real. Guarded twice against
   * double-invocation: synchronously via applyingIdsRef (blocks a second
   * click that lands before the first await yields) and again via the
   * message's own `preview.status` (blocks a click after the first has
   * already resolved). Either guard alone would work for the ordinary case;
   * having both means neither a rapid double-click nor a stale closure can
   * apply the same plan twice.
   */
  const applyPreview = useCallback(
    async (messageId: string) => {
      if (applyingIdsRef.current.has(messageId)) return
      const message = messagesRef.current.find((m) => m.id === messageId)
      if (!message?.preview || message.preview.status !== "awaiting") return

      applyingIdsRef.current.add(messageId)
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId && m.preview ? { ...m, preview: { ...m.preview, status: "applying" } } : m))
      )

      try {
        const store: WorkspaceStore = { version: 1, currentId: workspaceId, workspaces: allWorkspaces ?? [] }
        let undoEntryId: string | undefined
        let browserUndoEntryId: string | undefined

        const browserContext = browserConnected ? (await fetchBrowserContext()) ?? undefined : undefined

        const result = await applyPlan({
          plan: message.preview.plan,
          store,
          browserContext,
          onStoreUpdate: (after, description) => {
            undoEntryId = recordUndoEntry(store, after, description || message.preview!.summary).id
            onStoreUpdate?.(after)
          },
        })

        // As in runAsk: a browser action in the plan was only validated by
        // the server, never actually carried out — do that now, and fold
        // the real outcome into the text the user sees (see AGENTS.md
        // section 15). Recorded as its own undo entry regardless of whether
        // the plan also changed the store — see UndoAction.secondaryEntryId
        // and combineUndo, which is what lets Undo revert both halves of a
        // plan like "move these tabs to MUN and open them."
        let finalText = result.ok ? result.text : undefined
        if (result.ok) {
          const executed = await runBrowserExecutions(result.actions)
          if (executed) {
            finalText = executed.text ? `${result.text} ${executed.text}`.trim() : result.text
            if (executed.revert.length > 0) {
              browserUndoEntryId = recordBrowserUndoEntry(executed.text || message.preview!.summary, executed.revert).id
            }
          }
        }

        setMessages((prev) => {
          const resolved = prev.map((m) =>
            m.id === messageId && m.preview
              ? { ...m, preview: { ...m.preview, status: result.ok ? ("applied" as const) : ("failed" as const) } }
              : m
          )
          const undo = result.ok ? combineUndo(undoEntryId, browserUndoEntryId) : undefined
          const followUp: AskMessage = {
            id: createId("ask"),
            role: "assistant",
            text: result.ok ? (finalText ?? result.text) : `Something went wrong: ${result.error}`,
            ...(undo ? { undo } : {}),
          }
          return [...resolved, followUp]
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "an unexpected error occurred."
        setMessages((prev) => [
          ...prev.map((m) => (m.id === messageId && m.preview ? { ...m, preview: { ...m.preview, status: "failed" as const } } : m)),
          { id: createId("ask"), role: "assistant", text: `Something went wrong: ${message}` },
        ])
      } finally {
        applyingIdsRef.current.delete(messageId)
      }
    },
    [workspaceId, allWorkspaces, onStoreUpdate, browserConnected]
  )

  const cancelPreview = useCallback((messageId: string) => {
    setMessages((prev) => {
      const target = prev.find((m) => m.id === messageId)
      if (!target?.preview || target.preview.status !== "awaiting") return prev

      const updated = prev.map((m) =>
        m.id === messageId && m.preview ? { ...m, preview: { ...m.preview, status: "cancelled" as const } } : m
      )
      const followUp: AskMessage = { id: createId("ask"), role: "assistant", text: CANCELLED_TEXT }
      return [...updated, followUp]
    })
  }, [])

  /**
   * Applies an approved Auto-Organize plan — the Auto-Organize counterpart
   * to applyPreview above, sharing its double-invocation guards
   * (applyingIdsRef) since a message can only ever carry one of `preview`/
   * `organizePreview`, never both. The whole operation — however many
   * workspaces/groups/moves it resolves into server-side (see
   * src/lib/organize/apply.ts) — becomes exactly ONE recordUndoEntry call
   * here, so it's one logical AI operation with one Undo button, per
   * AGENTS.md section 10.
   */
  const applyOrganizePreview = useCallback(
    /**
     * `editedPlan`, when given, overrides message.organizePreview.plan —
     * lets the review UI apply local edits (e.g. resolveUncertainTab quick
     * decisions) without round-tripping them back into message state first.
     * It still goes through the exact same validate → apply path
     * server-side regardless.
     */
    async (messageId: string, editedPlan?: OrganizationPlan) => {
      if (applyingIdsRef.current.has(messageId)) return
      const message = messagesRef.current.find((m) => m.id === messageId)
      if (!message?.organizePreview || message.organizePreview.status !== "awaiting") return

      applyingIdsRef.current.add(messageId)
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId && m.organizePreview ? { ...m, organizePreview: { ...m.organizePreview, status: "applying" } } : m))
      )

      try {
        const store: WorkspaceStore = { version: 1, currentId: workspaceId, workspaces: allWorkspaces ?? [] }
        let undoEntryId: string | undefined

        const browserContext = browserConnected ? (await fetchBrowserContext()) ?? undefined : undefined

        const result = await applyOrganizationPlan({
          organizationPlan: editedPlan ?? message.organizePreview.plan,
          store,
          browserContext,
          onStoreUpdate: (after, description) => {
            undoEntryId = recordUndoEntry(store, after, description || message.organizePreview!.plan.summary).id
            onStoreUpdate?.(after)
          },
        })

        setMessages((prev) => {
          const resolved = prev.map((m) =>
            m.id === messageId && m.organizePreview
              ? { ...m, organizePreview: { ...m.organizePreview, status: result.ok ? ("applied" as const) : ("failed" as const) } }
              : m
          )
          const followUp: AskMessage = {
            id: createId("ask"),
            role: "assistant",
            text: result.ok ? result.text : `Something went wrong: ${result.error}`,
            ...(result.ok && undoEntryId ? { undo: { entryId: undoEntryId, status: "available" as const } } : {}),
          }
          return [...resolved, followUp]
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "an unexpected error occurred."
        setMessages((prev) => [
          ...prev.map((m) => (m.id === messageId && m.organizePreview ? { ...m, organizePreview: { ...m.organizePreview, status: "failed" as const } } : m)),
          { id: createId("ask"), role: "assistant", text: `Something went wrong: ${message}` },
        ])
      } finally {
        applyingIdsRef.current.delete(messageId)
      }
    },
    [workspaceId, allWorkspaces, onStoreUpdate, browserConnected]
  )

  const cancelOrganizePreview = useCallback((messageId: string) => {
    setMessages((prev) => {
      const target = prev.find((m) => m.id === messageId)
      if (!target?.organizePreview || target.organizePreview.status !== "awaiting") return prev

      const updated = prev.map((m) =>
        m.id === messageId && m.organizePreview ? { ...m, organizePreview: { ...m.organizePreview, status: "cancelled" as const } } : m
      )
      const followUp: AskMessage = { id: createId("ask"), role: "assistant", text: CANCELLED_TEXT }
      return [...updated, followUp]
    })
  }, [])

  /**
   * Reverts exactly one undo entry — a browser mutation (re-invoking the
   * extension with the exact revert steps recorded at execution time; see
   * src/lib/browser/execute.ts) or a store mutation (attemptUndo()'s
   * whole-store equality check against the CURRENT store — if anything at
   * all has changed since this entry's afterState, the undo is refused
   * rather than silently discarding that newer state). Pure with respect to
   * message state — it never calls setMessages itself — so undoAction below
   * can revert a message's primary and secondary entries independently and
   * compose ONE honest combined result, instead of two separate follow-up
   * messages that could arrive out of order.
   */
  async function revertOneEntry(id: string): Promise<{ ok: boolean; message?: string }> {
    const browserEntry = findBrowserUndoEntry(browserUndoHistoryRef.current, id)
    if (browserEntry) {
      if (browserEntry.status !== "active") return { ok: false, message: UNDO_STALE_TEXT }
      const result = await executeBrowserReverts(browserEntry.revert)
      browserUndoHistoryRef.current = markBrowserUndone(browserUndoHistoryRef.current, id)
      return result.ok ? { ok: true } : { ok: false, message: `${BROWSER_UNDO_FAILED_TEXT} (${result.errors.join("; ")})` }
    }

    const entry = findUndoEntry(undoHistoryRef.current, id)
    if (!entry) return { ok: false, message: UNDO_STALE_TEXT }
    const currentStore: WorkspaceStore = { version: 1, currentId: workspaceId, workspaces: allWorkspaces ?? [] }
    const attempt = attemptUndo(entry, currentStore)
    if (!attempt.ok) return { ok: false, message: UNDO_STALE_TEXT }

    onStoreUpdate?.(attempt.store)
    undoHistoryRef.current = markUndone(undoHistoryRef.current, id)
    return { ok: true }
  }

  /**
   * Reverts the mutation(s) `entryId` (and, when set, the message's own
   * `secondaryEntryId` — see UndoAction's doc) recorded — nothing more. This
   * is plain application logic, not something Gemini is ever asked to do: it
   * never sees an "undo" tool, and never gets a say in whether or how a
   * previous change is reverted. Guarded against double-clicks the same way
   * applyPreview is (sync ref + the entry's own resolved status). When both
   * halves of a combined entry are present, they're reverted independently
   * and in parallel (neither depends on the other's outcome) and the result
   * is composed into one honest message — e.g. "TabDump changes were undone.
   * The 2 tabs I opened couldn't be restored." — rather than ever claiming
   * full success when only part of it actually reverted.
   */
  const undoAction = useCallback(
    async (entryId: string) => {
      if (undoingIdsRef.current.has(entryId)) return

      const message = messagesRef.current.find((m) => m.undo?.entryId === entryId)
      const secondaryId = message?.undo?.secondaryEntryId

      const primaryEntry = findBrowserUndoEntry(browserUndoHistoryRef.current, entryId) ?? findUndoEntry(undoHistoryRef.current, entryId)
      if (!primaryEntry) return
      if (primaryEntry.status !== "active") return

      undoingIdsRef.current.add(entryId)
      setMessages((prev) =>
        prev.map((m) => (m.undo?.entryId === entryId ? { ...m, undo: { ...m.undo, status: "undoing" as const } } : m))
      )

      try {
        const [primaryResult, secondaryResult] = await Promise.all([
          revertOneEntry(entryId),
          secondaryId ? revertOneEntry(secondaryId) : Promise.resolve(null),
        ])

        const secondaryFailed = secondaryResult !== null && !secondaryResult.ok
        let text: string
        if (primaryResult.ok && !secondaryFailed) {
          text = UNDONE_TEXT
        } else if (primaryResult.ok && secondaryFailed) {
          text = `${UNDONE_TEXT} ${secondaryResult!.message ?? "The rest of that change couldn't be undone."}`
        } else {
          text = primaryResult.message ?? UNDO_STALE_TEXT
        }

        const resolvedStatus: "undone" | "unavailable" = primaryResult.ok ? "undone" : "unavailable"
        setMessages((prev) => [
          ...prev.map((m) => (m.undo?.entryId === entryId ? { ...m, undo: { ...m.undo, status: resolvedStatus } } : m)),
          { id: createId("ask"), role: "assistant", text },
        ])
      } catch (err) {
        const message = err instanceof Error ? err.message : "an unexpected error occurred."
        setMessages((prev) => [
          ...prev.map((m) => (m.undo?.entryId === entryId ? { ...m, undo: { ...m.undo, status: "unavailable" as const } } : m)),
          { id: createId("ask"), role: "assistant", text: `Something went wrong: ${message}` },
        ])
      } finally {
        undoingIdsRef.current.delete(entryId)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revertOneEntry closes over exactly these same deps and is redefined every render, so it's intentionally omitted rather than listed (it would never be referentially stable either way).
    [workspaceId, allWorkspaces, onStoreUpdate]
  )

  return {
    messages,
    isSending,
    send,
    regenerate,
    clear,
    applyPreview,
    cancelPreview,
    applyOrganizePreview,
    cancelOrganizePreview,
    undoAction,
  }
}
