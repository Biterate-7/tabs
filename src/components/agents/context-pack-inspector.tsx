"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  contextDeliveryLine,
  contextPackLine,
  contextPackOmittedLine,
  contextPackRows,
} from "@/lib/agents/context-pack/present"
import { cn } from "@/lib/utils"
import type { ContextPack } from "@/lib/agents/context-pack/pack"
import type { ContextDeliveryState, ContextPackRow, ContextPackRowKey } from "@/lib/agents/context-pack/present"

/**
 * The Context Inspector (Hubble 1.5): exactly what Hubble gives an agent
 * about the workspace — the Context Pack, in words.
 *
 *     Workspace        Research
 *                      Research and organize sources for the climate…
 *     Focus            Comparing carbon-pricing approaches
 *     Context          Custom
 *     Collections      Pricing Research, Competitors
 *     Tabs             8 selected
 *     Files            None
 *     Recent changes   2
 *     Previous result  Available · Finished
 *     Instruction      “Compare the pricing models…”
 *     ─────────────────────────────────────────────
 *     Claude Code has this context
 *
 * A transparent view, not a chat surface: label/value rows in the context
 * panel's own vocabulary, every value from the pack (`contextPackRows`), and
 * nothing that is not in it. The same component renders in the Command
 * Centre's context panel and chip, the handoff dialog and the landing page's
 * demo, so the four can never describe a pack differently.
 */

/** How many names a row lists before "and N more". */
const SHOWN_ITEMS = 3

function Items({ row }: { row: ContextPackRow }) {
  const [all, setAll] = useState(false)
  const items = row.items ?? []
  if (items.length === 0) return null
  const shown = all ? items : items.slice(0, SHOWN_ITEMS)
  const hidden = items.length - shown.length
  return (
    <ul aria-label={row.label} className="mt-0.5 flex min-w-0 flex-col">
      {shown.map((item, index) => (
        <li key={`${index}:${item}`} className="truncate text-meta text-muted-foreground" title={item}>
          {item}
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <button
            type="button"
            className="rounded-xs text-meta text-tertiary outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            onClick={() => setAll(true)}
          >
            and {hidden} more
          </button>
        </li>
      )}
    </ul>
  )
}

/** Rows whose value is itself the list (collections are named inline); their items repeat it with counts. */
const LIST_ROWS: ReadonlySet<ContextPackRowKey> = new Set(["tabs", "files", "recentChanges", "previousResult"])

export function ContextPackInspector({
  pack,
  agentName,
  state,
  loading = false,
  unavailable,
  hide = [],
  onSendUpdate,
  busy = false,
  className,
}: {
  /** `null` while there is no pack: loading, or a session with no workspace. */
  pack: ContextPack | null
  agentName: string
  /** Where the session's context stands. Absent: a preview, nothing sent yet. */
  state?: ContextDeliveryState
  loading?: boolean
  /** Why there is no pack, in one sentence, when it is not loading. */
  unavailable?: string
  /** Rows a host shows elsewhere (the handoff dialog's own instruction box). */
  hide?: readonly ContextPackRowKey[]
  /** Sends the current pack to the agent when it has an older one. */
  onSendUpdate?: () => void
  busy?: boolean
  className?: string
}) {
  if (!pack) {
    return (
      <p className={cn("text-body-sm text-tertiary", className)} role={loading ? "status" : undefined}>
        {loading ? "Preparing context…" : (unavailable ?? "No Hubble context for this session.")}
      </p>
    )
  }

  const rows = contextPackRows(pack).filter((row) => !hide.includes(row.key))
  const omitted = contextPackOmittedLine(pack)
  const empty = pack.workspace.tabs === 0

  return (
    <div className={cn("flex min-w-0 flex-col", className)} data-context-pack={pack.fingerprint}>
      <p className="sr-only">Context: {contextPackLine(pack)}</p>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="pt-px text-meta text-tertiary">{row.label}</dt>
            <dd className="min-w-0">
              <span
                className={cn(
                  "block text-body-sm",
                  row.empty ? "text-tertiary" : "text-foreground",
                  row.key === "instruction" || row.key === "workspace" || row.key === "focus" ? "line-clamp-2 break-words" : "truncate"
                )}
                title={row.value}
              >
                {row.value}
              </span>
              {row.detail && <span className="mt-0.5 line-clamp-2 block break-words text-meta text-muted-foreground">{row.detail}</span>}
              {LIST_ROWS.has(row.key) && <Items row={row} />}
            </dd>
          </div>
        ))}
      </dl>
      {empty && <p className="mt-1.5 text-meta text-tertiary">This workspace has no tabs yet, so there is nothing to read.</p>}
      {omitted && <p className="mt-1.5 text-meta text-tertiary">{omitted}</p>}
      {state && (
        <div className="mt-2 flex min-h-6 items-center justify-between gap-2 border-t border-subtle pt-2">
          <span
            className={cn("min-w-0 truncate text-meta", state === "changed" ? "text-link" : "text-tertiary")}
            data-context-state={state}
          >
            {contextDeliveryLine(state, agentName)}
          </span>
          {state === "changed" && onSendUpdate && (
            <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={onSendUpdate}>
              Send update
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
