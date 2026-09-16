"use client"

import { useState } from "react"
import { getWorkspaceActivityCards } from "@/lib/agents/intelligence/workspace-activity"
import { getHighlightedObjectIds } from "@/lib/agents/intelligence/relationships"
import { cn } from "@/lib/utils"
import { AgentIdentity, ArtifactRow, RunCounts, RunStatusPill, WorkItemRow } from "./agent-primitives"
import {
  DEMO_AGENT_INDEX,
  DEMO_ALL_ARTIFACT_SEEDS,
  DEMO_ALL_WORK_ITEMS,
  DEMO_CONTEXT_TABS,
  DEMO_PRIOR_CONTEXT_TABS,
  DEMO_PRODUCED_TABS,
  DEMO_WORKSPACE_ID,
  DEMO_WORKSPACE_NAME,
} from "./agent-data"
import { DEMO_UNIQUE_TABS } from "./data"
import { DemoTabRow, DemoWindow } from "./primitives"

/**
 * Demo B: select a run, and watch the workspace answer.
 *
 * The highlight is not scripted. Selecting a run calls the product's
 * `getHighlightedObjectIds`, which walks the same evidence-backed relationship
 * set the spatial canvas walks — a work item's `runId`, an artifact link, a tab
 * link — and every row below checks its own id against what comes back. The set
 * that lights up here is, by construction, the set that would light up in the
 * app. The two run cards come from `getWorkspaceActivityCards`, which is the
 * same view model the product builds its own run list from.
 *
 * ## Why there are two runs
 *
 * With one, selecting it would highlight every object on screen and the question
 * "what does this touch?" would look rhetorical. Two runs make the answer a real
 * subset — and they show the domain's central modelling decision along the way:
 * one persistent agent identity, many runs.
 *
 * ## The absence worth noticing
 *
 * Selecting a run highlights its files and its tabs. Selecting a single *work
 * item* does not highlight the files worked on for it — and cannot, because
 * nothing observes which file was touched for which task. The domain refuses to
 * join them through the shared run, since that would assert a plausible edge
 * between every (item, file) pair in it. This demo does the same.
 */

/** Tabs in the workspace that neither run touched, so the highlight has something to be a subset of. */
const UNTOUCHED_TABS = DEMO_UNIQUE_TABS.filter(
  (t) =>
    t.section === "Development" &&
    ![...DEMO_CONTEXT_TABS, ...DEMO_PRODUCED_TABS, ...DEMO_PRIOR_CONTEXT_TABS].some(
      (used) => used.id === t.id
    )
).slice(0, 3)

const ALL_TABS = [
  ...DEMO_CONTEXT_TABS,
  ...UNTOUCHED_TABS,
  ...DEMO_PRODUCED_TABS,
  ...DEMO_PRIOR_CONTEXT_TABS,
]

/** Both runs, as the product's own activity cards. Newest first — the index's order. */
const RUN_CARDS = getWorkspaceActivityCards(DEMO_AGENT_INDEX, DEMO_WORKSPACE_ID)

export function ImpactDemo() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(RUN_CARDS[0]?.runId ?? null)

  const highlighted = getHighlightedObjectIds(DEMO_AGENT_INDEX, selectedRunId)
  // Nothing selected means nothing dimmed — the workspace at rest, not an empty one.
  const dimming = selectedRunId !== null

  return (
    <DemoWindow
      chrome="app"
      title={`${DEMO_WORKSPACE_NAME} — workspace impact`}
      label="Selecting an agent run highlights everything it touched"
    >
      <div className="grid gap-px bg-subtle lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {/* --- The runs --- */}
        <div className="flex min-w-0 flex-col gap-3 bg-card/40 p-4">
          <p className="m-label">Agent runs · {RUN_CARDS.length}</p>
          <div className="flex flex-col gap-2">
            {RUN_CARDS.map((card) => {
              const selected = card.runId === selectedRunId
              return (
                <button
                  key={card.runId}
                  type="button"
                  onClick={() => setSelectedRunId(selected ? null : card.runId)}
                  aria-pressed={selected}
                  className={cn(
                    "flex flex-col gap-2 rounded-xl border p-3 text-left",
                    "transition-[border-color,background-color] duration-(--duration-base) ease-(--ease-standard)",
                    "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    selected
                      ? "border-[color-mix(in_oklch,var(--primary),transparent_40%)] bg-accent-subtle"
                      : "border-subtle bg-card/60 hover:border-strong/60"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <AgentIdentity name={card.agentName} provider={card.provider} size="sm" />
                    <RunStatusPill status={card.status} size="sm" />
                  </div>
                  <span className="text-body-sm text-foreground">{card.label}</span>
                  <RunCounts
                    artifactCount={card.artifactCount}
                    contextTabCount={card.contextTabCount}
                    producedTabCount={card.producedTabCount}
                  />
                </button>
              )
            })}
          </div>

          <p className="m-label mt-2">Work items · {DEMO_ALL_WORK_ITEMS.length}</p>
          <div className="flex flex-col gap-1.5">
            {DEMO_ALL_WORK_ITEMS.map((item) => (
              <WorkItemRow
                key={item.id}
                title={item.title}
                status={item.status}
                wrap
                highlighted={highlighted.workItemIds.has(item.id)}
                dimmed={dimming && !highlighted.workItemIds.has(item.id)}
              />
            ))}
          </div>
        </div>

        {/* --- Files --- */}
        <div className="flex min-w-0 flex-col gap-3 bg-card/40 p-4">
          <p className="m-label">Files · {DEMO_ALL_ARTIFACT_SEEDS.length}</p>
          <div className="flex flex-col gap-1.5">
            {DEMO_ALL_ARTIFACT_SEEDS.map((seed) => (
              <ArtifactRow
                key={seed.id}
                relativePath={seed.path}
                roles={seed.roles}
                highlighted={highlighted.artifactIds.has(seed.id)}
                dimmed={dimming && !highlighted.artifactIds.has(seed.id)}
              />
            ))}
          </div>
          <p className="mt-auto pt-3 text-meta text-tertiary">
            TabDump records that a run touched a file, and how. Never what the file says.
          </p>
        </div>

        {/* --- Tabs --- */}
        <div className="flex min-w-0 flex-col gap-3 bg-card/40 p-4">
          <p className="m-label">Tabs · {ALL_TABS.length}</p>
          <div className="flex flex-col gap-1.5">
            {ALL_TABS.map((tab) => (
              <DemoTabRow
                key={tab.id}
                domain={tab.domain}
                title={tab.title}
                category={tab.category}
                size="sm"
                highlighted={highlighted.tabIds.has(tab.id)}
                dimmed={dimming && !highlighted.tabIds.has(tab.id)}
              />
            ))}
          </div>
          <p className="mt-auto pt-3 text-meta text-tertiary">
            Context in, work out — the same tabs you had open, attached to what was done with them.
          </p>
        </div>
      </div>
    </DemoWindow>
  )
}
