"use client"

import { ItemIcon } from "@/components/memory/item-icon"
import { describeCapture } from "@/lib/intelligence/records"
import { cn } from "@/lib/utils"
import type { KnowledgeItem } from "@/lib/memory/items"
import type { ActivityRecord } from "@/lib/intelligence/types"

/**
 * One detected page, the way every context surface lists it: its real icon
 * (Chrome's favicon, or the AI app's own mark), its title, its site, and —
 * always — how much Hubble actually knows about it. "Title only" is said as
 * plainly as "Read".
 */

const TYPE: Record<ActivityRecord["kind"], KnowledgeItem["type"]> = {
  conversation: "conversation",
  document: "document",
  article: "webpage",
  webpage: "webpage",
  video: "video",
  pdf: "pdf",
}

export function recordIconItem(record: ActivityRecord): Pick<KnowledgeItem, "type" | "url" | "domain" | "provider" | "ref"> {
  return { type: TYPE[record.kind], url: record.url, domain: record.domain, ...(record.provider ? { provider: record.provider } : {}), ref: { kind: "source", tabId: record.key } }
}

export function recordTitle(record: Pick<ActivityRecord, "title" | "domain">): string {
  return record.title || record.domain
}

export function CaptureBadge({ record, className }: { record: ActivityRecord; className?: string }) {
  const capture = describeCapture(record)
  return (
    <span
      title={capture.detail}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-meta",
        capture.complete ? "bg-surface-hover text-muted-foreground" : "text-tertiary ring-1 ring-inset ring-subtle",
        className
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", capture.complete ? "bg-success" : record.capture.status === "partial" ? "bg-warning" : "bg-strong")} />
      {/* A dot alone on a phone; the words stay for screen readers. */}
      <span className="max-sm:sr-only">{capture.label}</span>
      <span className="sr-only">: {capture.detail}</span>
    </span>
  )
}

export function ActivityRow({ record, trailing, className }: { record: ActivityRecord; trailing?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <ItemIcon item={recordIconItem(record)} {...(record.favicon ? { favicon: record.favicon } : {})} size={14} className="size-3.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm text-foreground">{recordTitle(record)}</span>
        <span className="block truncate text-meta text-tertiary">{record.domain}</span>
      </span>
      <CaptureBadge record={record} className="max-sm:px-1 max-sm:ring-0 max-sm:bg-transparent" />
      {trailing}
    </div>
  )
}
