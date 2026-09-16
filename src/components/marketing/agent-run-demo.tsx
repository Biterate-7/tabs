"use client"

import { useState } from "react"
import { getAgentRunSummary } from "@/lib/agents/intelligence/run-summary"
import { AGENT_STATUS_VISUALS } from "@/components/graph/agent-node-renderer"
import { isTerminalRunStatus } from "@/lib/agents/types"
import type { AgentRunStatus } from "@/lib/agents/types"
import { cn } from "@/lib/utils"
import { AgentIdentity, RunCounts, RunStatusPill, WorkItemRow, WorkProgress } from "./agent-primitives"
import { DEMO_AGENT_INDEX, DEMO_RUN_ID, DEMO_WORKSPACE_NAME, DEMO_WORK_ITEMS } from "./agent-data"
import { DemoWindow } from "./primitives"

/**
 * Demo A: one agent run, and the six states it can be in.
 *
 * The point of letting a visitor drive the status themselves is that the six
 * buttons *are the vocabulary* — `working`, `waiting`, `completed`, `failed`,
 * `blocked`, `cancelled`, straight out of `AgentRunStatus`. There is no
 * seventh, and the labels and glyphs come from the app's own status table, so
 * what a reader learns here is what the product actually says.
 *
 * The two distinctions the demo is built to make legible:
 *
 *  - `working` and `waiting` are both live; the other four are terminal. The
 *    card says which, because "stopped" and "paused" are the difference
 *    between checking on an agent and being blocked by one.
 *  - a run's status is its own. It is never recomputed from the work items
 *    underneath it — the plan below keeps saying what it says while the status
 *    changes above it, exactly as `AgentRunSummary` specifies.
 */

/** In the domain's own order. `working` first because that is where a run starts. */
const STATUSES: AgentRunStatus[] = ["working", "waiting", "blocked", "completed", "failed", "cancelled"]

/** What the run reports it is doing, per status. Absent for states where it is doing nothing. */
const ACTIVITY: Partial<Record<AgentRunStatus, string>> = {
  working: "Scoping stored workspaces to the signed-in account",
  waiting: "Waiting on the production OAuth client id",
  blocked: "Stopped: the production OAuth client id never arrived",
  failed: "Stopped: the auth callback test suite would not pass",
}

export function AgentRunDemo() {
  const [status, setStatus] = useState<AgentRunStatus>("working")
  const summary = getAgentRunSummary(DEMO_AGENT_INDEX, DEMO_RUN_ID)
  const terminal = isTerminalRunStatus(status)
  const activity = ACTIVITY[status]

  return (
    <DemoWindow
      chrome="app"
      title={`${DEMO_WORKSPACE_NAME} — Claude Code`}
      label="An agent run you can move between states"
    >
      <div className="grid gap-px bg-subtle sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* --- The run card --- */}
        <div className="flex min-w-0 flex-col gap-4 bg-card/40 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <AgentIdentity name="Claude Code" provider="claude-code" />
            <RunStatusPill status={status} />
          </div>

          <div>
            <p className="text-[0.9375rem] text-foreground">Implement account sign-in</p>
            {/* Reserved height, so switching to a state with no activity line
                does not collapse the card and jump everything under it. */}
            <p className="mt-1 min-h-[2.5rem] text-body-sm text-tertiary">
              {activity ?? (
                <span className="text-text-disabled">
                  {terminal ? "This run is over." : "Nothing reported right now."}
                </span>
              )}
            </p>
          </div>

          <WorkProgress progress={summary?.progress} />

          <RunCounts
            artifactCount={summary?.artifactCount ?? 0}
            contextTabCount={summary?.contextTabCount ?? 0}
            producedTabCount={summary?.producedTabCount ?? 0}
          />

          <p className="mt-auto text-meta text-tertiary">
            {terminal
              ? "Terminal — this run has ended. Picking the work back up starts a new one."
              : "Live — this run is still going and may change."}
          </p>
        </div>

        {/* --- The plan underneath it ---
            Deliberately inert while the status changes beside it. A viewer who
            expects the items to follow the run is discovering the rule the
            domain is built on: a run's status and its work items are separate
            facts, and neither is derived from the other. */}
        <div className="flex min-w-0 flex-col gap-2 bg-card/40 p-4 sm:p-5">
          <p className="m-label">Work items</p>
          <div className="flex flex-col gap-1.5">
            {DEMO_WORK_ITEMS.map((item) => (
              <WorkItemRow key={item.id} title={item.title} status={item.status} />
            ))}
          </div>
        </div>
      </div>

      {/* --- The control --- */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-subtle px-4 py-3">
        <span className="m-label mr-1">Status</span>
        {STATUSES.map((value) => {
          const active = value === status
          return (
            <button
              key={value}
              type="button"
              onClick={() => setStatus(value)}
              aria-pressed={active}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[0.75rem]",
                "transition-[background-color,border-color,color] duration-(--duration-fast)",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                active
                  ? "border-strong bg-white/[0.07] text-foreground"
                  : "border-subtle text-muted-foreground hover:border-strong/70 hover:text-foreground"
              )}
            >
              <span aria-hidden className="m-num">
                {AGENT_STATUS_VISUALS[value].glyph}
              </span>
              {AGENT_STATUS_VISUALS[value].label}
            </button>
          )
        })}
      </div>
    </DemoWindow>
  )
}
