"use client"

import { useState, type FormEvent } from "react"
import { Plus } from "lucide-react"
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
import type { DesktopImportRequest } from "@/lib/desktop/import-protocol"

export type DesktopImportProject = { id: string; name: string }

/** Where the person sends the batch: a project they have, or a new one by name. */
export type DesktopImportChoice = { workspaceId: string } | { newProject: string }

const NEW_PROJECT = "__new__"

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** "github.com, nytimes.com and 7 more" — enough to recognise the batch, nothing to read. */
function previewLine(request: DesktopImportRequest): string {
  const hosts = [...new Set(request.tabs.map((tab) => hostOf(tab.url)))]
  const shown = hosts.slice(0, 3)
  const more = request.tabs.length - request.tabs.filter((tab) => shown.includes(hostOf(tab.url))).length
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ")
}

/**
 * Chrome → Hubble Desktop: "Add 12 tabs to Hubble — choose a project". Shown
 * when the Hubble extension sends tabs here (src/hooks/use-desktop-import.ts).
 * Nothing is imported until the person presses Add; Cancel imports nothing.
 * The project open in Hubble is chosen to begin with.
 *
 * Render it keyed by the request id, so each batch starts fresh.
 */
export function DesktopImportDialog({
  request,
  projects,
  currentProjectId,
  onAdd,
  onCancel,
}: {
  request: DesktopImportRequest
  projects: readonly DesktopImportProject[]
  currentProjectId: string | undefined
  /** Imports the batch; false when the chosen project no longer exists. */
  onAdd: (request: DesktopImportRequest, choice: DesktopImportChoice) => boolean
  onCancel: (request: DesktopImportRequest) => void
}) {
  const [selected, setSelected] = useState<string>(() => (projects.find((project) => project.id === currentProjectId) ?? projects[0])?.id ?? NEW_PROJECT)
  const [newName, setNewName] = useState("")
  const [error, setError] = useState<string | null>(null)

  const count = request.tabs.length
  const creating = selected === NEW_PROJECT
  const chosen = projects.find((project) => project.id === selected)
  const canAdd = count > 0 && (creating ? newName.trim().length > 0 : Boolean(chosen))
  const target = creating ? newName.trim() || "new project" : chosen?.name

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canAdd) return
    const ok = onAdd(request, creating ? { newProject: newName.trim() } : { workspaceId: selected })
    if (!ok) setError("That project isn't in Hubble any more. Choose another.")
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel(request)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              Add {count} tab{count === 1 ? "" : "s"} to Hubble
            </DialogTitle>
            <DialogDescription>From Chrome · {previewLine(request)}</DialogDescription>
          </DialogHeader>

          <fieldset className="mt-4 flex flex-col gap-1">
            <legend className="mb-1.5 text-meta text-muted-foreground">Choose a project</legend>
            <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto" role="radiogroup" aria-label="Project">
              {projects.map((project) => (
                <label
                  key={project.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-body-sm hover:bg-muted has-[:checked]:bg-muted"
                >
                  <input
                    type="radio"
                    name="desktop-import-project"
                    value={project.id}
                    checked={selected === project.id}
                    onChange={() => {
                      setSelected(project.id)
                      setError(null)
                    }}
                    className="accent-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">{project.name}</span>
                  {project.id === currentProjectId ? <span className="shrink-0 text-meta text-muted-foreground">Open now</span> : null}
                </label>
              ))}
              <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-body-sm hover:bg-muted has-[:checked]:bg-muted">
                <input
                  type="radio"
                  name="desktop-import-project"
                  value={NEW_PROJECT}
                  checked={creating}
                  onChange={() => {
                    setSelected(NEW_PROJECT)
                    setError(null)
                  }}
                  className="accent-foreground"
                />
                <Plus aria-hidden className="size-3.5 text-muted-foreground" />
                <span className="text-foreground">New project</span>
              </label>
            </div>
            {creating ? (
              <Input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                maxLength={120}
                placeholder="Project name"
                aria-label="New project name"
                className="mt-2"
              />
            ) : null}
          </fieldset>

          {request.rejected > 0 ? (
            <p className="mt-3 text-meta text-muted-foreground">
              {request.rejected} {request.rejected === 1 ? "tab isn't a web page and" : "tabs aren't web pages and"} won&apos;t be added.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-meta text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={() => onCancel(request)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canAdd}>
              {target ? `Add to ${target}` : "Add tabs"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
