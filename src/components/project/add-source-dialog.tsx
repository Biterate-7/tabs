"use client"

import { useState, type FormEvent } from "react"
import { AlertCircle, CheckCircle2, Info } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { urlsInText } from "@/lib/resources/drop"
import type { IngestOutcome } from "@/lib/resources/ingest"
import type { ResourceInput } from "@/lib/resources/types"

/** Each line that looks like an address; a bare "example.com/x" line counts too. */
export function inputsFromText(text: string): ResourceInput[] {
  const out: ResourceInput[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const found = urlsInText(trimmed)
    if (found.length > 0) found.forEach((url) => out.push({ url }))
    else out.push({ url: trimmed })
  }
  return out
}

export function outcomeWords(outcome: IngestOutcome, projectName: string): string {
  switch (outcome.status) {
    case "added":
      return "Added"
    case "adopted":
      return "Added — it was already saved here as a tab"
    case "duplicate":
      return `Already in ${projectName}`
    case "invalid":
      return outcome.reason === "unsupported-scheme" ? "This kind of address can't be a source (only web pages, PDFs and videos online)" : "That isn't a web address"
  }
}

/**
 * "Add source" — the way in that needs no dragging: paste one address or
 * many, see what happened to each. Goes through the same ingestion as a drop.
 */
export function AddSourceDialog({
  open,
  onOpenChange,
  projectName,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  /** Ingests and returns each input's outcome. */
  onAdd: (inputs: ResourceInput[]) => IngestOutcome[]
}) {
  const [text, setText] = useState("")
  const [outcomes, setOutcomes] = useState<IngestOutcome[] | null>(null)

  function close(next: boolean) {
    if (!next) {
      setText("")
      setOutcomes(null)
    }
    onOpenChange(next)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const inputs = inputsFromText(text)
    if (inputs.length === 0) return
    setOutcomes(onAdd(inputs))
  }

  const failed = outcomes?.filter((outcome) => outcome.status === "invalid") ?? []
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        {outcomes ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {outcomes.length - failed.length} of {outcomes.length} added to {projectName}
              </DialogTitle>
              <DialogDescription>Hubble is reading the new sources now. Each card shows when it is ready.</DialogDescription>
            </DialogHeader>
            <ul className="mt-3 flex max-h-72 flex-col gap-1.5 overflow-y-auto" aria-label="What happened to each address">
              {outcomes.map((outcome, index) => {
                const Icon = outcome.status === "invalid" ? AlertCircle : outcome.status === "duplicate" ? Info : CheckCircle2
                return (
                  <li key={`${outcome.input.url}-${index}`} className="flex min-w-0 items-start gap-2 text-body-sm">
                    <Icon aria-hidden className={outcome.status === "invalid" ? "mt-0.5 size-3.5 shrink-0 text-destructive" : "mt-0.5 size-3.5 shrink-0 text-muted-foreground"} />
                    <span className="min-w-0">
                      <span className="block truncate text-foreground">{outcome.input.title ?? outcome.input.url}</span>
                      <span className="text-meta text-muted-foreground">{outcomeWords(outcome, projectName)}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOutcomes(null)}>
                Add more
              </Button>
              <Button type="button" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Add sources to {projectName}</DialogTitle>
              <DialogDescription>
                Paste web pages, PDFs or YouTube videos — one per line. You can also drag a link or the address bar from Chrome straight onto the project.
              </DialogDescription>
            </DialogHeader>
            <label htmlFor="add-source-urls" className="sr-only">
              Addresses to add
            </label>
            <Textarea
              id="add-source-urls"
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={"https://www.britannica.com/event/Cuban-missile-crisis\nhttps://www.youtube.com/watch?v=…"}
              className="mt-4 min-h-28 text-body-sm"
            />
            <DialogFooter>
              <Button type="submit" disabled={inputsFromText(text).length === 0}>
                Add {inputsFromText(text).length > 1 ? `${inputsFromText(text).length} sources` : "source"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
