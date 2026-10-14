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
import { Textarea } from "@/components/ui/textarea"
import { BRIEF_LIMITS } from "@/lib/workspace/brief"

export type NewProjectBrief = { description: string; focus: string }

/**
 * New subject: a name, and nothing else in the way.
 *
 * A subject is a workspace (see lib/product/subjects.ts). Its brief — what it
 * is about and the current goal, which every AI working in it is told — is
 * still here, one click away under "Add details", because almost nobody
 * creating "Math AA HL" wants to write two paragraphs first. Creating lands
 * the person inside it.
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
  const [details, setDetails] = useState(false)
  const [description, setDescription] = useState("")
  const [focus, setFocus] = useState("")

  function reset() {
    setName("")
    setDetails(false)
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
          </DialogHeader>
          <div className="mt-4 flex flex-col gap-3">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. History HL"
              className="h-9 text-body"
              aria-label="Project name"
            />
            {details ? (
              <>
                <label className="text-meta text-muted-foreground">
                  What is it about?
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={BRIEF_LIMITS.description}
                    placeholder="The causes and consequences of the First World War."
                    className="mt-1 min-h-14 text-body-sm"
                    aria-label="What the project is about"
                  />
                </label>
                <label className="text-meta text-muted-foreground">
                  Current goal
                  <Input
                    value={focus}
                    onChange={(e) => setFocus(e.target.value)}
                    maxLength={BRIEF_LIMITS.focus}
                    placeholder="Revise for the Paper 2 exam."
                    className="mt-1"
                    aria-label="Current goal"
                  />
                </label>
              </>
            ) : (
              <Button type="button" variant="link" size="xs" className="w-fit" onClick={() => setDetails(true)}>
                Add details
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" size="lg" disabled={!name.trim()}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
