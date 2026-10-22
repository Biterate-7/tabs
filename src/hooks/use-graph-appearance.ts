"use client"

import { useSyncExternalStore } from "react"
import { DEFAULT_GRAPH_APPEARANCE, GRAPH_APPEARANCE_KEY, loadGraphAppearance, saveGraphAppearance } from "@/lib/knowledge-graph/appearance"
import type { GraphAppearance } from "@/lib/knowledge-graph/appearance"

/**
 * The Graph's appearance (lib/knowledge-graph/appearance.ts), shared by
 * everything that shows or edits it and kept in step with other windows.
 *
 * The snapshot is re-parsed only when the stored value changes, so a
 * slider dragged at frame rate costs one small write per step and every
 * reader sees the same object until the next one.
 */
const listeners = new Set<() => void>()
let cached: { raw: string | null; value: GraphAppearance } | null = null

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(GRAPH_APPEARANCE_KEY)
  } catch {
    return cached?.raw ?? null
  }
}

function snapshot(): GraphAppearance {
  const raw = readRaw()
  if (!cached || cached.raw !== raw) cached = { raw, value: loadGraphAppearance() }
  return cached.value
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  // Another window changed it: the next snapshot reads the new value.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === GRAPH_APPEARANCE_KEY) onChange()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", onStorage)
  }
}

export function setGraphAppearance(update: GraphAppearance | ((current: GraphAppearance) => GraphAppearance)): void {
  const next = typeof update === "function" ? update(snapshot()) : update
  saveGraphAppearance(next)
  cached = { raw: readRaw(), value: next }
  for (const listener of listeners) listener()
}

export function useGraphAppearance(): GraphAppearance {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_GRAPH_APPEARANCE)
}
