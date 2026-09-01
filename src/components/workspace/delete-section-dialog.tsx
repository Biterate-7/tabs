"use client"

import { useState } from "react"
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
import { Select } from "@/components/ui/select"

const OTHER_VALUE = "__other__"

/**
 * Deleting a section never deletes tabs (spec §16) — every tab that pointed
 * at this section (or one of its now-removed descendants) is either moved to
 * "Other" (the default) or reassigned to another section the user picks from
 * this workspace's remaining root sections.
 */
export function DeleteSectionDialog({
  open,
  onOpenChange,
  sectionName,
  tabCount,
  otherRootSections,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionName: string
  tabCount: number
  otherRootSections: { id: string; name: string }[]
  onConfirm: (reassignToSectionId?: string) => void
}) {
  const [destination, setDestination] = useState(OTHER_VALUE)

  function handleOpenChange(next: boolean) {
    if (!next) setDestination(OTHER_VALUE)
    onOpenChange(next)
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &quot;{sectionName}&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            {tabCount > 0
              ? `Any subsections are removed too. Its ${tabCount} tab${tabCount === 1 ? "" : "s"} stay in the workspace — choose where they go.`
              : "It has no tabs, so nothing else is affected."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {tabCount > 0 && otherRootSections.length > 0 && (
          <Select
            value={destination}
            onValueChange={setDestination}
            options={[{ value: OTHER_VALUE, label: "Other" }, ...otherRootSections.map((s) => ({ value: s.id, label: s.name }))]}
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => onConfirm(destination === OTHER_VALUE ? undefined : destination)}
          >
            Delete section
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
