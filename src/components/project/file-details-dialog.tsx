"use client"

import { useEffect, useRef, useState } from "react"
import { Download, MessageSquareShare, RotateCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useMemoryActions } from "@/components/memory/memory-actions"
import { StatusLine } from "./source-status"
import { fileContentLine } from "./file-card"
import { getContent } from "@/lib/resources/content-store"
import { markMatches } from "@/lib/resources/search"
import { canRereadFile } from "@/lib/files/note"
import { FILE_FORMAT_LABEL, formatBytes } from "@/lib/files/formats"
import type { ProjectNote } from "@/lib/notes/notes"
import type { ResourceContent } from "@/lib/resources/types"

/** Search words marked in the file's text — as text, never markup. */
function Marked({ text, terms }: { text: string; terms?: readonly string[] }) {
  if (!terms || terms.length === 0) return <>{text}</>
  return (
    <>
      {markMatches(text, terms).map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-xs bg-surface-active px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  )
}

/** Pages drawn at first; the rest on request, so a 900-page PDF opens at once. */
const PAGE_STEP = 25

/**
 * An uploaded file: what Hubble read from it, as plain text — page by page
 * for a PDF, so a passage can be found by the page an AI answer cites — and
 * what can be done with it: download the original, read it again when that
 * could help, use it in an AI chat, remove it.
 *
 * The text is the file's, not Hubble's: drawn as text (never markup), and
 * only what is stored on this device.
 */
export function FileDetailsDialog({
  note,
  workspaceId,
  onOpenChange,
  onDownload,
  onRetry,
  onRemove,
  focusPage,
  terms,
}: {
  note: ProjectNote
  workspaceId: string
  onOpenChange: (open: boolean) => void
  onDownload: (note: ProjectNote) => void
  onRetry: (note: ProjectNote) => void
  onRemove: (note: ProjectNote) => void
  /** Open at this page (1-based) — a search hit's. */
  focusPage?: number
  terms?: readonly string[]
}) {
  const memory = useMemoryActions()
  const file = note.file!
  const [content, setContent] = useState<{ key: string; value: ResourceContent | null } | null>(null)
  const [shown, setShown] = useState(Math.max(PAGE_STEP, focusPage ?? 0))
  const focusRef = useRef<HTMLElement | null>(null)

  const key = file.status === "ready" ? `${note.id}@${note.updatedAt}` : null
  useEffect(() => {
    if (!key) return
    let cancelled = false
    void getContent(workspaceId, note.id)
      .then((value) => !cancelled && setContent({ key, value: value ?? null }))
      .catch(() => !cancelled && setContent({ key, value: null }))
    return () => {
      cancelled = true
    }
  }, [key, note.id, workspaceId])

  const loaded = key && content?.key === key ? content.value : undefined
  useEffect(() => {
    if (loaded && focusPage) focusRef.current?.scrollIntoView({ block: "start" })
  }, [loaded, focusPage])

  const pages = loaded?.pages
  const added = new Date(note.createdAt).toLocaleDateString()

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl" data-file-dialog={note.id}>
        <DialogHeader>
          <DialogTitle className="truncate">{note.title}</DialogTitle>
          <DialogDescription className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <span className="truncate" title={file.name}>
              {file.name}
            </span>
            <span>· {FILE_FORMAT_LABEL[file.format]}</span>
            <span>· {formatBytes(file.size)}</span>
            <span>· Added {added}</span>
          </DialogDescription>
        </DialogHeader>

        <StatusLine status={file.status} {...(file.status === "ready" ? { detail: fileContentLine(note, file) } : file.error ? { detail: file.error.message } : {})} />

        {file.status === "ready" && (
          <section aria-label="Text from the file" className="mt-1 flex flex-col gap-4">
            {loaded === undefined ? (
              <p className="text-body-sm text-muted-foreground">Loading…</p>
            ) : loaded === null ? (
              <p role="alert" className="text-body-sm text-destructive">
                This file&apos;s text isn&apos;t on this device any more (the browser&apos;s site data may have been cleared). Upload it again to read it.
              </p>
            ) : pages ? (
              <>
                {pages.slice(0, shown).map((page, index) => (
                  <article
                    key={index}
                    ref={focusPage === index + 1 ? (element) => void (focusRef.current = element) : undefined}
                    aria-label={`Page ${index + 1}`}
                    className="flex flex-col gap-1"
                    data-file-page={index + 1}
                  >
                    <h3 className="text-meta text-tertiary">Page {index + 1}</h3>
                    {page.trim() ? (
                      <p className="text-body-sm whitespace-pre-wrap text-foreground"><Marked text={page} {...(terms ? { terms } : {})} /></p>
                    ) : (
                      <p className="text-body-sm text-tertiary">No text on this page.</p>
                    )}
                  </article>
                ))}
                {pages.length > shown && (
                  <Button type="button" size="sm" variant="ghost" className="w-fit" onClick={() => setShown((count) => count + PAGE_STEP)}>
                    Show more pages ({(pages.length - shown).toLocaleString()} left)
                  </Button>
                )}
              </>
            ) : (
              <p className="max-h-[55dvh] overflow-y-auto text-body-sm whitespace-pre-wrap text-foreground">
                <Marked text={loaded.text ?? ""} {...(terms ? { terms } : {})} />
              </p>
            )}
            {loaded?.truncated && <p className="text-meta text-tertiary">Very long, so Hubble kept the first part of its text.</p>}
          </section>
        )}

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" className="text-destructive" onClick={() => onRemove(note)}>
            <Trash2 /> Remove
          </Button>
          <div className="flex flex-wrap gap-2">
            {canRereadFile(file) && (
              <Button type="button" variant="ghost" onClick={() => onRetry(note)}>
                <RotateCw /> Try again
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onDownload(note)}>
              <Download /> Download original
            </Button>
            {memory && file.status === "ready" && (
              <Button type="button" variant="secondary" onClick={() => memory.reuse({ workspaceId, refs: [{ kind: "note", noteId: note.id }] })}>
                <MessageSquareShare /> Use in AI chat
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
