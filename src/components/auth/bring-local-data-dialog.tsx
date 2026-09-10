"use client"

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

/**
 * Offered once, on a first sign-in that finds workspaces already sitting in
 * this browser's signed-out namespace.
 *
 * This is a prompt rather than an automatic migration, and that is a
 * deliberate call in both directions:
 *
 * - Silently copying would be a privacy problem on a shared machine — the
 *   previous person's signed-out tabs would land in the next person's
 *   account without either of them choosing it.
 * - Silently *moving* (copy then delete) would be worse still: it would
 *   take data away from the signed-out state where its owner left it.
 *
 * So the copy is opt-in and non-destructive. Declining costs nothing; the
 * signed-out workspaces stay exactly where they are and reappear the moment
 * the user signs out again, and the offer can be taken later by signing out
 * and back in.
 */
export function BringLocalDataDialog({
  open,
  onOpenChange,
  onConfirm,
  workspaceCount,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  /** How many signed-out workspaces were found, so the prompt names something concrete. Zero means "some data" — see the copy below. */
  workspaceCount: number
}) {
  const countLabel =
    workspaceCount > 0
      ? `${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"}`
      : "workspaces"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bring your {countLabel} in?</DialogTitle>
          <DialogDescription>
            This browser already has {countLabel} saved from before you signed in. TabDump can copy
            them into your account — nothing is moved or deleted, so they stay available when you
            sign out.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Start fresh
          </Button>
          <Button onClick={onConfirm}>Copy them in</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
