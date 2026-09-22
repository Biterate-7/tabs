"use client"

import { useCallback, useRef, useState } from "react"
import { ArrowUp, Paperclip, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Kbd } from "@/components/ui/kbd"
import { SESSION_STATUS_DETAIL, canSendMessage } from "@/lib/agents/command-centre/presentation"
import { cn } from "@/lib/utils"
import type { AgentSessionStatus } from "@/lib/agents/control/session"

/**
 * Where a task is written.
 *
 * ## Why the disabled state is derived rather than passed
 *
 * Whether a session can accept text is the control plane's answer, not the
 * composer's opinion: `canSendMessage` restates the state machine, and a run
 * that is in flight or blocked on an approval is not typeable. A composer that
 * accepted input in those states would be offering something the runtime has
 * already decided to refuse — and the user would learn that only after
 * pressing Send.
 *
 * The state is also *explained* rather than merely greyed. A control that is
 * inert with no reason is the thing people file bugs about.
 *
 * ## What it cannot carry
 *
 * Text and an optional attached context, both of which the runtime revalidates.
 * There is no hidden field here for a path, a working directory, a provider
 * flag or a model name — the protocol has nowhere to put one, and this is the
 * component that would otherwise be tempted to invent it.
 */
export function Composer({
  status,
  onSend,
  onCancel,
  pending,
  cancellable,
  /** What is attached right now, e.g. `Research · 12 tabs`. */
  contextSummary,
  projectName,
  onOpenContext,
}: {
  status: AgentSessionStatus
  onSend: (text: string) => void
  onCancel: () => void
  pending: boolean
  cancellable: boolean
  contextSummary?: string
  projectName?: string
  onOpenContext: () => void
}) {
  const [text, setText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const sendable = canSendMessage(status)
  const canSubmit = sendable && !pending && text.trim().length > 0

  const submit = useCallback(() => {
    if (!canSubmit) return
    onSend(text.trim())
    setText("")
  }, [canSubmit, onSend, text])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      /*
        Enter sends; Shift+Enter and the platform modifier both insert a line.

        Cmd/Ctrl+Enter also sends, because that is the muscle memory from every
        other agent surface and a user who reaches for it should not be
        punished with a newline.
      */
      if (event.key !== "Enter") return
      if (event.shiftKey) return

      event.preventDefault()
      submit()
    },
    [submit]
  )

  return (
    <div className="border-t border-subtle px-6 py-3">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            "rounded-lg border border-subtle bg-surface transition-colors",
            "focus-within:border-border"
          )}
        >
          <label className="sr-only" htmlFor="command-centre-composer">
            Message the agent
          </label>
          <textarea
            id="command-centre-composer"
            ref={textareaRef}
            rows={3}
            value={text}
            disabled={!sendable || pending}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              sendable
                ? projectName
                  ? `Ask the agent to work on ${projectName}…`
                  : "Ask the agent to work on this project…"
                : SESSION_STATUS_DETAIL[status]
            }
            className="w-full resize-none bg-transparent px-3 py-2.5 text-body-sm text-foreground outline-none placeholder:text-tertiary disabled:cursor-not-allowed disabled:opacity-60"
          />

          <div className="flex items-center gap-2 border-t border-subtle px-2 py-1.5">
            <IconButton
              aria-label="Attach TabDump context"
              className="size-7"
              onClick={onOpenContext}
            >
              <Paperclip />
            </IconButton>

            <span className="min-w-0 flex-1 truncate text-meta text-tertiary">
              {contextSummary ?? "No context attached"}
            </span>

            {cancellable ? (
              <Button type="button" size="xs" variant="outline" onClick={onCancel} disabled={pending}>
                <Square />
                Stop
              </Button>
            ) : (
              <>
                <Kbd className="max-sm:hidden">↵</Kbd>
                <Button
                  type="button"
                  size="icon-xs"
                  aria-label="Send message"
                  disabled={!canSubmit}
                  onClick={submit}
                >
                  <ArrowUp />
                </Button>
              </>
            )}
          </div>
        </div>

        {/*
          The one line that says why the composer is inert.

          Only rendered when it is — a permanent hint under a working composer
          is noise, and this surface has a lot of rows competing already.
        */}
        {!sendable && (
          <p className="mt-1.5 text-body-sm text-tertiary">{SESSION_STATUS_DETAIL[status]}</p>
        )}
      </div>
    </div>
  )
}
