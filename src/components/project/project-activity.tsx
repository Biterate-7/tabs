"use client"

import { ProviderMark } from "@/components/memory/provider-mark"
import { aiProviderName, isAiProviderId } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"
import type { ProjectEvent } from "@/lib/projects/activity"
import type { ResourceOrigin } from "@/lib/resources/types"

const ORIGIN_WORDS: Record<ResourceOrigin, string> = {
  chrome: " from Chrome",
  extension: " with Hubble for Chrome",
  manual: "",
  upload: " by upload",
  import: " from your saved tabs",
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export type ActivityRow = { key: string; at: number; event: ProjectEvent; count: number }

/** Consecutive "Hubble read …" events become one row, so a big drop reads as one thing that happened. */
export function activityRows(events: readonly ProjectEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  for (const event of events) {
    const last = rows[rows.length - 1]
    if (last && (event.kind === "source_ready" || event.kind === "source_failed") && last.event.kind === event.kind && sameDay(last.at, event.at)) {
      last.count += 1
      continue
    }
    rows.push({ key: event.id, at: event.at, event, count: 1 })
  }
  return rows
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

export function dayLabel(at: number, now: number): string {
  if (sameDay(at, now)) return "Today"
  if (sameDay(at, now - 86_400_000)) return "Yesterday"
  return new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
}

const providerWords = (provider: string | undefined) => (isAiProviderId(provider) ? ` from ${aiProviderName(provider)}` : "")

export function describeProjectEvent(row: ActivityRow, input: { projectName: string; titleOf: (id: string) => string | undefined }): string {
  const { event, count } = row
  switch (event.kind) {
    case "project_created":
      return `You created ${input.projectName}`
    case "sources_added":
      return `You added ${plural(event.count ?? 1, "source", "sources")}${event.origin ? ORIGIN_WORDS[event.origin] : ""}`
    case "sources_removed":
      return `You removed ${plural(event.count ?? 1, "item", "items")}`
    case "source_ready": {
      if (count > 1) return `Hubble read ${count} sources`
      const title = event.tabId ? input.titleOf(event.tabId) : undefined
      return title ? `Hubble read ${title}` : "Hubble read a source (since removed)"
    }
    case "source_failed": {
      if (count > 1) return `Hubble couldn't read ${count} sources`
      const title = event.tabId ? input.titleOf(event.tabId) : undefined
      return title ? `Hubble couldn't read ${title}` : "Hubble couldn't read a source (since removed)"
    }
    case "conversation_saved":
      return (event.count ?? 1) > 1 ? `You saved ${plural(event.count ?? 1, "conversation", "conversations")}${providerWords(event.provider)}` : `You saved a conversation${providerWords(event.provider)}`
    case "conversation_updated":
      return `You updated a saved conversation${providerWords(event.provider)}`
    case "note_added":
      return "You added a note"
    case "memory_reused":
      return `You used ${plural(event.count ?? 1, "item", "items")} in an AI chat`
    case "project_resumed":
      return (event.count ?? 0) > 0 ? `You picked up where you left off and reopened ${plural(event.count ?? 0, "tab", "tabs")}` : "You picked up where you left off"
    // Records left by the removed agent features are never listed (projectEventsIn drops them).
    default:
      return "Earlier activity"
  }
}

/**
 * A project's history, by day: what came in (sources, conversations, notes),
 * what Hubble read, and when its knowledge was reused.
 */
export function ProjectActivity({
  events,
  projectName,
  titleOf,
  now,
  limit,
}: {
  events: readonly ProjectEvent[]
  projectName: string
  titleOf: (id: string) => string | undefined
  now: number
  limit?: number
}) {
  const rows = activityRows(events).slice(0, limit)
  if (rows.length === 0) {
    return <p className="text-body-sm text-muted-foreground">Nothing has happened in this project yet.</p>
  }
  // A day's heading goes above its first row.
  const days = rows.map((row) => dayLabel(row.at, now))
  return (
    <ol className="flex flex-col" aria-label={`What happened in ${projectName}`}>
      {rows.map((row, index) => {
        const heading = index === 0 || days[index] !== days[index - 1] ? days[index] : null
        const time = new Date(row.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        const provider = isAiProviderId(row.event.provider) ? row.event.provider : undefined
        return (
          <li key={row.key} className={cn("flex flex-col", heading && "mt-2 first:mt-0")} data-project-event={row.event.kind}>
            {heading && <p className="mb-1 text-eyebrow text-tertiary">{heading}</p>}
            <div className="flex min-w-0 items-start gap-2 py-1">
              <span className="w-12 shrink-0 text-meta tabular-nums text-tertiary">{time}</span>
              {provider && <ProviderMark provider={provider} size={14} className="mt-0.5" />}
              <p className="min-w-0 flex-1 text-body-sm text-foreground">{describeProjectEvent(row, { projectName, titleOf })}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
