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
import { aiProviderName } from "@/lib/providers/registry"
import type { DesktopImportRequest, DesktopTabsRequest } from "@/lib/desktop/import-protocol"

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
function previewLine(request: DesktopTabsRequest): string {
  const hosts = [...new Set(request.tabs.map((tab) => hostOf(tab.url)))]
  const shown = hosts.slice(0, 3)
  const more = request.tabs.length - request.tabs.filter((tab) => shown.includes(hostOf(tab.url))).length
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ")
}

/** The words for what arrived: a batch of tabs, or one conversation. */
function describeRequest(request: DesktopImportRequest) {
  if (request.kind === "conversation") {
    const turns = request.conversation.turns.length
    return {
      title: "Save a conversation to Hubble",
      // Its title, the app it came from and its length: enough to recognise it, nothing of what it says.
      description: `From ${aiProviderName(request.conversation.provider)} in Chrome · ${request.conversation.title} · ${turns} message${turns === 1 ? "" : "s"}`,
      verb: "Save",
      fallback: "Save conversation",
      note: request.truncated ? "It's very long, so only the first part will be kept." : null,
    }
  }
  const count = request.tabs.length
  return {
    title: `Add ${count} tab${count === 1 ? "" : "s"} to Hubble`,
    description: `From Chrome · ${previewLine(request)}`,
    verb: "Add",
    fallback: "Add tabs",
    note:
      request.rejected > 0
        ? `${request.rejected} ${request.rejected === 1 ? "tab isn't a web page and" : "tabs aren't web pages and"} won't be added.`
        : null,
  }
}

/**
 * Chrome → Hubble Desktop: "Add 12 tabs to Hubble — choose a project", or
 * "Save a conversation to Hubble". Shown when the Hubble extension sends tabs
 * or a ChatGPT / Claude / Gemini / Perplexity conversation here
 * (src/hooks/use-desktop-import.ts). Nothing is saved until the person
 * presses Add or Save; Cancel saves nothing. The project open in Hubble is
 * chosen to begin with.
 *
 * Render it keyed by the request id, so each request starts fresh.
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
  /** Imports the batch or saves the conversation; false when the chosen project no longer exists. */
  onAdd: (request: DesktopImportRequest, choice: DesktopImportChoice) => boolean | Promise<boolean>
  onCancel: (request: DesktopImportRequest) => void
}) {
  const [selected, setSelected] = useState<string>(() => (projects.find((project) => project.id === currentProjectId) ?? projects[0])?.id ?? NEW_PROJECT)
  const [newName, setNewName] = useState("")
  const [error, setError] = useState<string | null>(null)
  // Saving a conversation takes a moment: one press, then wait for it.
  const [saving, setSaving] = useState(false)

  const words = describeRequest(request)
  const hasContent = request.kind === "conversation" || request.tabs.length > 0
  const creating = selected === NEW_PROJECT
  const chosen = projects.find((project) => project.id === selected)
  const canAdd = !saving && hasContent && (creating ? newName.trim().length > 0 : Boolean(chosen))
  const target = creating ? newName.trim() || "a new project" : chosen?.name

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canAdd) return
    setSaving(true)
    const ok = await onAdd(request, creating ? { newProject: newName.trim() } : { workspaceId: selected })
    // Answered: the dialog is about to close. Otherwise the person chooses again.
    if (!ok) {
      setSaving(false)
      setError("That project isn't in Hubble any more. Choose another.")
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onCancel(request)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{words.title}</DialogTitle>
            <DialogDescription className="break-words">{words.description}</DialogDescription>
          </DialogHeader>

          <fieldset className="mt-4 flex flex-col gap-1" disabled={saving}>
            <legend className="mb-1.5 text-meta text-muted-foreground">{request.kind === "conversation" ? "Save to" : "Add to"}</legend>
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

          {words.note ? <p className="mt-3 text-meta text-muted-foreground">{words.note}</p> : null}
          {error ? (
            <p role="alert" className="mt-3 text-meta text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" disabled={saving} onClick={() => onCancel(request)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canAdd}>
              {saving ? "Saving…" : target ? `${words.verb} to ${target}` : words.fallback}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
