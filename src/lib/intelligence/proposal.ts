import { describeAddress } from "@/lib/organize/smart/items"
import type { SmartItem, SmartProposal } from "@/lib/organize/smart/types"
import type { ActivityRecord, Suggestion } from "./types"

/**
 * A confirmed suggestion, as the Smart Organize proposal its apply already
 * understands — so accepting one goes through `applySmartToSubjects`: the
 * same `ingestResources` door every source comes through (validation,
 * duplicate rule, background reading), a project found by name before one is
 * made, and the same guarded Undo. Context intelligence adds no second way
 * of putting anything in a project.
 */

export type SuggestionEdits = {
  /** The pages the person kept. */
  recordKeys: readonly string[]
  destination: { kind: "project"; workspaceId: string } | { kind: "new-project"; name: string }
}

export function proposalFromSuggestion(suggestion: Suggestion, records: readonly ActivityRecord[], edits: SuggestionEdits): SmartProposal | null {
  const byKey = new Map(records.map((record) => [record.key, record]))
  const items: SmartItem[] = []
  for (const key of edits.recordKeys) {
    if (!suggestion.recordKeys.includes(key)) continue
    const record = byKey.get(key)
    const address = record ? describeAddress(record.url) : null
    if (!record || !address) continue
    items.push({ id: `ctx-${items.length + 1}`, url: address.url, normalizedUrl: address.normalizedUrl, resourceKey: address.resourceKey, domain: address.domain, title: record.title, ...(record.favicon ? { favicon: record.favicon } : {}) })
  }
  if (items.length === 0) return null
  const name = edits.destination.kind === "new-project" ? edits.destination.name.trim() : ""
  if (edits.destination.kind === "new-project" && !name) return null
  return {
    mode: "open-tabs",
    items,
    groups: [
      {
        id: "group-1",
        name: name || "Project",
        reason: "",
        itemIds: items.map((item) => item.id),
        destination: edits.destination.kind === "project" ? { kind: "subject", workspaceId: edits.destination.workspaceId } : { kind: "new-subject" },
      },
    ],
    review: [],
    excluded: [],
    duplicates: [],
    truncated: 0,
  }
}
