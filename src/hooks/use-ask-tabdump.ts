"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createId } from "@/lib/id"
import { askQuestion, applyPlan } from "@/lib/ai/ask"
import { attemptUndo, findUndoEntry, markUndone, pushUndoEntry } from "@/lib/undo/history"
import type { UndoEntry } from "@/lib/undo/types"
import type { Tab } from "@/lib/tabs/types"
import type { AskMessage, SearchResult } from "@/lib/ai/types"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

const CANCELLED_TEXT = "No changes made."
const UNDONE_TEXT = "↶ Undid that change."
const UNDO_STALE_TEXT = "I can't safely undo that change because the workspace has changed since then."

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
  // The most recent turn's search_tabs results, so a follow-up like "move
  // those into Physics IA" can resolve "those" without the user repeating
  // the search or supplying tab ids — see askQuestion's recentSearchResults
  // param. A ref (not state) since it's read-then-written inside runAsk,
  // never rendered directly.
  const lastSearchResultsRef = useRef<SearchResult[] | undefined>(undefined)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  function recordUndoEntry(beforeState: WorkspaceStore, afterState: WorkspaceStore, description: string): UndoEntry {
    const { history, entry } = pushUndoEntry(undoHistoryRef.current, { beforeState, afterState, description })
    undoHistoryRef.current = history
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

        const result = await askQuestion({
          workspaceId,
          tabs,
          question,
          history,
          signal: controller.signal,
          store,
          recentSearchResults: lastSearchResultsRef.current,
          onStoreUpdate: (after, description) => {
            if (store) undoEntryId = recordUndoEntry(store, after, description || question).id
            onStoreUpdate?.(after)
          },
          onDelta: (delta) => {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)))
          },
        })

        if (result.ok) lastSearchResultsRef.current = result.searchResults ?? lastSearchResultsRef.current

        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m
            if (!result.ok) return { ...m, text: `Something went wrong: ${result.error}`, pending: false }
            if ("requiresConfirmation" in result) {
              return {
                ...m,
                text: result.text,
                pending: false,
                preview: { plan: result.plan, summary: result.summary, status: "awaiting" },
                ...(result.searchResults ? { searchResults: result.searchResults } : {}),
              }
            }
            return {
              ...m,
              text: result.text,
              sources: result.sources,
              pending: false,
              ...(undoEntryId ? { undo: { entryId: undoEntryId, status: "available" as const } } : {}),
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
    [workspaceId, tabs, allWorkspaces, onStoreUpdate]
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

        const result = await applyPlan({
          plan: message.preview.plan,
          store,
          onStoreUpdate: (after, description) => {
            undoEntryId = recordUndoEntry(store, after, description || message.preview!.summary).id
            onStoreUpdate?.(after)
          },
        })

        setMessages((prev) => {
          const resolved = prev.map((m) =>
            m.id === messageId && m.preview
              ? { ...m, preview: { ...m.preview, status: result.ok ? ("applied" as const) : ("failed" as const) } }
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
          ...prev.map((m) => (m.id === messageId && m.preview ? { ...m, preview: { ...m.preview, status: "failed" as const } } : m)),
          { id: createId("ask"), role: "assistant", text: `Something went wrong: ${message}` },
        ])
      } finally {
        applyingIdsRef.current.delete(messageId)
      }
    },
    [workspaceId, allWorkspaces, onStoreUpdate]
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
   * Reverts exactly the mutation `entryId` recorded — nothing more. This is
   * plain application logic, not something Gemini is ever asked to do: it
   * never sees an "undo" tool, and never gets a say in whether or how a
   * previous change is reverted. Safety comes entirely from attemptUndo()'s
   * whole-store equality check against the CURRENT store: if anything at
   * all has changed since this entry's afterState (the AI action again, a
   * manual edit, or a later AI action), the undo is refused rather than
   * silently discarding that newer state. Guarded against double-clicks the
   * same way applyPreview is (sync ref + the entry's own resolved status).
   */
  const undoAction = useCallback(
    async (entryId: string) => {
      if (undoingIdsRef.current.has(entryId)) return
      const entry = findUndoEntry(undoHistoryRef.current, entryId)
      if (!entry || entry.status !== "active") return

      undoingIdsRef.current.add(entryId)
      setMessages((prev) =>
        prev.map((m) => (m.undo?.entryId === entryId ? { ...m, undo: { ...m.undo, status: "undoing" as const } } : m))
      )

      try {
        const currentStore: WorkspaceStore = { version: 1, currentId: workspaceId, workspaces: allWorkspaces ?? [] }
        const attempt = attemptUndo(entry, currentStore)

        if (!attempt.ok) {
          setMessages((prev) => [
            ...prev.map((m) => (m.undo?.entryId === entryId ? { ...m, undo: { ...m.undo, status: "unavailable" as const } } : m)),
            { id: createId("ask"), role: "assistant", text: UNDO_STALE_TEXT },
          ])
          return
        }

        onStoreUpdate?.(attempt.store)
        undoHistoryRef.current = markUndone(undoHistoryRef.current, entryId)

        setMessages((prev) => [
          ...prev.map((m) => (m.undo?.entryId === entryId ? { ...m, undo: { ...m.undo, status: "undone" as const } } : m)),
          { id: createId("ask"), role: "assistant", text: UNDONE_TEXT },
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
    [workspaceId, allWorkspaces, onStoreUpdate]
  )

  return { messages, isSending, send, regenerate, clear, applyPreview, cancelPreview, undoAction }
}
