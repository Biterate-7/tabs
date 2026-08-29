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

export function DeleteCollectionDialog({
  open,
  onOpenChange,
  collectionName,
  tabCount,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  collectionName: string
  tabCount: number
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &quot;{collectionName}&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the collection grouping. {tabCount > 0
              ? `Its ${tabCount} tab${tabCount === 1 ? "" : "s"} stay in the workspace, ungrouped.`
              : "It has no tabs, so nothing else is affected."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete collection
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
