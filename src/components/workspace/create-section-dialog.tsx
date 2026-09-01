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

export function CreateSectionDialog({
  open,
  onOpenChange,
  parentName,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Name of the section this will be created under — null for a new top-level (category) section. */
  parentName: string | null
  onCreate: (name: string) => void
}) {
  const [name, setName] = useState("")

  function handleOpenChange(next: boolean) {
    if (!next) setName("")
    onOpenChange(next)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onCreate(name)
    setName("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{parentName ? `New subsection in ${parentName}` : "New section"}</DialogTitle>
            <DialogDescription>
              {parentName ? `Give it a name, like "Physics" or "S2 Orbit Research".` : `Give it a name, like "School" or "Projects".`}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Section name"
            className="mt-4"
          />
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              Create section
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
