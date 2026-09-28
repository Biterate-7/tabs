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
import { toggleId } from "@/lib/agents/command-centre/context-selection"
import {
  WORKING_CONTEXT_LIMITS,
  describeWorkingContext,
  summarizeWorkingContext,
} from "@/lib/agents/command-centre/working-context"
import { cn } from "@/lib/utils"
import type { WorkingContext } from "@/lib/agents/command-centre/working-context"
import type { Collection } from "@/lib/collections/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Choosing what, inside one workspace, an agent is pointed at.
 *
 * ## One workspace — the session's
 *
 * This used to list every workspace in the account, and a session could be
 * sent tabs from a workspace it was not working in. Now the chooser is opened
 * *for* a workspace — the one the session is bound to — and offers only its
 * collections and tabs. There is no control here that could reach another,
 * and the runtime refuses one anyway.
 *
 * ## Why there is no "everything" box
 *
 * "Use whole workspace" is the everything: the session reads the workspace
 * itself when it needs to, so nothing is pasted into its messages. This
 * dialog is for pointing it at *part* of it, and says what that part is by
 * name before anything is sent.
 */

/** How many tabs the list renders at once — the DOM's bound, not the context's. */
const TAB_ROWS = 100

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
  workspace,
  collections,
  dependencies = [],
  initial,
  agentName = "The agent",
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The session's workspace — the only one offered. */
  workspace: Workspace | null
  collections: readonly Collection[]
  dependencies?: readonly TabDependency[]
  initial: WorkingContext
  agentName?: string
  onConfirm: (context: WorkingContext) => void
}) {
  const [tabIds, setTabIds] = useState<readonly string[]>(initial.tabIds)
  const [collectionIds, setCollectionIds] = useState<readonly string[]>(initial.collectionIds)
  const [query, setQuery] = useState("")

  const own = useMemo(
    () => (workspace ? collections.filter((collection) => collection.workspaceId === workspace.id) : []),
    [collections, workspace]
  )

  const shownTabs = useMemo(() => {
    const tabs = workspace?.tabs ?? []
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? tabs.filter((tab) => tab.title?.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle))
      : tabs
    return filtered.slice(0, TAB_ROWS)
  }, [query, workspace])

  const workspaceId = initial.workspaceId
  const chosen: WorkingContext = useMemo(() => ({ workspaceId, tabIds, collectionIds }), [workspaceId, tabIds, collectionIds])
  const preview = useMemo(
    () =>
      describeWorkingContext(chosen, {
        workspaces: workspace ? [workspace] : [],
        collections: own,
        dependencies,
      }),
    [chosen, workspace, own, dependencies]
  )
  const nothingChosen = tabIds.length === 0 && collectionIds.length === 0
  const overTabs = tabIds.length > WORKING_CONTEXT_LIMITS.tabs

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        `sm:max-w-2xl`, not `max-w-2xl`: DialogContent's own default is
        `sm:max-w-sm`, and tailwind-merge only replaces a class when the
        modifier matches too.
      */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose context</DialogTitle>
          <DialogDescription>
            {workspace
              ? `From ${workspace.name}. ${agentName} is sent what you choose with your next message.`
              : "This session's workspace no longer exists."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[65vh] grid-cols-1 grid-rows-[minmax(0,1fr)_auto] gap-3 overflow-hidden sm:max-h-[55vh] sm:grid-cols-[minmax(16rem,1fr)_13rem] sm:grid-rows-1 sm:gap-4">
          <div className="min-h-0 overflow-y-auto pr-1">
            <Group title="Collections">
              {own.length === 0 ? (
                <p className="px-2 text-body-sm text-tertiary">No collections in this workspace.</p>
              ) : (
                own.map((collection) => (
                  <CheckRow
                    key={collection.id}
                    checked={collectionIds.includes(collection.id)}
                    onToggle={() => setCollectionIds((current) => toggleId(current, collection.id))}
                    label={collection.name}
                    detail={`${collection.tabIds.length} ${collection.tabIds.length === 1 ? "tab" : "tabs"}`}
                  />
                ))
              )}
            </Group>

            <Group title="Tabs">
              <div className="px-2 pb-1.5">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter tabs…"
                  aria-label="Filter tabs"
                  className="h-7"
                />
              </div>
              {shownTabs.length === 0 ? (
                <p className="px-2 text-body-sm text-tertiary">No matching tabs.</p>
              ) : (
                shownTabs.map((tab) => (
                  <CheckRow
                    key={tab.id}
                    checked={tabIds.includes(tab.id)}
                    onToggle={() => setTabIds((current) => toggleId(current, tab.id))}
                    label={tab.title || tab.url}
                    detail={tab.domain}
                  />
                ))
              )}
            </Group>
          </div>

          <div className="min-h-0 overflow-y-auto rounded-md border border-subtle bg-surface p-2.5">
            <h3 className="text-eyebrow text-tertiary">Will be sent</h3>
            <p className="mt-1.5 text-body-sm text-foreground">
              {nothingChosen ? "Nothing chosen yet." : summarizeWorkingContext(preview)}
            </p>
            {preview.relationships.length > 0 && (
              <p className="mt-1 text-meta text-tertiary">
                {preview.relationships.length} {preview.relationships.length === 1 ? "relationship" : "relationships"} between them
              </p>
            )}
            {overTabs && (
              <p className="mt-2 text-body-sm text-warning">
                Only the first {WORKING_CONTEXT_LIMITS.tabs} tabs are sent.
              </p>
            )}
            <p className="mt-2 text-meta text-tertiary">Titles and addresses only — never your notes, and never page contents.</p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!workspace}
            onClick={() => {
              onConfirm({ workspaceId, tabIds: [], collectionIds: [] })
              onOpenChange(false)
            }}
          >
            Use whole workspace
          </Button>
          <Button
            type="button"
            disabled={!workspace || nothingChosen}
            onClick={() => {
              onConfirm(chosen)
              onOpenChange(false)
            }}
          >
            Use these
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
