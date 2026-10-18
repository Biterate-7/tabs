"use client"

import { useMemo, useRef, useState, type FormEvent } from "react"
import { AlertCircle, CheckCircle2, FileUp, Info } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { parseConversationText } from "@/lib/conversations/parse-text"
import { cleanLine, titleFromText } from "@/lib/conversations/clean"
import { IMPORT_FILE_MESSAGES, readImportFile } from "@/lib/conversations/import-file"
import { AI_PROVIDERS, AI_PROVIDER_IDS, aiProviderName, conversationRefOf, isAiProviderId } from "@/lib/providers/registry"
import { isSafeOpenUrl } from "@/lib/browser/protocol"
import type { ConversationInput } from "@/lib/conversations/types"
import type { NoteDraft } from "@/lib/notes/compose"
import type { AiProviderId } from "@/lib/providers/registry"

export type CaptureMode = "conversation" | "note" | "import"

/** What saving a batch of conversations did — every count real, nothing rounded up to success. */
export type ConversationSaveSummary = {
  added: number
  updated: number
  unchanged: number
  /** Already saved with more of the conversation than this copy has: the saved copy was kept as it is. */
  kept: number
  failed: number
}

export type NoteSaveResult = { ok: true; duplicate: boolean } | { ok: false; message: string }

const NOT_FROM_AI = "none"

/**
 * Bringing knowledge in by hand — for everything Hubble for Chrome can't
 * reach, or a person would rather paste:
 *
 *   Paste a conversation   from any AI app; split into turns when it says who spoke
 *   Write a note           their own words, or a passage they want to keep
 *   Import AI chats        a ChatGPT or Claude export (conversations.json), or Markdown/text
 *
 * Every path previews what will be saved before it is, and reports what
 * actually happened after — added, updated, already there, or why not.
 */
export function CaptureDialog({
  open,
  onOpenChange,
  projectName,
  initialMode = "conversation",
  prefill,
  onSaveConversations,
  onSaveNote,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  initialMode?: CaptureMode
  /** For a conversation saved as a link only: its address and app, so the pasted text fills that item in. */
  prefill?: { link?: string; provider?: AiProviderId }
  onSaveConversations: (inputs: ConversationInput[]) => Promise<ConversationSaveSummary>
  onSaveNote: (draft: NoteDraft) => Promise<NoteSaveResult>
}) {
  const [mode, setMode] = useState<CaptureMode>(initialMode)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Conversation
  const [provider, setProvider] = useState<AiProviderId>(prefill?.provider ?? "chatgpt")
  const [link, setLink] = useState(prefill?.link ?? "")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  // Note
  const [noteKind, setNoteKind] = useState<NoteDraft["kind"]>("note")
  const [noteFrom, setNoteFrom] = useState<string>(NOT_FROM_AI)
  // Import
  const fileRef = useRef<HTMLInputElement>(null)
  const [imported, setImported] = useState<{ kind: "text"; text: string; fileName: string } | null>(null)

  function reset() {
    setDone(null)
    setError(null)
    setBusy(false)
    setLink("")
    setTitle("")
    setText("")
    setImported(null)
    setNoteFrom(NOT_FROM_AI)
  }

  const linkRef = link.trim() ? conversationRefOf(link.trim()) : undefined
  const linkProblem = link.trim() && !linkRef ? `That isn't a link to one ${aiProviderName(provider)} conversation. Leave it empty, or paste the conversation's own address.` : undefined
  const effectiveProvider: AiProviderId = linkRef?.provider ?? provider
  const parsed = useMemo(() => (mode === "conversation" || imported ? parseConversationText(imported?.text ?? text) : undefined), [mode, imported, text])

  function conversationInput(source: string, fileName?: string, from: AiProviderId = effectiveProvider): ConversationInput | undefined {
    const result = parseConversationText(source)
    if (result.turns.length === 0 && !result.text) return undefined
    const firstText = result.turns[0]?.text ?? result.text ?? ""
    return {
      provider: from,
      title: cleanLine(title) || (fileName ? cleanLine(fileName.replace(/\.(md|markdown|txt)$/i, "")) : "") || titleFromText(firstText, `${aiProviderName(from)} conversation`),
      ...(linkRef ? { url: linkRef.url, conversationId: linkRef.conversationId } : {}),
      turns: result.turns,
      ...(result.text ? { text: result.text } : {}),
      method: "paste",
    }
  }

  async function saveConversation(source: string, fileName?: string, from?: AiProviderId) {
    const input = conversationInput(source, fileName, from)
    if (!input) {
      setError("There's nothing to save — paste the conversation first.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const summary = await onSaveConversations([input])
      if (summary.failed > 0) setError("Hubble couldn't keep the text on this device, so nothing was saved. Try again.")
      else if (summary.kept > 0) setDone(`${projectName} already has more of this conversation than this copy, so the saved copy was kept as it is.`)
      else if (summary.unchanged > 0) setDone(`That conversation is already in ${projectName}, unchanged.`)
      else if (summary.updated > 0) setDone(`Updated the saved copy in ${projectName}.`)
      else setDone(`Saved to ${projectName}.`)
    } finally {
      setBusy(false)
    }
  }

  async function saveNote(source: string, fileName?: string) {
    setBusy(true)
    setError(null)
    try {
      const fromAi = isAiProviderId(noteFrom) ? noteFrom : undefined
      const result = await onSaveNote({
        kind: noteKind,
        text: source,
        ...(title.trim() ? { title } : fileName ? { title: fileName.replace(/\.(md|markdown|txt)$/i, "") } : {}),
        ...(fromAi ? { provider: fromAi } : {}),
        ...(link.trim() && isSafeOpenUrl(link.trim()) ? { sourceUrl: link.trim() } : {}),
        origin: fileName ? "import" : "manual",
      })
      if (!result.ok) setError(result.message)
      else setDone(result.duplicate ? `That's already a note in ${projectName}.` : `Saved to ${projectName}.`)
    } finally {
      setBusy(false)
    }
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return
    setError(null)
    setDone(null)
    setImported(null)
    setBusy(true)
    try {
      const result = await readImportFile(file)
      if (!result.ok) {
        setError(IMPORT_FILE_MESSAGES[result.reason])
        return
      }
      if (result.kind === "text") {
        setImported({ kind: "text", text: result.text, fileName: result.fileName })
        return
      }
      const summary = await onSaveConversations(result.conversations)
      const parts = [
        summary.added > 0 ? `${summary.added} added` : "",
        summary.updated > 0 ? `${summary.updated} updated` : "",
        summary.unchanged > 0 ? `${summary.unchanged} already saved` : "",
        summary.kept > 0 ? `${summary.kept} kept (already saved with more turns)` : "",
        summary.failed > 0 ? `${summary.failed} couldn't be saved` : "",
        result.skipped > 0 ? `${result.skipped} skipped (no readable messages)` : "",
      ].filter(Boolean)
      const what = `${aiProviderName(result.provider)} export`
      if (summary.failed > 0 && summary.added + summary.updated + summary.unchanged + summary.kept === 0) setError(`Nothing from the ${what} could be saved on this device. Try again.`)
      else setDone(`${what}: ${parts.join(" · ")}.${result.truncated ? " Some very long conversations were shortened to fit." : ""}`)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (mode === "conversation") {
      if (linkProblem) {
        setError(linkProblem)
        return
      }
      void saveConversation(text)
    } else if (mode === "note") void saveNote(text)
    else if (imported) {
      if (noteFrom === NOT_FROM_AI) void saveNote(imported.text, imported.fileName)
      else if (isAiProviderId(noteFrom)) void saveConversation(imported.text, imported.fileName, noteFrom)
    }
  }

  const providerOptions = AI_PROVIDER_IDS.map((id) => ({ value: id, label: AI_PROVIDERS[id].name }))
  const fromOptions = [{ value: NOT_FROM_AI, label: "Me" }, ...providerOptions]

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl" data-capture-dialog={mode}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>Add to {projectName}</DialogTitle>
            <DialogDescription>Saved only on this device.</DialogDescription>
          </DialogHeader>
          <SegmentedControl
            value={mode}
            onValueChange={(next) => {
              reset()
              setMode(next)
              if (next === "import") setNoteFrom("chatgpt")
            }}
            options={[
              { value: "conversation", label: "Paste a conversation" },
              { value: "note", label: "Write a note" },
              { value: "import", label: "Import AI chats" },
            ]}
          />

          {done ? (
            <p role="status" className="flex items-start gap-2 rounded-md border border-subtle bg-card p-3 text-body-sm text-foreground">
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> {done}
            </p>
          ) : mode === "conversation" ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                  From
                  <Select value={effectiveProvider} onValueChange={(value) => isAiProviderId(value) && setProvider(value)} options={providerOptions} />
                </label>
                <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                  <span>
                    Link <span className="text-tertiary">· optional</span>
                  </span>
                  <Input value={link} onChange={(event) => setLink(event.target.value)} placeholder={`${AI_PROVIDERS[effectiveProvider].homeUrl}…`} inputMode="url" />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                <span>
                  Title <span className="text-tertiary">· optional</span>
                </span>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
              </label>
              <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                Conversation
                <Textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} className="max-h-[45dvh] min-h-48 overflow-y-auto text-body-sm" placeholder={"You: …\nChatGPT: …"} />
              </label>
              {text.trim() && parsed && (
                <p className="flex items-start gap-1.5 text-meta text-muted-foreground" data-parse-preview>
                  <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {parsed.structured
                    ? `${parsed.turns.length} turns: ${parsed.turns.filter((turn) => turn.role === "user").length} from you, ${parsed.turns.filter((turn) => turn.role === "assistant").length} from ${aiProviderName(effectiveProvider)}`
                    : `No "You:" / "${aiProviderName(effectiveProvider)}:" labels — saved as one block of text`}
                </p>
              )}
            </>
          ) : mode === "note" ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                  Kind
                  <Select
                    value={noteKind}
                    onValueChange={(value) => setNoteKind(value === "excerpt" ? "excerpt" : "note")}
                    options={[
                      { value: "note", label: "My note" },
                      { value: "excerpt", label: "A passage I'm keeping" },
                    ]}
                  />
                </label>
                <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                  From
                  <Select value={noteFrom} onValueChange={setNoteFrom} options={fromOptions} />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                <span>
                  Title <span className="text-tertiary">· optional</span>
                </span>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
              </label>
              <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                {noteKind === "excerpt" ? "The passage" : "Note"}
                <Textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} className="max-h-[45dvh] min-h-40 overflow-y-auto text-body-sm" />
              </label>
              {noteKind === "excerpt" && (
                <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                  <span>
                    Source link <span className="text-tertiary">· optional</span>
                  </span>
                  <Input value={link} onChange={(event) => setLink(event.target.value)} inputMode="url" />
                </label>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-body-sm text-muted-foreground">
                ChatGPT or Claude export (<span className="font-mono text-[12px]">conversations.json</span>), Markdown or text.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.md,.markdown,.txt,application/json,text/markdown,text/plain"
                className="sr-only"
                id="capture-import-file"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
              <Button type="button" variant="secondary" className="w-fit" disabled={busy} onClick={() => fileRef.current?.click()}>
                <FileUp /> {busy ? "Reading…" : "Choose a file"}
              </Button>
              {imported && (
                <div className="flex flex-col gap-2 rounded-md border border-subtle p-3">
                  <p className="text-body-sm text-foreground">{imported.fileName}</p>
                  <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                    Save it as
                    <Select value={noteFrom} onValueChange={setNoteFrom} options={[...providerOptions.map((option) => ({ ...option, label: `A ${option.label} conversation` })), { value: NOT_FROM_AI, label: "A note (not from an AI app)" }]} />
                  </label>
                  {noteFrom !== NOT_FROM_AI && parsed && (
                    <p className="text-meta text-muted-foreground">
                      {parsed.structured ? `${parsed.turns.length} turns` : "No speaker labels — kept as one block of text"}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-body-sm text-destructive">
              <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}

          <DialogFooter>
            {done ? (
              <>
                <Button type="button" variant="ghost" onClick={reset}>
                  Add another
                </Button>
                <Button type="button" onClick={() => onOpenChange(false)}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                {(mode !== "import" || imported) && (
                  <Button type="submit" disabled={busy || (mode !== "import" && !text.trim())}>
                    {busy ? "Saving…" : "Save"}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
