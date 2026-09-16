"use client"

import { useState } from "react"
import { RotateCcw } from "lucide-react"
import { countWorkItems, deriveWorkProgress, selectPrimaryWorkItem } from "@/lib/agents/intelligence/run-summary"
import { WORK_ITEM_STATUS_VISUALS } from "@/components/graph/agent-node-renderer"
import type { AgentWorkItem, AgentWorkItemStatus } from "@/lib/agents/types"
import { cn } from "@/lib/utils"
import { WorkItemGlyph, WorkProgress, workItemColor } from "./agent-primitives"
import { DEMO_WORKSPACE_NAME, DEMO_WORK_ITEMS } from "./agent-data"
import { DemoWindow, mButtonClass } from "./primitives"

/**
 * Work tracking: a plan, and the progress the product is willing to claim.
 *
 * Everything the panel reports is computed here by the app's own functions —
 * `countWorkItems`, `deriveWorkProgress`, `selectPrimaryWorkItem` — over
 * whatever the visitor has clicked into place. Nothing is precomputed and
 * nothing is typed into the markup, which means the demo cannot drift from
 * the product and cannot be caught claiming a number the product would not.
 *
 * Two rules become visible by playing with it, and both are rules the domain
 * enforces rather than presentation choices:
 *
 *  - **Cancelled work counts toward neither side.** Cancel an item and the
 *    denominator drops; a plan whose last tasks were abandoned can still read
 *    as finished, which is the honest answer.
 *  - **No countable work means no number.** Cancel everything and the bar
 *    disappears rather than showing 0%. A zero looks like a measurement, and
 *    there would not have been one.
 */

/** Click order. Blocked is reachable from any state — it is a thing that happens to work, not a stage of it. */
const NEXT: Record<AgentWorkItemStatus, AgentWorkItemStatus> = {
  pending: "active",
  active: "completed",
  completed: "cancelled",
  cancelled: "pending",
  blocked: "active",
}

export function WorkPlanDemo() {
  const [items, setItems] = useState<AgentWorkItem[]>(DEMO_WORK_ITEMS)

  function cycle(id: string) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, status: NEXT[item.status] } : item))
    )
  }

  const counts = countWorkItems(items)
  const progress = deriveWorkProgress(items)
  const primary = selectPrimaryWorkItem(items)

  return (
    <DemoWindow
      chrome="app"
      title={`${DEMO_WORKSPACE_NAME} — Implement account sign-in`}
      label="A run's work items, with progress derived from them"
      toolbar={
        <button
          type="button"
          onClick={() => setItems(DEMO_WORK_ITEMS)}
          className={cn(mButtonClass("ghost"), "h-7 px-2.5 text-[0.75rem]")}
        >
          <RotateCcw />
          Reset
        </button>
      }
    >
      <div className="grid gap-px bg-subtle lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* --- The plan --- */}
        <div className="flex min-w-0 flex-col gap-1.5 bg-card/40 p-4 sm:p-5">
          {items.map((item) => {
            const isPrimary = primary?.id === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => cycle(item.id)}
                className={cn(
                  "group/item flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left",
                  "transition-[border-color,background-color] duration-(--duration-base) ease-(--ease-standard)",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  isPrimary
                    ? "border-[color-mix(in_oklch,var(--primary),transparent_50%)] bg-accent-subtle"
                    : "border-subtle bg-card/60 hover:border-strong/60"
                )}
              >
                <WorkItemGlyph status={item.status} />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-body-sm",
                      item.status === "completed" || item.status === "cancelled"
                        ? "text-muted-foreground"
                        : "text-foreground"
                    )}
                  >
                    {item.title}
                  </span>
                  {item.summary && (
                    <span className="mt-0.5 block text-meta text-tertiary">{item.summary}</span>
                  )}
                </span>
                <span
                  className="m-num shrink-0 text-[0.625rem] tracking-[0.04em] uppercase"
                  style={{ color: workItemColor(item.status) }}
                >
                  {WORK_ITEM_STATUS_VISUALS[item.status].label}
                </span>
              </button>
            )
          })}
        </div>

        {/* --- What the product says about it --- */}
        <div className="flex min-w-0 flex-col gap-5 bg-card/40 p-4 sm:p-5">
          <div>
            <p className="m-label">Progress</p>
            <div className="mt-2.5 min-h-[1.5rem]">
              {progress ? (
                <WorkProgress progress={progress} />
              ) : (
                <p className="text-body-sm text-tertiary">
                  Nothing countable — so no number, rather than 0%.
                </p>
              )}
            </div>
          </div>

          <div>
            <p className="m-label">Needs attention</p>
            <div className="mt-2.5 min-h-[2.5rem]">
              {primary ? (
                <>
                  <p className="text-body-sm text-foreground">{primary.title}</p>
                  <p
                    className="m-num mt-1 text-[0.6875rem] tracking-[0.04em] uppercase"
                    style={{ color: workItemColor(primary.status) }}
                  >
                    {WORK_ITEM_STATUS_VISUALS[primary.status].label}
                  </p>
                </>
              ) : (
                <p className="text-body-sm text-tertiary">Nothing tracked.</p>
              )}
            </div>
          </div>

          <div>
            <p className="m-label">Breakdown</p>
            <dl className="mt-2.5 flex flex-col gap-1.5">
              {(["active", "blocked", "pending", "completed", "cancelled"] as const).map((key) => (
                <div key={key} className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
                    <span aria-hidden className="m-num" style={{ color: workItemColor(key) }}>
                      {WORK_ITEM_STATUS_VISUALS[key].glyph}
                    </span>
                    {WORK_ITEM_STATUS_VISUALS[key].label}
                  </dt>
                  <dd
                    className={cn(
                      "m-num text-body-sm",
                      counts[key] > 0 ? "text-foreground" : "text-text-disabled"
                    )}
                  >
                    {counts[key]}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </DemoWindow>
  )
}
