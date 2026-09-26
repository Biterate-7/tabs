"use client"

import { useCallback, useRef, useState } from "react"
import { ArrowUp, Paperclip, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  SESSION_STATUS_DETAIL,
  SESSION_STATUS_RECOVERY,
  canSendMessage,
} from "@/lib/agents/command-centre/presentation"
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
    <div className="px-6 pt-2 pb-4">
      <div className="mx-auto w-full max-w-[720px]">
        <div
          className={cn(
            "rounded-md border border-border bg-card transition-colors duration-(--duration-fast) ease-(--ease-color)",
            "focus-within:border-strong"
          )}
        >
          <label className="sr-only" htmlFor="command-centre-composer">
            Message the agent
          </label>
          <textarea
            id="command-centre-composer"
            ref={textareaRef}
            rows={2}
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
            className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-body text-foreground outline-none placeholder:text-tertiary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />

          <div className="flex items-center gap-1.5 px-2 pb-2">
            <button
              type="button"
              aria-label="Attach Hubble context"
              onClick={onOpenContext}
              className="flex h-6 min-w-0 max-w-[60%] items-center gap-1.5 rounded-full bg-surface-hover px-2 text-body-sm text-muted-foreground transition-colors duration-(--duration-fast) ease-(--ease-color) outline-none hover:bg-surface-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <Paperclip className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{contextSummary ?? "Add context"}</span>
            </button>

            <span className="min-w-0 flex-1" />

            {cancellable ? (
              <Button type="button" size="xs" shape="pill" variant="secondary" onClick={onCancel} disabled={pending}>
                <Square />
                Stop
              </Button>
            ) : (
              <>
                <Kbd className="max-sm:hidden">↵</Kbd>
                <Button
                  type="button"
                  size="icon-sm"
                  shape="pill"
                  aria-label="Send message"
                  disabled={!canSubmit}
                  onClick={submit}
                  className="disabled:bg-surface-active disabled:text-muted-foreground disabled:opacity-100"
                >
                  <ArrowUp />
                </Button>
              </>
            )}
          </div>
        </div>

        {/*
          Why the composer is inert — said once.

          This used to be a second copy of `SESSION_STATUS_DETAIL[status]`,
          which the disabled textarea is already showing as its placeholder, so
          a blocked session printed the same sentence twice, ten pixels apart.
          The placeholder is the better of the two positions (it is inside the
          control it explains), so the line below it now carries the part the
          placeholder cannot: what the user can do about it.
        */}
        {!sendable && SESSION_STATUS_RECOVERY[status] && (
          <p className="mt-1.5 text-body-sm text-tertiary">{SESSION_STATUS_RECOVERY[status]}</p>
        )}
      </div>
    </div>
  )
}
