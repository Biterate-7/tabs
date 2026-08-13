import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"

const SHORTCUTS: { keys: string[]; description: string }[] = [
  { keys: ["⌘", "K"], description: "Open the command palette" },
  { keys: ["/"], description: "Focus search" },
  { keys: ["Esc"], description: "Close the palette, a dialog, or exit selection mode" },
  { keys: ["↑", "↓"], description: "Move through results" },
  { keys: ["Enter"], description: "Open the highlighted tab, or run a command" },
  { keys: ["⌘", "A"], description: "Select all visible tabs (in selection mode)" },
]

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <ul className="space-y-2">
          {SHORTCUTS.map((s) => (
            <li key={s.description} className="flex items-center justify-between gap-4">
              <span className="text-body-sm text-muted-foreground">{s.description}</span>
              <Kbd keys={s.keys} />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
