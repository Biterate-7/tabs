"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createId } from "@/lib/id"
import { askQuestion, applyPlan } from "@/lib/ai/ask"
import type { Tab } from "@/lib/tabs/types"
import type { AskMessage } from "@/lib/ai/types"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

const CANCELLED_TEXT = "No changes made."

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

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

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

        const result = await askQuestion({
          workspaceId,
          tabs,
          question,
          history,
          signal: controller.signal,
          store,
          onStoreUpdate,
          onDelta: (delta) => {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)))
          },
        })

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
              }
            }
            return { ...m, text: result.text, sources: result.sources, pending: false }
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
        const result = await applyPlan({ plan: message.preview.plan, store, onStoreUpdate })

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

  return { messages, isSending, send, regenerate, clear, applyPreview, cancelPreview }
}
