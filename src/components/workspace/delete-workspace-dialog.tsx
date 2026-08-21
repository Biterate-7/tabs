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

export function DeleteWorkspaceDialog({
  open,
  onOpenChange,
  workspaceName,
  tabCount,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceName: string
  tabCount: number
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &quot;{workspaceName}&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the workspace and its {tabCount} tab{tabCount === 1 ? "" : "s"}, including
            what&apos;s saved locally. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete workspace
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
