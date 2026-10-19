"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { DocxViewer } from "./docx-viewer"
import { MarkdownViewer } from "./markdown-viewer"
import { PdfViewer } from "./pdf-viewer"
import { getFile } from "@/lib/resources/content-store"
import { decodeTextFile } from "@/lib/files/text"
import { openPdfView, PDF_VIEW_MESSAGES, PdfViewError } from "@/lib/files/pdf-view"
import { isPdfBytes } from "@/lib/resources/pdf"
import type { PdfView } from "@/lib/files/pdf-view"
import type { NoteFile } from "@/lib/notes/notes"

/** Past this many characters a Markdown file is shown in part — a page can't hold ten million characters of formatted text. */
export const MARKDOWN_RENDER_LIMIT = 400_000

/**
 * Whether the reader draws this file's original rather than the text Hubble
 * read from it. PDFs are drawn page by page, Word documents and Markdown are
 * formatted; text, CSV, JSON and HTML are their own text already (HTML is
 * deliberately not run), and a file that couldn't be read has nothing to draw.
 */
export function showsOriginal(file: NoteFile): boolean {
  return (file.status === "ready" || file.status === "partial") && (file.format === "pdf" || file.format === "docx" || file.format === "markdown")
}

const MISSING = "The original file isn't on this device any more (the browser's site data may have been cleared). Upload it again to read it."
const UNREADABLE: Record<NoteFile["format"], string> = {
  pdf: PDF_VIEW_MESSAGES.failed,
  docx: "Hubble couldn't show this Word document.",
  markdown: "Hubble couldn't show this file.",
  text: "",
  csv: "",
  json: "",
  html: "",
}

type Original = { key: string; bytes: ArrayBuffer | null }

/**
 * An uploaded file as it was written: the kept original, drawn. Loading,
 * a file that is no longer on this device and a file that can't be drawn
 * each say so, and tell the dialog (`onUnavailable`) so it can offer the
 * text Hubble read instead — a reader is never blank.
 */
export function FileReader({
  workspaceId,
  noteId,
  updatedAt,
  file,
  title,
  focusPage,
  terms,
  onUnavailable,
}: {
  workspaceId: string
  noteId: string
  updatedAt: number
  file: NoteFile
  title: string
  focusPage?: number
  terms?: readonly string[]
  onUnavailable: () => void
}) {
  const key = `${workspaceId}:${noteId}@${updatedAt}`
  const [original, setOriginal] = useState<Original | null>(null)
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void getFile(workspaceId, noteId)
      .then((stored) => !cancelled && setOriginal({ key, bytes: stored?.bytes ?? null }))
      .catch(() => !cancelled && setOriginal({ key, bytes: null }))
    return () => {
      cancelled = true
    }
  }, [workspaceId, noteId, key])

  const loaded = original?.key === key ? original : null
  const failure = problem?.key === key ? problem.message : loaded && loaded.bytes === null ? MISSING : undefined
  const fail = useCallback((message: string) => setProblem({ key, message }), [key])
  useEffect(() => {
    if (failure) onUnavailable()
  }, [failure, onUnavailable])

  if (failure) {
    return (
      <p role="alert" className="text-body-sm text-destructive">
        {failure}
      </p>
    )
  }
  if (!loaded?.bytes) return <p className="text-body-sm text-muted-foreground">Opening…</p>

  const bytes = loaded.bytes
  if (file.format === "pdf") return <PdfReader bytes={bytes} label={title} onFail={fail} {...(focusPage ? { focusPage } : {})} {...(terms ? { terms } : {})} />
  if (file.format === "docx") return <DocxViewer bytes={bytes} label={title} onFail={() => fail(UNREADABLE.docx)} />
  return <MarkdownReader bytes={bytes} label={title} onFail={() => fail(UNREADABLE.markdown)} />
}

function PdfReader({ bytes, label, focusPage, terms, onFail }: { bytes: ArrayBuffer; label: string; focusPage?: number; terms?: readonly string[]; onFail: (message: string) => void }) {
  const [opened, setOpened] = useState<{ bytes: ArrayBuffer; view: PdfView } | null>(null)

  useEffect(() => {
    let cancelled = false
    let view: PdfView | undefined
    if (!isPdfBytes(new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength)))) {
      onFail(PDF_VIEW_MESSAGES.damaged)
      return
    }
    openPdfView(bytes)
      .then((opened) => {
        if (cancelled) void opened.destroy()
        else {
          view = opened
          setOpened({ bytes, view: opened })
        }
      })
      .catch((error: unknown) => !cancelled && onFail(error instanceof PdfViewError ? error.message : PDF_VIEW_MESSAGES.failed))
    return () => {
      cancelled = true
      void view?.destroy()
    }
  }, [bytes, onFail])

  if (opened?.bytes !== bytes) return <p className="text-body-sm text-muted-foreground">Opening…</p>
  return <PdfViewer view={opened.view} label={label} {...(focusPage ? { focusPage } : {})} {...(terms ? { terms } : {})} />
}

function MarkdownReader({ bytes, label, onFail }: { bytes: ArrayBuffer; label: string; onFail: () => void }) {
  const decoded = useMemo(() => {
    try {
      return decodeTextFile(new Uint8Array(bytes))
    } catch {
      return null
    }
  }, [bytes])
  useEffect(() => {
    if (decoded === null) onFail()
  }, [decoded, onFail])
  if (decoded === null) return null
  const partial = decoded.length > MARKDOWN_RENDER_LIMIT
  return (
    <>
      <MarkdownViewer source={partial ? decoded.slice(0, MARKDOWN_RENDER_LIMIT) : decoded} label={label} />
      {partial && <p className="text-meta text-tertiary">Very long, so only the first part is shown. Download the original for all of it.</p>}
    </>
  )
}
