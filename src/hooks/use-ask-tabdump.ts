"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createId } from "@/lib/id"
import { askQuestion } from "@/lib/ai/ask"
import type { Tab } from "@/lib/tabs/types"
import type { AskMessage } from "@/lib/ai/types"

export function useAskTabDump(workspaceId: string, tabs: Tab[]) {
  const [messages, setMessages] = useState<AskMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  // Latest-ref idiom (see use-workspace-shortcuts.ts): lets runAsk/regenerate
  // read the current message list without depending on it and risking a
  // stale closure across the awaited askQuestion() call.
  const messagesRef = useRef<AskMessage[]>(messages)
  const abortRef = useRef<AbortController | null>(null)
  const lastQuestionRef = useRef<string | null>(null)

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

      const result = await askQuestion({
        workspaceId,
        tabs,
        question,
        history,
        signal: controller.signal,
        onDelta: (delta) => {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)))
        },
      })

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? result.ok
              ? { ...m, text: result.text, sources: result.sources, pending: false }
              : { ...m, text: `Something went wrong: ${result.error}`, pending: false }
            : m
        )
      )
      setIsSending(false)
    },
    [workspaceId, tabs]
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

  return { messages, isSending, send, regenerate, clear }
}
