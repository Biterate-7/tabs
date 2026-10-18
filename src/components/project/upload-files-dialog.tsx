"use client"

import { useRef, useState, type ReactNode } from "react"
import { AlertCircle, FileText, FileType2, FileUp, Loader2, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { StatusLine } from "./source-status"
import { fileContentLine } from "./file-card"
import { canRereadFile } from "@/lib/files/note"
import { detectFileFormat, FILE_INPUT_ACCEPT, FILE_LIMITS, formatBytes } from "@/lib/files/formats"
import type { UploadOutcome } from "@/hooks/use-file-uploads"
import type { ProjectNote } from "@/lib/notes/notes"

/** One chosen file, from the moment it is chosen until Hubble has said what became of it. */
export type UploadRow = { key: string; file: File; outcome?: UploadOutcome }

let rowCount = 0

/**
 * The files chosen in this project, and what became of each — shared by the
 * Upload files dialog and a drop on the page, which opens the dialog to show
 * the same rows.
 */
export function useUploadRows(upload: (files: readonly File[], onOutcome: (index: number, outcome: UploadOutcome) => void) => Promise<UploadOutcome[]>) {
  const [rows, setRows] = useState<UploadRow[]>([])

  function add(files: readonly File[]) {
    if (files.length === 0) return
    const added = files.map((file) => ({ key: `u${++rowCount}`, file }))
    setRows((current) => [...current, ...added])
    void upload(files, (index, outcome) => {
      const key = added[index]?.key
      if (key) setRows((current) => current.map((row) => (row.key === key ? { ...row, outcome } : row)))
    })
  }

  /** A file that couldn't be added (storage was full): try the same file again, in place. */
  function again(row: UploadRow) {
    setRows((current) => current.filter((entry) => entry.key !== row.key))
    add([row.file])
  }

  /** Forget finished rows (the dialog closed); files still being added stay. */
  function clearFinished() {
    setRows((current) => current.filter((row) => !row.outcome))
  }

  return { rows, add, again, clearFinished }
}

/**
 * Upload files — documents from this device into the project.
 *
 *     Upload files
 *     ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
 *        Drop files here   [Choose files]
 *        PDF, Word, Markdown or text · up to 25 MB
 *     └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
 *     ▤ lecture-4.pdf      2.1 MB   ✓ Ready · 12 pages
 *     ▤ scan.pdf           8 MB     ✓ Saved · No text found — this PDF may be a scan…
 *     ▤ notes.doc                   ⚠ Can't add · Older Word files (.doc) can't be read…
 *
 * Files are read on this device and kept here — nothing is uploaded to a
 * server. Each file's line follows it live: adding, reading, then ready,
 * kept without text, or couldn't read (with Try again when that could help).
 * Closing the dialog doesn't stop anything; the files are on the project.
 */
export function UploadFilesDialog({
  open,
  onOpenChange,
  projectName,
  rows,
  notes,
  onChoose,
  onAgain,
  onRetry,
  onOpenFile,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  rows: readonly UploadRow[]
  /** The project's notes, for each added file's live status. */
  notes: readonly ProjectNote[]
  onChoose: (files: File[]) => void
  onAgain: (row: UploadRow) => void
  onRetry: (noteId: string) => void
  onOpenFile: (noteId: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const noteById = new Map(notes.map((note) => [note.id, note]))
  const working = rows.filter((row) => !row.outcome || (row.outcome.status === "added" && noteById.get(row.outcome.noteId)?.file?.status === "processing")).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-upload-dialog>
        <DialogHeader>
          <DialogTitle>Upload files</DialogTitle>
        </DialogHeader>

        <div className="mt-3 flex flex-col items-center gap-2 rounded-md border border-dashed border-strong px-4 py-6 text-center" data-upload-drop>
          <FileUp aria-hidden className="size-5 text-muted-foreground" />
          <p className="text-body-sm text-foreground">
            Drop files here or{" "}
            <Button type="button" size="sm" variant="secondary" className="ml-1" onClick={() => input.current?.click()}>
              Choose files
            </Button>
          </p>
          <p className="text-meta text-tertiary">PDF, Word, Markdown or text · up to {formatBytes(FILE_LIMITS.maxBytes)} each</p>
          <input
            ref={input}
            type="file"
            multiple
            accept={FILE_INPUT_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-label={`Choose files to add to ${projectName}`}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              // Cleared so choosing the same file again still fires a change.
              event.target.value = ""
              onChoose(files)
            }}
          />
        </div>

        {rows.length > 0 && (
          <ul className="mt-3 flex max-h-72 flex-col divide-y divide-subtle overflow-y-auto rounded-md border border-subtle" aria-label="Chosen files">
            {rows.map((row) => (
              <UploadLine key={row.key} row={row} note={row.outcome && "noteId" in row.outcome ? noteById.get(row.outcome.noteId) : undefined} projectName={projectName} onAgain={onAgain} onRetry={onRetry} onOpenFile={onOpenFile} />
            ))}
          </ul>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <p role="status" className="text-meta text-muted-foreground">
            {working > 0 ? `Reading ${working === 1 ? "1 file" : `${working} files`}… you can close this.` : ""}
          </p>
          <Button type="button" variant={rows.length > 0 ? "default" : "ghost"} onClick={() => onOpenChange(false)}>
            {rows.length > 0 ? "Done" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UploadLine({
  row,
  note,
  projectName,
  onAgain,
  onRetry,
  onOpenFile,
}: {
  row: UploadRow
  note: ProjectNote | undefined
  projectName: string
  onAgain: (row: UploadRow) => void
  onRetry: (noteId: string) => void
  onOpenFile: (noteId: string) => void
}) {
  const outcome = row.outcome
  const Icon = detectFileFormat(row.file) === "pdf" ? FileText : FileType2
  const file = note?.file
  let status: ReactNode
  let action: ReactNode = null
  if (!outcome) {
    status = (
      <p className="flex items-center gap-1.5 text-meta text-muted-foreground" data-upload-stage="adding">
        <Loader2 aria-hidden className="size-3.5 animate-spin" /> <span className="font-medium">Adding…</span>
      </p>
    )
  } else if (outcome.status === "added" && note && file) {
    status = <StatusLine status={file.status} {...(file.status === "ready" ? { detail: fileContentLine(note, file) } : file.error ? { detail: file.error.message } : {})} />
    if (canRereadFile(file))
      action = (
        <Button type="button" size="xs" variant="ghost" onClick={() => onRetry(note.id)} aria-label={`Read ${row.file.name} again`}>
          <RotateCw /> Try again
        </Button>
      )
    else if (file.status !== "processing")
      action = (
        <Button type="button" size="xs" variant="ghost" onClick={() => onOpenFile(note.id)} aria-label={`Open ${row.file.name}`}>
          Open
        </Button>
      )
  } else if (outcome.status === "added") {
    // Added, then removed from the project (Undo, Remove) while this was open.
    status = <p className="text-meta text-tertiary">Removed from {projectName}</p>
  } else if (outcome.status === "duplicate") {
    status = <p className="text-meta text-muted-foreground" data-upload-stage="duplicate">Already in {projectName}</p>
    action = (
      <Button type="button" size="xs" variant="ghost" onClick={() => onOpenFile(outcome.noteId)} aria-label={`Open ${row.file.name}`}>
        Open
      </Button>
    )
  } else {
    status = (
      <p className="flex min-w-0 items-start gap-1.5 text-meta text-destructive" data-upload-stage={outcome.status}>
        <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0">
          <span className="font-medium">{outcome.status === "rejected" ? "Can't add" : "Couldn't add"}</span> · {outcome.message}
        </span>
      </p>
    )
    if (outcome.status === "failed")
      action = (
        <Button type="button" size="xs" variant="ghost" onClick={() => onAgain(row)} aria-label={`Add ${row.file.name} again`}>
          <RotateCw /> Try again
        </Button>
      )
  }
  return (
    <li className="flex items-start gap-2.5 px-3 py-2" data-upload-row={row.file.name}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-body-sm text-foreground" title={row.file.name}>
            {row.file.name}
          </span>
          <span className="shrink-0 text-meta text-tertiary tabular-nums">{formatBytes(row.file.size)}</span>
        </p>
        {status}
      </div>
      {action}
    </li>
  )
}
