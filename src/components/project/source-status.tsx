"use client"

import { AlertCircle, Check, CheckCircle2, Circle, FileText, Globe, Link2, Loader2, MessagesSquare, PlayCircle, Film, FileType2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { CONVERSATION_NEEDS_CAPTURE } from "@/lib/resources/extraction"
import type { ResourceKind, ResourceStatus, TabResource } from "@/lib/resources/types"

/** One glyph per kind, so a list of sources reads at a glance. */
export function SourceKindIcon({ kind, className }: { kind: ResourceKind; className?: string }) {
  const Icon = { webpage: Globe, pdf: FileText, youtube: PlayCircle, video: Film, document: FileType2, conversation: MessagesSquare, unknown: Link2 }[kind]
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`

/** What Hubble holds for a ready source, in words: "12 pages", "1,840 words", "214 transcript lines". */
export function contentLine(resource: TabResource): string | undefined {
  const content = resource.content
  if (!content) return undefined
  if (content.pages) return `${plural(content.pages, "page", "pages")} of text${content.truncated ? " (first part)" : ""}`
  if (content.transcriptLines) return `Transcript · ${plural(content.transcriptLines, "line", "lines")}`
  if (content.turns) return `${plural(content.turns, "turn", "turns")}${content.truncated ? " (first part)" : ""}`
  const words = Math.max(1, Math.round(content.chars / 6))
  return `${plural(words, "word", "words")}${content.truncated ? " (first part)" : ""}`
}

/**
 * A source's state — always as words with an icon, never colour alone:
 *
 *   ○ Waiting           · added, not read yet
 *   ◌ Reading…          · Hubble is reading it now
 *   ✓ Ready · 12 pages  · Hubble holds its text: searchable, reusable
 *   ✓ Saved · <why>     · kept by address and metadata only — saved fine,
 *                         its content just isn’t readable ("Content unavailable — …")
 *   ⚠ Couldn't read     · nothing usable yet — retry, or bring the file
 */
export function SourceStatus({ resource, compact = false }: { resource: TabResource; compact?: boolean }) {
  const { status } = resource
  // A link-only conversation's words are today's, not the ones saved with it (older ones offered a paste Hubble no longer has).
  const error = resource.error?.code === "needs_capture" ? CONVERSATION_NEEDS_CAPTURE : resource.error
  const detail = status === "ready" ? contentLine(resource) : status === "partial" || status === "failed" ? error?.message : undefined
  return <StatusLine status={status} {...(detail ? { detail } : {})} compact={compact} />
}

/** The status line itself, for anything read like a source (an uploaded file too). */
export function StatusLine({ status, detail, compact = false }: { status: ResourceStatus; detail?: string; compact?: boolean }) {
  const label = { pending: "Waiting", processing: "Reading…", ready: "Ready", partial: "Saved", failed: "Couldn't read" }[status]
  const Icon = { pending: Circle, processing: Loader2, ready: CheckCircle2, partial: Check, failed: AlertCircle }[status]
  return (
    <p className={cn("flex min-w-0 items-start gap-1.5 text-meta", status === "failed" ? "text-destructive" : "text-muted-foreground")} data-source-status={status}>
      <Icon aria-hidden className={cn("mt-px size-3.5 shrink-0", status === "processing" && "animate-spin", status === "ready" && "text-link")} />
      <span className={cn("min-w-0", compact && "truncate")}>
        <span className={cn("font-medium", status === "ready" ? "text-foreground" : undefined)}>{label}</span>
        {detail && <span> · {detail}</span>}
      </span>
    </p>
  )
}
