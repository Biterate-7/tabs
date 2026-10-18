"use client"

import { useEffect, useState, type FormEvent } from "react"
import { ExternalLink, MessageSquareShare, Trash2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { captureLine, ConversationView } from "./conversation-view"
import { ProviderBadge } from "./provider-mark"
import { useMemoryActions } from "./memory-actions"
import { getContent } from "@/lib/resources/content-store"
import { openTab } from "@/lib/browser/open-tab"
import { NOTE_KIND_LABEL } from "@/lib/memory/items"
import type { ProjectNote } from "@/lib/notes/notes"
import type { ResourceContent } from "@/lib/resources/types"

const ORIGIN_WORDS: Record<ProjectNote["origin"], string> = {
  manual: "Written in Hubble",
  paste: "Pasted",
  import: "Imported from a file",
  capture: "Saved from a page",
  upload: "Uploaded",
}

/**
 * One project note: read it, rename it, tag it, edit a note's words, or
 * delete it. A pasted or imported conversation is read turn by turn and is
 * not edited — it is a record of what was said.
 */
export function NoteDialog({
  note,
  workspaceId,
  onOpenChange,
  onUpdate,
  onSaveText,
  onDelete,
  focusTurn,
  terms,
}: {
  note: ProjectNote | null
  workspaceId: string
  onOpenChange: (open: boolean) => void
  onUpdate: (note: ProjectNote, patch: { title?: string; tags?: string[] }) => void
  /** A note's or excerpt's new words. Resolves false when they could not be kept. */
  onSaveText: (note: ProjectNote, text: string) => Promise<boolean>
  onDelete: (note: ProjectNote) => void
  focusTurn?: number
  terms?: readonly string[]
}) {
  const memory = useMemoryActions()
  const [tracked, setTracked] = useState(note?.id)
  const [title, setTitle] = useState(note?.title ?? "")
  const [tags, setTags] = useState((note?.tags ?? []).join(", "))
  const [content, setContent] = useState<{ key: string; value: ResourceContent | null } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  if (note?.id !== tracked) {
    setTracked(note?.id)
    setTitle(note?.title ?? "")
    setTags((note?.tags ?? []).join(", "))
    setDraft(null)
    setMessage(null)
  }

  const key = note ? `${note.id}@${note.contentHash}` : null
  useEffect(() => {
    if (!note || !key) return
    let cancelled = false
    void getContent(workspaceId, note.id)
      .then((value) => !cancelled && setContent({ key, value: value ?? null }))
      .catch(() => !cancelled && setContent({ key, value: null }))
    return () => {
      cancelled = true
    }
  }, [note, key, workspaceId])

  if (!note) return null
  const loaded = content?.key === key ? content.value : undefined
  const editable = note.kind !== "conversation"

  function save(event: FormEvent) {
    event.preventDefault()
    if (!note) return
    const nextTags = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
    onUpdate(note, { ...(title.trim() && title.trim() !== note.title ? { title: title.trim() } : {}), tags: nextTags })
    setMessage("Saved.")
  }

  async function saveText() {
    if (!note || draft === null) return
    const ok = await onSaveText(note, draft)
    setMessage(ok ? "Saved." : "Hubble couldn't keep that on this device. Nothing was changed.")
    if (ok) setDraft(null)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl" data-note-dialog={note.kind}>
        <DialogHeader>
          <DialogTitle className="truncate">{note.title}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-1.5">
            {note.provider ? <ProviderBadge provider={note.provider} /> : null}
            {note.provider ? "·" : null}
            <span>{NOTE_KIND_LABEL[note.kind]}</span>
            <span>· {note.kind === "conversation" ? captureLine(note.origin === "import" ? "export" : note.origin === "capture" ? "page" : "paste", note.createdAt) : `${ORIGIN_WORDS[note.origin]} · ${new Date(note.createdAt).toLocaleDateString()}`}</span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="text-meta text-muted-foreground">
            Title
            <Input className="mt-1" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
          </label>
          <label className="text-meta text-muted-foreground">
            Tags <span className="text-tertiary">(comma-separated)</span>
            <Input className="mt-1" value={tags} onChange={(event) => setTags(event.target.value)} />
          </label>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </form>

        {note.sourceUrl && (
          <p className="text-meta break-all text-tertiary">
            From <span className="text-muted-foreground">{note.sourceUrl}</span>
          </p>
        )}

        <section aria-label={note.kind === "conversation" ? "The saved conversation" : "Text"} className="mt-1">
          {loaded === undefined ? (
            <p className="text-body-sm text-muted-foreground">Loading…</p>
          ) : loaded === null ? (
            <p role="alert" className="text-body-sm text-destructive">
              This note&apos;s text isn&apos;t on this device any more (the browser&apos;s site data may have been cleared). Its title and details are kept.
            </p>
          ) : note.kind === "conversation" ? (
            <ConversationView turns={loaded.turns} {...(loaded.text ? { text: loaded.text } : {})} {...(note.provider ? { provider: note.provider } : {})} {...(focusTurn !== undefined ? { focusTurn } : {})} {...(terms ? { terms } : {})} />
          ) : (
            <>
              <Textarea
                aria-label="Note text"
                className="max-h-[50dvh] min-h-40 overflow-y-auto text-body-sm"
                value={draft ?? loaded.text ?? ""}
                readOnly={!editable}
                onChange={(event) => setDraft(event.target.value)}
              />
              {draft !== null && (
                <div className="mt-2 flex gap-2">
                  <Button type="button" size="sm" onClick={() => void saveText()}>
                    Save text
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
                    Discard changes
                  </Button>
                </div>
              )}
            </>
          )}
        </section>

        {message && (
          <p role="status" className="text-body-sm text-muted-foreground">
            {message}
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" className="text-destructive" onClick={() => onDelete(note)}>
            <Trash2 /> Delete
          </Button>
          <div className="flex gap-2">
            {note.sourceUrl && (
              <Button type="button" variant="ghost" onClick={() => void openTab(note.sourceUrl!)}>
                <ExternalLink /> Open source
              </Button>
            )}
            {memory && (
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
