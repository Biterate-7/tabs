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
import { Textarea } from "@/components/ui/textarea"
import { BRIEF_LIMITS } from "@/lib/workspace/brief"

export type NewProjectBrief = { description: string; focus: string }

/**
 * New project (Hubble 2.0): a name, and — optionally — what it is about and
 * what it is for. The two optional lines are the project's brief, which
 * every agent working in it is told. Creating lands the person inside it.
 */
export function NewWorkspaceDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (name: string, brief?: NewProjectBrief) => void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [focus, setFocus] = useState("")

  function reset() {
    setName("")
    setDescription("")
    setFocus("")
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    const brief = description.trim() || focus.trim() ? { description: description.trim(), focus: focus.trim() } : undefined
    onCreate(name, brief)
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>Collect sources from Chrome into it, then let any agent work from them.</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex flex-col gap-3">
            <label className="text-meta text-muted-foreground">
              Project name
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="History IA" className="mt-1" aria-label="Project name" />
            </label>
            <label className="text-meta text-muted-foreground">
              What is it about? <span className="text-tertiary">(optional)</span>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={BRIEF_LIMITS.description}
                placeholder="Investigating the impact of the Cuban Missile Crisis on US–Soviet relations."
                className="mt-1 min-h-14 text-body-sm"
                aria-label="What the project is about"
              />
            </label>
            <label className="text-meta text-muted-foreground">
              Goal or research question <span className="text-tertiary">(optional)</span>
              <Input
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                maxLength={BRIEF_LIMITS.focus}
                placeholder="Build a strong argument from primary and secondary sources."
                className="mt-1"
                aria-label="Goal or research question"
              />
            </label>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
