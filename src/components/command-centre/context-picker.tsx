"use client"

import { useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  selectionToRequest,
  summarizeSnapshot,
  toggleId,
} from "@/lib/agents/command-centre/context-selection"
import { resolveContext } from "@/lib/agents/context/resolve"
import { cn } from "@/lib/utils"
import type { ContextSelection } from "@/lib/agents/command-centre/context-selection"
import type { AgentContextWorld } from "@/lib/agents/context/world"

/**
 * Choosing what the agent is told.
 *
 * ## Why it previews rather than promises
 *
 * Resolution is a pure function over data already in memory, so the dialog can
 * run the *real* resolver on every keystroke and show what the selection
 * actually produces — including what it drops. That matters because the caps
 * are the part users do not expect: ticking a workspace with four thousand
 * tabs yields a hundred, and a picker that said "Research ✓" and nothing else
 * would be quietly lying about what was attached.
 *
 * The preview uses the same `resolveContext` the attach path uses, with the
 * same limits. There is no second estimate to drift from the truth.
 *
 * ## Why every source is named
 *
 * There is no "attach everything" control, because `AgentContextRequest` has
 * no way to express one and that is deliberate — a request whose meaning
 * depends on how much data the user happens to have is not a request the user
 * can reason about. "Attach this workspace" resolves to the workspace and its
 * tabs, bounded, and says so in the preview.
 */

const GRAPH_DEPTHS = [0, 1, 2, 3] as const

/** "1 tab", "4 tabs". A count with the wrong plural reads as a bug in the count. */
function tabCount(count: number): string {
  return `${count} ${count === 1 ? "tab" : "tabs"}`
}

function CheckRow({
  checked,
  onToggle,
  label,
  detail,
}: {
  checked: boolean
  onToggle: () => void
  label: string
  detail?: string
}) {
  return (
    <label
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
        "hover:bg-surface-hover has-focus-visible:bg-surface-hover"
      )}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{label}</span>
      {detail && <span className="shrink-0 text-meta text-tertiary">{detail}</span>}
    </label>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="py-1.5">
      <h3 className="px-2 pb-1 text-eyebrow text-tertiary">{title}</h3>
      {children}
    </section>
  )
}

export function ContextPicker({
  open,
  onOpenChange,
  world,
  localRuntimeAllowed,
  initialSelection,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  world: AgentContextWorld
  localRuntimeAllowed: boolean
  initialSelection: ContextSelection
  onConfirm: (selection: ContextSelection) => void
}) {
  const [selection, setSelection] = useState<ContextSelection>(initialSelection)
  const [tabQuery, setTabQuery] = useState("")

  /* Tabs of the ticked workspaces. Unticked workspaces contribute nothing to pick from. */
  const availableTabs = useMemo(() => {
    const workspaces = world.workspaces.filter((workspace) =>
      selection.workspaceIds.includes(workspace.id)
    )
    const tabs = workspaces.flatMap((workspace) => workspace.tabs)
    const query = tabQuery.trim().toLowerCase()
    const filtered = query
      ? tabs.filter((tab) => tab.title?.toLowerCase().includes(query) || tab.url?.toLowerCase().includes(query))
      : tabs
    // Bounded for the DOM's sake, not the resolver's — the resolver has its own caps.
    return filtered.slice(0, 100)
  }, [world.workspaces, selection.workspaceIds, tabQuery])

  /*
    The live preview.

    The real resolver, the real limits, the real omissions. Recomputed only
    when the selection changes rather than on every render, because resolution
    walks the whole world.
  */
  const preview = useMemo(() => {
    const request = selectionToRequest(selection, {
      ownerId: world.ownerId,
      workspaceIds: world.workspaces.map((workspace) => workspace.id),
      projectIds: world.projects.map((project) => project.id),
    })
    if (!request) return null

    const resolution = resolveContext(request, world, { localRuntimeAllowed })
    return resolution.ok ? resolution.snapshot : null
  }, [selection, world, localRuntimeAllowed])

  const previewRows = preview ? summarizeSnapshot(preview) : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        `sm:max-w-3xl`, not `max-w-3xl`: DialogContent's own default is
        `sm:max-w-sm`, and tailwind-merge only replaces a class when the
        modifier matches too. A base-variant override loses to it above 640px,
        which squeezed this two-column dialog to 384px and truncated every
        workspace name to nothing.
      */}
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Attach Hubble context</DialogTitle>
          <DialogDescription>
            The agent is told only what you attach here. Everything else in Hubble stays private
            to it.
          </DialogDescription>
        </DialogHeader>

        {/* One column below `sm`: two columns need ~34rem, and a phone's
            dialog is ~22rem wide, so the preview used to be cut off. */}
        <div className="grid max-h-[65vh] grid-cols-1 grid-rows-[minmax(0,1fr)_auto] gap-3 overflow-hidden sm:max-h-[55vh] sm:grid-cols-[minmax(18rem,1fr)_15rem] sm:grid-rows-1 sm:gap-4">
          <div className="min-h-0 overflow-y-auto pr-1">
            <Group title="Workspaces">
              {world.workspaces.length === 0 ? (
                <p className="px-2 text-body-sm text-tertiary">No workspaces yet.</p>
              ) : (
                world.workspaces.map((workspace) => (
                  <CheckRow
                    key={workspace.id}
                    checked={selection.workspaceIds.includes(workspace.id)}
                    onToggle={() =>
                      setSelection((current) => ({
                        ...current,
                        workspaceIds: toggleId(current.workspaceIds, workspace.id),
                      }))
                    }
                    label={workspace.name}
                    detail={tabCount(workspace.tabs.length)}
                  />
                ))
              )}
            </Group>

            <Group title="Collections">
              {world.collections.length === 0 ? (
                <p className="px-2 text-body-sm text-tertiary">No collections yet.</p>
              ) : (
                world.collections.map((collection) => (
                  <CheckRow
                    key={collection.id}
                    checked={selection.collectionIds.includes(collection.id)}
                    onToggle={() =>
                      setSelection((current) => ({
                        ...current,
                        collectionIds: toggleId(current.collectionIds, collection.id),
                      }))
                    }
                    label={collection.name}
                    detail={tabCount(collection.tabIds.length)}
                  />
                ))
              )}
            </Group>

            <Group title="Tabs">
              {selection.workspaceIds.length === 0 ? (
                <p className="px-2 text-body-sm text-tertiary">
                  Choose a workspace first to pick individual tabs.
                </p>
              ) : (
                <>
                  <div className="px-2 pb-1.5">
                    <Input
                      value={tabQuery}
                      onChange={(event) => setTabQuery(event.target.value)}
                      placeholder="Filter tabs…"
                      aria-label="Filter tabs"
                      className="h-7"
                    />
                  </div>
                  {availableTabs.length === 0 ? (
                    <p className="px-2 text-body-sm text-tertiary">No matching tabs.</p>
                  ) : (
                    availableTabs.map((tab) => (
                      <CheckRow
                        key={tab.id}
                        checked={selection.tabIds.includes(tab.id)}
                        onToggle={() =>
                          setSelection((current) => ({
                            ...current,
                            tabIds: toggleId(current.tabIds, tab.id),
                          }))
                        }
                        label={tab.title || tab.url}
                      />
                    ))
                  )}
                </>
              )}
            </Group>

            {/*
              The graph.

              Depth is meaningless without a centre, so the control is the set
              of centres and the depth is a property of it — which is exactly
              how `GraphContextRequest` is shaped.
            */}
            <Group title="Graph">
              {selection.tabIds.length === 0 ? (
                <p className="px-2 text-body-sm text-tertiary">
                  Pick one or more tabs to expand their relationships.
                </p>
              ) : (
                <div className="px-2">
                  <CheckRow
                    checked={selection.graph.centerTabIds.length > 0}
                    onToggle={() =>
                      setSelection((current) => ({
                        ...current,
                        graph: {
                          ...current.graph,
                          centerTabIds:
                            current.graph.centerTabIds.length > 0 ? [] : [...current.tabIds],
                        },
                      }))
                    }
                    label={`Expand ${selection.tabIds.length} selected tabs`}
                  />
                  {selection.graph.centerTabIds.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-1.5" role="group" aria-label="Graph depth">
                      {GRAPH_DEPTHS.map((depth) => (
                        <Button
                          key={depth}
                          type="button"
                          size="xs"
                          variant={selection.graph.depth === depth ? "secondary" : "ghost"}
                          aria-pressed={selection.graph.depth === depth}
                          onClick={() =>
                            setSelection((current) => ({
                              ...current,
                              graph: { ...current.graph, depth },
                            }))
                          }
                        >
                          Depth {depth}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Group>

            <Group title="Agent activity">
              <CheckRow
                checked={selection.activityLimit > 0}
                onToggle={() =>
                  setSelection((current) => ({
                    ...current,
                    activityLimit: current.activityLimit > 0 ? 0 : 10,
                  }))
                }
                label="Recent agent runs"
                detail={`${world.runs.length} known`}
              />
            </Group>

            <Group title="Privacy">
              <CheckRow
                checked={selection.includeNotes}
                onToggle={() =>
                  setSelection((current) => ({ ...current, includeNotes: !current.includeNotes }))
                }
                label="Include my tab notes"
                detail="Off by default"
              />
            </Group>
          </div>

          {/*
            The preview column.

            Deliberately the same summary component the context inspector uses
            after attaching, so what the dialog promises and what the panel
            later reports cannot disagree.
          */}
          <div className="min-h-0 overflow-y-auto rounded-md border border-subtle bg-surface p-2.5">
            <h3 className="text-eyebrow text-tertiary">Will be attached</h3>
            {!preview ? (
              <p className="mt-1.5 text-body-sm text-tertiary">Nothing selected yet.</p>
            ) : (
              <>
                <dl className="mt-1.5">
                  {previewRows.map((row) => (
                    <div key={row.sourceType} className="flex items-baseline justify-between gap-2 py-0.5">
                      <dt className="text-label text-tertiary">{row.label}</dt>
                      <dd className="text-meta text-muted-foreground">
                        {row.detail ?? row.count}
                      </dd>
                    </div>
                  ))}
                </dl>
                {preview.truncated && (
                  <p className="mt-2 text-body-sm text-warning">
                    Some of your selection did not fit and was left out.
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!preview}
            onClick={() => {
              onConfirm(selection)
              onOpenChange(false)
            }}
          >
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
