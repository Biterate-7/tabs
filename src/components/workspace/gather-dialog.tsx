"use client"

import { useState, type FormEvent } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Backs both collection-creation entry points (AGENTS.md-style spec section
 * "COLLECTION CREATION"): Gather (tabCount > 0, seeded from the current
 * selection) and New collection (tabCount 0, empty). Both funnel into the
 * same onConfirm — there is exactly one place that turns a name into a
 * collection (see useCollectionStore.createCollection), this dialog just
 * collects the name.
 */
export function GatherDialog({
  open,
  onOpenChange,
  tabCount,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabCount: number
  onConfirm: (name: string) => void
}) {
  const [name, setName] = useState("")
  const isGather = tabCount > 0

  function handleOpenChange(next: boolean) {
    if (!next) setName("")
    onOpenChange(next)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onConfirm(name)
    setName("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isGather ? `Gather ${tabCount} tab${tabCount === 1 ? "" : "s"}` : "New collection"}</DialogTitle>
            <DialogDescription>
              {isGather
                ? "Give this collection a name — the selected tabs will move into it."
                : "Give it a name, like “Physics IA”. You can add tabs afterward."}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Collection name"
            className="mt-4"
          />
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              {isGather ? "Gather" : "Create collection"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
