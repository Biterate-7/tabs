"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Sparkles, Send, Copy, RotateCcw, Trash2, Loader2 } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/ui/empty-state"
import { SourceCard } from "@/components/ai/source-card"
import { useAskTabDump } from "@/hooks/use-ask-tabdump"
import type { AiIndexState } from "@/hooks/use-ai-indexing"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

const SUGGESTED_QUESTIONS = [
  "What did I save recently?",
  "Summarize what I've saved about ",
  "Find the tabs about ",
  "What am I missing from my research?",
]

export function AskTabDumpPanel({
  open,
  onOpenChange,
  workspaceId,
  tabs,
  indexState,
  allWorkspaces,
  onStoreUpdate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  tabs: Tab[]
  indexState: AiIndexState
  /** Passing this (with onStoreUpdate) turns on Ask TabDump's action capability — see useAskTabDump. */
  allWorkspaces?: Workspace[]
  onStoreUpdate?: (store: WorkspaceStore) => void
}) {
  const { messages, isSending, send, regenerate, clear } = useAskTabDump(workspaceId, tabs, allWorkspaces, onStoreUpdate)
  const [input, setInput] = useState("")
  const scrollEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ block: "end" })
  }, [messages])

  function handleSend() {
    if (!input.trim() || isSending) return
    send(input)
    setInput("")
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("Copied to clipboard")
    } catch {
      toast.error("Couldn't copy to clipboard")
    }
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && !m.pending)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col data-[side=right]:w-full sm:data-[side=right]:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-1.5 text-h1">
            <Sparkles className="size-4 text-accent-text" aria-hidden />
            Ask TabDump
          </SheetTitle>
          <SheetDescription>Ask questions about your saved tabs — answers are grounded in what you&rsquo;ve dumped.</SheetDescription>
        </SheetHeader>

        {tabs.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="Dump some tabs first"
            description="Then Ask TabDump can search your saved knowledge."
          />
        ) : (
          <>
            <ScrollArea className="min-h-0 flex-1 px-4">
              {messages.length === 0 ? (
                <div className="space-y-3 py-4">
                  <p className="text-body-sm text-tertiary">Try asking:</p>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTED_QUESTIONS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => setInput(q)}
                        className="rounded-full border border-subtle px-3 py-1.5 text-body-sm text-foreground transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border hover:bg-muted"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-4 py-4">
                  {messages.map((message) => (
                    <div key={message.id} className={message.role === "user" ? "flex justify-end" : ""}>
                      {message.role === "user" ? (
                        <p className="max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-body text-foreground whitespace-pre-wrap break-words">
                          {message.text}
                        </p>
                      ) : (
                        <div className="w-full min-w-0 space-y-3">
                          {message.pending && message.text === "" ? (
                            <div className="flex items-center gap-2 text-tertiary">
                              <Loader2 className="size-3.5 animate-spin" aria-hidden />
                              <span className="text-body-sm">Thinking…</span>
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap break-words text-body text-foreground">{message.text}</p>
                          )}

                          {message.sources && message.sources.length > 0 && (
                            <div className="space-y-1.5">
                              <p className="text-label text-tertiary">Sources</p>
                              <div className="space-y-1.5">
                                {message.sources.map((source) => (
                                  <SourceCard key={source.tabId} source={source} />
                                ))}
                              </div>
                            </div>
                          )}

                          {!message.pending && message.id === lastAssistant?.id && (
                            <div className="flex items-center gap-1">
                              <IconButton aria-label="Copy response" onClick={() => handleCopy(message.text)}>
                                <Copy />
                              </IconButton>
                              <IconButton aria-label="Regenerate response" onClick={regenerate} disabled={isSending}>
                                <RotateCcw />
                              </IconButton>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  <div ref={scrollEndRef} />
                </div>
              )}
            </ScrollArea>

            <div className="border-t border-subtle p-4">
              {indexState.isIndexing && (
                <p className="mb-2 text-meta text-tertiary">
                  Indexing your tabs… {indexState.indexed}/{indexState.total}
                </p>
              )}
              <div className="flex items-end gap-2">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask anything about your saved tabs…"
                  className="min-h-10"
                  rows={1}
                />
                <Button size="icon" onClick={handleSend} disabled={isSending || !input.trim()} aria-label="Send">
                  <Send />
                </Button>
              </div>
              {messages.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clear} className="mt-2">
                  <Trash2 /> Clear conversation
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
