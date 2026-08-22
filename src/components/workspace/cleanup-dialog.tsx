"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import {
  computeCleanupSummary,
  defaultSelection,
  findDuplicateGroups,
  removalIds,
} from "@/lib/workspace/cleanup"
import type { CleanupSelection } from "@/lib/workspace/cleanup"
import type { Tab } from "@/lib/tabs/types"

function tabsLabel(n: number) {
  return `${n} tab${n === 1 ? "" : "s"}`
}

function copiesLabel(n: number) {
  return `${n} ${n === 1 ? "copy" : "copies"}`
}

/**
 * Mounted only while the dialog is open, so stage/selection state is always
 * fresh for a new cleanup session without needing a reset effect.
 */
function CleanupBody({
  tabs,
  onKeepAll,
  onRequestRemove,
}: {
  tabs: Tab[]
  onKeepAll: () => void
  onRequestRemove: (ids: string[]) => void
}) {
  const groups = useMemo(() => findDuplicateGroups(tabs), [tabs])
  const summary = useMemo(() => computeCleanupSummary(tabs), [tabs])

  const [stage, setStage] = useState<"summary" | "review">("summary")
  const [selection, setSelection] = useState<CleanupSelection>(() =>
    defaultSelection(groups)
  )

  const toRemove = removalIds(groups, selection)
  const hasDuplicates = summary.groupCount > 0

  function keepCopy(groupKey: string, tabId: string) {
    setSelection((s) => ({ ...s, keepIds: { ...s.keepIds, [groupKey]: tabId } }))
  }

  function toggleGroup(groupKey: string, skip: boolean) {
    setSelection((s) => ({
      ...s,
      skippedKeys: skip
        ? [...s.skippedKeys, groupKey]
        : s.skippedKeys.filter((k) => k !== groupKey),
    }))
  }

  const stats = [
    { label: "tabs", value: summary.total },
    { label: "unique", value: summary.unique },
    { label: "duplicates", value: summary.duplicates },
    { label: "need review", value: summary.needsReview },
  ]

  return (
    <>
      <DialogHeader className="shrink-0">
        <DialogTitle>
          {hasDuplicates
            ? "Your workspace can be cleaned up."
            : "Nothing to clean up."}
        </DialogTitle>
        <DialogDescription>
          {hasDuplicates
            ? `${summary.groupCount} duplicate group${summary.groupCount === 1 ? "" : "s"} found. Nothing is removed until you confirm.`
            : "No duplicate tabs found in this workspace."}
        </DialogDescription>
      </DialogHeader>

      {stage === "summary" ? (
        <div className="grid grid-cols-2 gap-4 py-2 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label}>
              <p className="text-2xl font-semibold tracking-tight text-foreground">
                {stat.value}
              </p>
              <p className="text-xs text-tertiary">{stat.label}</p>
            </div>
          ))}
        </div>
      ) : (
        <ScrollArea className="h-[45vh] pr-2">
          <div className="space-y-3">
            {groups.map((group) => {
              const skipped = selection.skippedKeys.includes(group.key)
              return (
                <div
                  key={group.key}
                  className="rounded-lg border border-subtle bg-card p-3"
                >
                  <div className="flex items-start gap-3">
                    <TabFavicon domain={group.domain} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {group.title?.trim() || group.domain}
                      </p>
                      <p className="truncate text-xs text-tertiary">
                        {group.domain}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {copiesLabel(group.count)}
                      </p>
                    </div>
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                      <Checkbox
                        checked={skipped}
                        onCheckedChange={(checked) =>
                          toggleGroup(group.key, checked === true)
                        }
                      />
                      Keep all
                    </label>
                  </div>

                  <ul className="mt-2 space-y-1 border-t border-subtle pt-2">
                    {group.tabs.map((tab) => {
                      const kept = selection.keepIds[group.key] === tab.id
                      const keeping = kept || skipped
                      return (
                        <li key={tab.id} className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            disabled={skipped}
                            aria-label={`Keep this copy of ${group.domain}`}
                            onClick={() => keepCopy(group.key, tab.id)}
                            className={
                              "shrink-0 rounded-md border px-2 py-1 text-label transition-colors disabled:cursor-not-allowed " +
                              (keeping
                                ? "border-primary/30 bg-primary/15 text-accent-text"
                                : "border-subtle text-tertiary hover:text-foreground")
                            }
                          >
                            {keeping ? "Keep" : "Remove"}
                          </button>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {tab.url}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      )}

      <DialogFooter className="shrink-0">
        {stage === "summary" ? (
          <>
            <Button variant="ghost" onClick={onKeepAll}>
              Keep all
            </Button>
            <Button disabled={!hasDuplicates} onClick={() => setStage("review")}>
              Review manually
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStage("summary")}>
              Back
            </Button>
            <Button
              disabled={toRemove.length === 0}
              onClick={() => onRequestRemove(toRemove)}
            >
              Remove selected ({toRemove.length})
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  )
}

export function CleanupDialog({
  open,
  onOpenChange,
  tabs,
  onRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabs: Tab[]
  onRemove: (ids: string[]) => void
}) {
  const [pendingIds, setPendingIds] = useState<string[] | null>(null)

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] w-full flex-col overflow-hidden sm:max-w-lg">
          {open && (
            <CleanupBody
              tabs={tabs}
              onKeepAll={() => onOpenChange(false)}
              onRequestRemove={setPendingIds}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingIds !== null}
        onOpenChange={(next) => {
          if (!next) setPendingIds(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {tabsLabel(pendingIds?.length ?? 0)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              One copy of each duplicate stays in your workspace. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const ids = pendingIds ?? []
                setPendingIds(null)
                onOpenChange(false)
                onRemove(ids)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
