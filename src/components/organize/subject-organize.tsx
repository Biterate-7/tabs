"use client"

import { useEffect, useRef, useState } from "react"
import { Group, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { SmartOrganizeDialog, type SmartOrganizeStatus } from "@/components/organize/smart-organize-dialog"
import { MAX_SMART_ITEMS, itemsFromSubject } from "@/lib/organize/smart/items"
import { proposeSmartOrganization } from "@/lib/organize/smart/group"
import { describeApplied, smartCollectionOperations } from "@/lib/organize/smart/apply"
import { activeGroups } from "@/lib/organize/smart/edit"
import type { CollectionBatchOperation, CollectionBatchResult } from "@/lib/collections/batch"
import type { Collection } from "@/lib/collections/types"
import type { SmartProposal } from "@/lib/organize/smart/types"
import type { Workspace } from "@/lib/workspace/types"

type CollectionStore = {
  applyBatch: (workspaceId: string, operations: readonly CollectionBatchOperation[]) => CollectionBatchResult
  restoreCollections: (workspaceId: string, previous: readonly Collection[], expected: readonly Collection[]) => boolean
}

function analyze(workspace: Workspace, collections: readonly Collection[]): SmartOrganizeStatus {
  try {
    const { items, truncated } = itemsFromSubject(workspace, collections)
    if (items.length === 0) return { kind: "empty", message: "There are no web pages in this subject to organize yet." }
    const proposal = proposeSmartOrganization(items, { mode: "subject", workspace, collections }, { truncated })
    return {
      kind: "ready",
      proposal,
      ...(truncated > 0 ? { note: `Only the first ${MAX_SMART_ITEMS} tabs were looked at; ${truncated} more were left as they are.` } : {}),
    }
  } catch {
    return { kind: "error", message: "Something went wrong while grouping these tabs. Nothing was changed." }
  }
}

/**
 * Smart Organize for one subject's own tabs: loose tabs become collections
 * (new, or the existing one they clearly belong to), through the collection
 * store's all-or-nothing batch. Tabs already in a collection are left alone
 * unless the person moves them. Undo is the store's guarded restore: it puts
 * the subject's collections back exactly, and refuses (changing nothing) if
 * they were edited since.
 *
 * Rendered by WorkspaceView, which owns the collection store — collections
 * have exactly one writer per mounted view (see use-collection-store.ts).
 */
export function SubjectOrganize({
  open,
  onOpenChange,
  workspace,
  collections,
  store,
  onReviewDuplicates,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: Workspace
  /** Every collection (the store's pruned view); this subject's are picked out. */
  collections: readonly Collection[]
  store: CollectionStore
  onReviewDuplicates?: () => void
}) {
  // The store's functions close over the collections of the render that made
  // them; an Undo pressed later must use today's, not those of the moment it
  // was offered.
  const latest = useRef(store)
  useEffect(() => {
    latest.current = store
  })
  // An Undo offered here only makes sense while this subject is on screen —
  // its collection store goes away with the view — so the offer goes too.
  const undoToast = useRef<string | number | null>(null)
  useEffect(
    () => () => {
      if (undoToast.current !== null) toast.dismiss(undoToast.current)
    },
    []
  )

  function apply(proposal: SmartProposal) {
    const own = collections.filter((collection) => collection.workspaceId === workspace.id)
    const { operations, results } = smartCollectionOperations(proposal, workspace, collections)
    const { title, details } = describeApplied(results, "subject")
    if (operations.length === 0) {
      onOpenChange(false)
      toast(title, details.length > 0 ? { description: details.join(" · ") } : undefined)
      return
    }
    const batch = store.applyBatch(workspace.id, operations)
    if (!batch.ok) {
      // All or nothing: nothing was applied. The dialog stays open with the person's edits.
      toast.error("Couldn't organize this subject", { description: "Nothing was changed — its tabs or collections changed while you were reviewing. Close this and try again." })
      return
    }
    onOpenChange(false)
    const after = batch.collections.filter((collection) => collection.workspaceId === workspace.id)
    const notify = results.some((result) => result.error) ? toast.warning : toast
    undoToast.current = notify(title, {
      ...(details.length > 0 ? { description: details.join(" · ") } : {}),
      action: {
        label: "Undo",
        onClick: () => {
          undoToast.current = null
          if (!latest.current.restoreCollections(workspace.id, own, after)) {
            toast.error("Couldn't undo", { description: "These collections have changed since, so nothing was undone." })
          }
        },
      },
    })
  }

  if (!open) return null
  return (
    <SubjectOrganizeSession
      onOpenChange={onOpenChange}
      workspace={workspace}
      collections={collections}
      onConfirm={apply}
      {...(onReviewDuplicates ? { onReviewDuplicates } : {})}
    />
  )
}

function SubjectOrganizeSession({
  onOpenChange,
  workspace,
  collections,
  onConfirm,
  onReviewDuplicates,
}: {
  onOpenChange: (open: boolean) => void
  workspace: Workspace
  collections: readonly Collection[]
  onConfirm: (proposal: SmartProposal) => void
  onReviewDuplicates?: () => void
}) {
  // Analysed once per opening: later store updates (a source finishing its reading) must not reset the person's edits.
  const [status] = useState(() => analyze(workspace, collections))
  const places = collections.filter((collection) => collection.workspaceId === workspace.id).map((collection) => ({ id: collection.id, name: collection.name }))
  return (
    <SmartOrganizeDialog
      open
      onOpenChange={onOpenChange}
      mode="subject"
      status={status}
      places={places}
      onConfirm={onConfirm}
      {...(onReviewDuplicates
        ? {
            onReviewDuplicates: () => {
              onOpenChange(false)
              onReviewDuplicates()
            },
          }
        : {})}
    />
  )
}

/**
 * After a bulk import lands in a subject: one quiet line offering to
 * organize it, shown only when there is something worth organizing. Nothing
 * happens unless the person opens the review.
 */
export function SubjectOrganizeOffer({
  workspace,
  collections,
  onReview,
  onDismiss,
}: {
  workspace: Workspace
  collections: readonly Collection[]
  onReview: () => void
  onDismiss: () => void
}) {
  // Worked out once, when the import lands — not on every store update after it.
  const [groups] = useState(() => {
    const status = analyze(workspace, collections)
    return status.kind === "ready" ? activeGroups(status.proposal).length : 0
  })
  if (groups < 2) return null
  return (
    <div className="mb-4 flex items-center gap-2 rounded-md border border-subtle bg-card px-3 py-2" role="status" data-smart-organize-offer>
      <Group aria-hidden className="size-4 shrink-0 text-tertiary" />
      <p className="min-w-0 flex-1 text-body-sm text-foreground">
        These tabs look like {groups} topics. Sort them into collections?
      </p>
      <Button type="button" size="sm" variant="secondary" onClick={onReview}>
        Review
      </Button>
      <IconButton aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </IconButton>
    </div>
  )
}
