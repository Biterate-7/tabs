"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { Captions, ExternalLink, FileUp, MessageSquareShare, RotateCw } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { SourceKindIcon, SourceStatus } from "./source-status"
import { VideoTranscript, type TranscriptSeek } from "./video-transcript"
import { captureLine, ConversationView } from "@/components/memory/conversation-view"
import { ProviderBadge } from "@/components/memory/provider-mark"
import { useMemoryActions } from "@/components/memory/memory-actions"
import { GetExtensionButton, useSaveFromAiState } from "@/components/memory/save-from-ai"
import { aiProviderName, providerOfUrl } from "@/lib/providers/registry"
import { isDesktop } from "@/lib/platform/detect"
import { getContent } from "@/lib/resources/content-store"
import { formatTimestamp } from "@/lib/resources/transcript"
import { RESOURCE_KIND_LABEL } from "@/lib/resources/types"
import type { ResourceContent } from "@/lib/resources/types"
import type { Tab } from "@/lib/tabs/types"

const PREVIEW_CHARS = 1200

/** The opening of what Hubble read — enough to check it read the right thing, never the whole document in the DOM. */
export function contentPreview(content: ResourceContent): { label: string; text: string } {
  if (content.turns && content.turns.length > 0) {
    return { label: `${content.turns.length} turns`, text: content.turns.slice(0, 4).map((turn) => `${turn.role === "user" ? "You" : "AI"}: ${turn.text}`).join("\n\n").slice(0, PREVIEW_CHARS) }
  }
  if (content.pages && content.pages.length > 0) {
    const first = content.pages.findIndex((page) => page.trim().length > 0)
    const index = first === -1 ? 0 : first
    return { label: `Page ${index + 1} of ${content.pages.length}`, text: content.pages[index]!.slice(0, PREVIEW_CHARS) }
  }
  if (content.transcript && content.transcript.length > 0) {
    return {
      label: `Transcript · ${content.transcript.length} lines`,
      text: content.transcript
        .slice(0, 12)
        .map((line) => `${line.start !== undefined ? `${formatTimestamp(line.start)}  ` : ""}${line.text}`)
        .join("\n"),
    }
  }
  return { label: "Page text", text: (content.text ?? "").slice(0, PREVIEW_CHARS) }
}

export function SourceDetailsDialog({
  tab,
  workspaceId,
  focusRename = false,
  onOpenChange,
  onRename,
  onRetry,
  onOpen,
  onAttachPdf,
  onAttachTranscript,
  onOpenAt,
  seek,
  focusTurn,
  terms,
}: {
  tab: Tab | null
  workspaceId: string
  focusRename?: boolean
  /** Open the resource at an address Hubble built for it — a video at a moment. Falls back to Open. */
  onOpenAt?: (tab: Tab, url: string) => void
  /** Open a video's transcript at a moment (from search). */
  seek?: TranscriptSeek
  /** Open a conversation at a turn (from search), with the search words marked there. */
  focusTurn?: number
  terms?: readonly string[]
  onOpenChange: (open: boolean) => void
  onRename: (tab: Tab, title: string) => void
  onRetry: (tab: Tab) => void
  onOpen: (tab: Tab) => void
  onAttachPdf: (tab: Tab, file: File) => Promise<void>
  onAttachTranscript: (tab: Tab, text: string) => Promise<{ error?: string }>
}) {
  const resource = tab?.resource
  const [title, setTitle] = useState(tab?.title ?? "")
  const [trackedTab, setTrackedTab] = useState(tab?.id)
  const [content, setContent] = useState<{ key: string; value: ResourceContent | null } | null>(null)
  const [transcript, setTranscript] = useState("")
  const [busy, setBusy] = useState<"pdf" | "transcript" | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const transcriptFile = useRef<HTMLInputElement>(null)
  const memory = useMemoryActions()

  // A different source resets the form — adjusting state during render rather than in an effect.
  if (tab?.id !== trackedTab) {
    setTrackedTab(tab?.id)
    setTitle(tab?.title ?? "")
    setTranscript("")
    setMessage(null)
  }

  const saveFromAi = useSaveFromAiState()
  const contentKey = tab && resource?.content ? `${tab.id}@${resource.content.extractedAt}` : null
  useEffect(() => {
    if (!tab || !contentKey) return
    let cancelled = false
    void getContent(workspaceId, tab.id)
      .then((value) => {
        if (!cancelled) setContent({ key: contentKey, value: value ?? null })
      })
      .catch(() => {
        if (!cancelled) setContent({ key: contentKey, value: null })
      })
    return () => {
      cancelled = true
    }
  }, [tab, workspaceId, contentKey])

  if (!tab || !resource) return null
  const loaded = content?.key === contentKey ? content.value : undefined
  const preview = loaded ? contentPreview(loaded) : null
  const meta = resource.meta ?? {}
  const facts = [
    meta.siteName,
    meta.author ? `By ${meta.author}` : undefined,
    meta.publishedAt ? `Published ${meta.publishedAt.slice(0, 10)}` : undefined,
    meta.pageCount ? `${meta.pageCount} pages` : undefined,
    meta.fileName,
  ].filter(Boolean)
  const isPdf = resource.kind === "pdf"
  const isVideo = resource.kind === "youtube" || resource.kind === "video"
  const isYouTube = resource.kind === "youtube"
  const isConversation = resource.kind === "conversation"
  const provider = isConversation ? (meta.provider ?? providerOfUrl(tab.url)) : undefined

  function rename(event: FormEvent) {
    event.preventDefault()
    if (tab && title.trim() && title.trim() !== tab.title) onRename(tab, title.trim())
  }

  async function uploadPdf(file: File | undefined) {
    if (!file || !tab) return
    setBusy("pdf")
    setMessage(null)
    try {
      await onAttachPdf(tab, file)
    } finally {
      setBusy(null)
    }
  }

  async function addTranscript(text: string) {
    if (!tab || !text.trim()) return
    setBusy("transcript")
    const result = await onAttachTranscript(tab, text)
    setBusy(null)
    if (result.error) setMessage(result.error)
    else {
      setTranscript("")
      setMessage("Transcript added.")
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className={isYouTube ? "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl" : "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"}>
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <SourceKindIcon kind={resource.kind} />
            <span className="truncate">{tab.title?.trim() || tab.domain}</span>
          </DialogTitle>
          <DialogDescription className="break-all">{tab.url}</DialogDescription>
        </DialogHeader>

        <div className="mt-3 flex flex-col gap-4">
          <form onSubmit={rename} className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-meta text-muted-foreground">
              Name
              <Input className="mt-1" value={title} autoFocus={focusRename} onChange={(event) => setTitle(event.target.value)} aria-label="Source name" />
            </label>
            <Button type="submit" variant="secondary" disabled={!title.trim() || title.trim() === tab.title}>
              Save
            </Button>
          </form>

          <div className="flex flex-col gap-1">
            <p className="flex flex-wrap items-center gap-x-1.5 text-meta text-tertiary">
              {provider ? <ProviderBadge provider={provider} /> : null}
              {provider ? "·" : null}
              <span>{RESOURCE_KIND_LABEL[resource.kind]}</span>
              {isConversation ? <span>· {captureLine(meta.capture, resource.updatedAt)}</span> : null}
              {facts.length > 0 ? <span>· {facts.join(" · ")}</span> : null}
            </p>
            <SourceStatus resource={resource} />
          </div>

          {isYouTube && (
            <VideoTranscript
              tab={tab}
              resource={resource}
              content={resource.content ? loaded : null}
              {...(seek ? { seek } : {})}
              embeddable={!isDesktop()}
              onOpenAt={(url) => (onOpenAt ? onOpenAt(tab, url) : onOpen(tab))}
              onRetry={() => onRetry(tab)}
            />
          )}

          {isConversation && loaded && (
            <section aria-label="The saved conversation">
              <p className="mb-1 text-meta text-tertiary">Saved as it was shown{meta.turnCount ? ` · ${meta.turnCount} turns` : ""}. AI-generated replies may contain mistakes.</p>
              <ConversationView turns={loaded.turns} {...(loaded.text ? { text: loaded.text } : {})} {...(provider ? { provider } : {})} {...(focusTurn !== undefined ? { focusTurn } : {})} {...(terms ? { terms } : {})} />
            </section>
          )}

          {isConversation && resource.status !== "ready" && (
            <section aria-label="Save the conversation's text" className="rounded-md border border-subtle p-3">
              <p className="text-body-sm text-foreground">Only the link is saved.</p>
              <p className="text-meta text-muted-foreground">Open it, then choose Save to Hubble in Hubble for Chrome to save its text.</p>
              {saveFromAi !== "connected" && (
                <div className="mt-2">
                  <GetExtensionButton size="sm" variant="secondary" />
                </div>
              )}
            </section>
          )}

          {preview && !isYouTube && !isConversation && (
            <section aria-label="What Hubble read">
              <p className="text-meta text-tertiary">What Hubble read — {preview.label}</p>
              <pre className="mt-1 max-h-48 overflow-y-auto rounded-md border border-subtle bg-background p-2 font-sans text-body-sm whitespace-pre-wrap text-muted-foreground">{preview.text || "(This page of the document has no text.)"}</pre>
            </section>
          )}

          {isPdf && resource.status !== "ready" && (
            <section aria-label="Upload the PDF" className="rounded-md border border-subtle p-3">
              <p className="text-body-sm text-foreground">Hubble needs the file itself to read this PDF.</p>
              <p className="text-meta text-muted-foreground">Download it, then choose it here. It&apos;s read on this device, never uploaded.</p>
              <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label="Choose the PDF file" onChange={(event) => void uploadPdf(event.target.files?.[0])} />
              <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={busy === "pdf"} onClick={() => fileInput.current?.click()}>
                <FileUp /> {busy === "pdf" ? "Reading the PDF…" : "Upload PDF"}
              </Button>
            </section>
          )}

          {isVideo && resource.status !== "ready" && (
            <section aria-label="Add a transcript" className="rounded-md border border-subtle p-3">
              <p className="text-body-sm text-foreground">Add a transcript yourself to search what is said.</p>
              <p className="text-meta text-muted-foreground">On YouTube: description → “Show transcript”, then copy it here. Or choose a .vtt, .srt or .txt file.</p>
              <Textarea className="mt-2 min-h-20 text-body-sm" value={transcript} onChange={(event) => setTranscript(event.target.value)} aria-label="Transcript text" placeholder={"0:00\nIn October 1962…"} />
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={!transcript.trim() || busy === "transcript"} onClick={() => void addTranscript(transcript)}>
                  <Captions /> Add transcript
                </Button>
                <input
                  ref={transcriptFile}
                  type="file"
                  accept=".vtt,.srt,.txt,text/vtt,text/plain"
                  className="sr-only"
                  aria-label="Choose a caption file"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void file.text().then(addTranscript)
                  }}
                />
                <Button type="button" size="sm" variant="ghost" onClick={() => transcriptFile.current?.click()}>
                  Choose a caption file
                </Button>
              </div>
            </section>
          )}
          {message && (
            <p role="status" className="text-body-sm text-muted-foreground">
              {message}
            </p>
          )}
        </div>

        <DialogFooter>
          {/* A video's reader offers its own "Try again" for errors a retry could fix. */}
          {memory && (
            <Button type="button" variant="ghost" onClick={() => memory.reuse({ workspaceId, refs: [{ kind: "source", tabId: tab.id }] })}>
              <MessageSquareShare /> Use in AI
            </Button>
          )}
          {(resource.status === "failed" || resource.status === "partial") && !isConversation && !(isYouTube && resource.error?.retryable) && (
            <Button type="button" variant="ghost" onClick={() => onRetry(tab)}>
              <RotateCw /> Read again
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={() => onOpen(tab)}>
            <ExternalLink /> {provider ? `Open in ${aiProviderName(provider)}` : "Open"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
