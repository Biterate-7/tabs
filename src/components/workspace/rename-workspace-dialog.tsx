"use client"

import { useState, type FormEvent } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function RenameWorkspaceDialog({
  open,
  onOpenChange,
  currentName,
  onRename,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentName: string
  onRename: (name: string) => void
}) {
  // Callers key this component by workspace id (see workspace-switcher.tsx),
  // so a fresh mount — and thus a fresh `currentName` seed — happens
  // whenever the target workspace changes, without needing an effect to
  // re-sync state that a remount already resets for free.
  const [name, setName] = useState(currentName)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onRename(name)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            className="mt-4"
          />
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
