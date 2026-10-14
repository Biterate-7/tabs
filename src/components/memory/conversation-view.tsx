"use client"

import { useEffect, useRef } from "react"
import { ProviderMark } from "./provider-mark"
import { aiProviderName } from "@/lib/providers/registry"
import { markMatches } from "@/lib/resources/search"
import { cn } from "@/lib/utils"
import type { AiProviderId } from "@/lib/providers/registry"
import type { ConversationTurn } from "@/lib/resources/types"

/**
 * A saved AI conversation, turn by turn, as it was saved — plain text, never
 * rendered as markup (it is someone else's words and an AI's output, shown
 * as data). The person's turns and the AI's are told apart by label and
 * tone, not by colour alone.
 *
 * Long conversations scroll inside the view; \`focusTurn\` (from a search
 * result) scrolls that turn into view and marks the search words in it.
 */
export function ConversationView({
  turns,
  text,
  provider,
  focusTurn,
  terms = [],
  className,
}: {
  turns?: readonly ConversationTurn[]
  /** A conversation kept as one block (no speaker labels were found). */
  text?: string
  provider?: AiProviderId
  focusTurn?: number
  terms?: readonly string[]
  className?: string
}) {
  const focused = useRef<HTMLLIElement>(null)
  useEffect(() => {
    focused.current?.scrollIntoView?.({ block: "center" })
  }, [focusTurn])

  const ai = provider ? aiProviderName(provider) : "AI"
  if (!turns || turns.length === 0) {
    return (
      <div className={cn("max-h-96 overflow-y-auto rounded-md border border-subtle bg-background p-3", className)} data-conversation-view="text">
        <p className="mb-1 text-meta text-tertiary">Kept as one block of text — who said what wasn&apos;t marked.</p>
        <p className="text-body-sm whitespace-pre-wrap text-foreground">{text ?? ""}</p>
      </div>
    )
  }
  return (
    <ol className={cn("flex max-h-96 flex-col gap-3 overflow-y-auto rounded-md border border-subtle bg-background p-3", className)} aria-label="Conversation" data-conversation-view="turns">
      {turns.map((turn, index) => {
        const mine = turn.role === "user"
        return (
          <li
            key={index}
            ref={index === focusTurn ? focused : undefined}
            data-role={turn.role}
            className={cn("flex flex-col gap-1 rounded-md px-3 py-2", mine ? "bg-surface-hover" : "border border-subtle", index === focusTurn && "ring-2 ring-ring/60")}
          >
            <span className="flex items-center gap-1.5 text-meta text-tertiary">
              {!mine && provider ? <ProviderMark provider={provider} size={12} /> : null}
              {mine ? "You" : ai}
            </span>
            <p className="text-body-sm whitespace-pre-wrap text-foreground">
              {index === focusTurn && terms.length > 0
                ? markMatches(turn.text, terms).map((part, key) =>
                    part.match ? (
                      <mark key={key} className="rounded-xs bg-surface-active px-0.5 text-foreground">
                        {part.text}
                      </mark>
                    ) : (
                      <span key={key}>{part.text}</span>
                    )
                  )
                : turn.text}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

/** "Saved from the page · 2026-10-12" — how and when a conversation came in. */
export function captureLine(capture: "page" | "export" | "paste" | undefined, at: number | undefined): string {
  const how = capture === "page" ? "Saved from the page" : capture === "export" ? "Imported from an export file" : capture === "paste" ? "Pasted" : "Saved"
  return at ? `${how} · ${new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : how
}
