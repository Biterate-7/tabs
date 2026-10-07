"use client"

import { AlertCircle, CheckCircle2, Circle, FileText, Globe, Info, Link2, Loader2, PlayCircle, Film, FileType2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ResourceKind, TabResource } from "@/lib/resources/types"

/** One glyph per kind, so a list of sources reads at a glance. */
export function SourceKindIcon({ kind, className }: { kind: ResourceKind; className?: string }) {
  const Icon = { webpage: Globe, pdf: FileText, youtube: PlayCircle, video: Film, document: FileType2, unknown: Link2 }[kind]
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`

/** What Hubble holds for a ready source, in words: "12 pages", "1,840 words", "214 transcript lines". */
export function contentLine(resource: TabResource): string | undefined {
  const content = resource.content
  if (!content) return undefined
  if (content.pages) return `${plural(content.pages, "page", "pages")} of text${content.truncated ? " (first part)" : ""}`
  if (content.transcriptLines) return `Transcript · ${plural(content.transcriptLines, "line", "lines")}`
  const words = Math.max(1, Math.round(content.chars / 6))
  return `${plural(words, "word", "words")}${content.truncated ? " (first part)" : ""}`
}

/**
 * A source's state — always as words with an icon, never colour alone:
 *
 *   ○ Waiting           · added, not read yet
 *   ◌ Reading…          · Hubble is reading it now
 *   ✓ Ready · 12 pages  · agents can read its text
 *   ⓘ Saved · <why>     · kept by address and metadata only
 *   ⚠ Couldn't read     · nothing usable yet — retry, or bring the file
 */
export function SourceStatus({ resource, compact = false }: { resource: TabResource; compact?: boolean }) {
  const { status } = resource
  const detail = status === "ready" ? contentLine(resource) : status === "partial" || status === "failed" ? resource.error?.message : undefined
  const label = { pending: "Waiting", processing: "Reading…", ready: "Ready", partial: "Saved", failed: "Couldn't read" }[status]
  const Icon = { pending: Circle, processing: Loader2, ready: CheckCircle2, partial: Info, failed: AlertCircle }[status]
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
