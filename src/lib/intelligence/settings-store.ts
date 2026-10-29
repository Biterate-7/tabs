"use client"

import { getStorageNamespace } from "@/lib/storage/namespace"
import { getContextSettings, requestConversationAccess, setContextSettings } from "./bridge"
import type { ContextAnswer, ContextBridgeError, ExtensionContextSettings } from "./bridge"
import type { ContextSettings } from "./types"
import type { AiProviderId } from "@/lib/providers/registry"

/**
 * The person's detection choices as the extension holds them, shared by
 * every surface that shows them (first-run choice, Home, Settings) so they
 * never disagree. The extension is the source of truth: nothing here is
 * stored, and a change is shown only once the extension has kept it.
 */

export type SettingsView =
  | { status: "unknown" }
  | { status: "loading"; last?: ExtensionContextSettings }
  | { status: "ready"; value: ExtensionContextSettings }
  | { status: "unavailable"; error: ContextBridgeError; last?: ExtensionContextSettings }

const UNKNOWN: SettingsView = Object.freeze({ status: "unknown" })
let view: SettingsView = UNKNOWN
// The identity (storage namespace) the view was answered for: another identity always sees it as unknown.
let viewIdentity: string | null | undefined
const listeners = new Set<() => void>()
let inFlight: Promise<SettingsView> | null = null
// Saves started so far, and how many are still waiting for the extension. A refresh that overlapped a save may have
// read the extension's settings from before it, and answer after it: the save's own answer is the newer one.
let savesStarted = 0
let savesPending = 0

function set(next: SettingsView) {
  view = next
  viewIdentity = getStorageNamespace()
  for (const listener of listeners) listener()
}

const lastOf = (current: SettingsView): ExtensionContextSettings | undefined =>
  current.status === "ready" ? current.value : current.status === "loading" || current.status === "unavailable" ? current.last : undefined

export function getSettingsView(): SettingsView {
  return viewIdentity === getStorageNamespace() ? view : UNKNOWN
}

export function subscribeSettingsView(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Asks the extension again. Concurrent calls share one request. */
export function refreshSettings(): Promise<SettingsView> {
  if (inFlight) return inFlight
  const last = lastOf(getSettingsView())
  const identity = getStorageNamespace()
  const savedBefore = savesStarted
  const startedDuringSave = savesPending > 0
  set({ status: "loading", ...(last ? { last } : {}) })
  inFlight = getContextSettings()
    .then((answer) => {
      // Asked for one identity, answered after a switch to another: not shown to the new one.
      if (getStorageNamespace() !== identity) {
        const next: SettingsView = { status: "unknown" }
        set(next)
        return next
      }
      // Overlapped a save: possibly older than it. The save's answer sets the view (or already has).
      if (startedDuringSave || savesPending > 0 || savesStarted !== savedBefore) return getSettingsView()
      const next: SettingsView = answer.ok ? { status: "ready", value: answer.value } : { status: "unavailable", error: answer.error, ...(last ? { last } : {}) }
      set(next)
      return next
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Changes the settings in the extension; the view changes only on its answer. */
export async function saveSettings(patch: Partial<ContextSettings>): Promise<ContextAnswer<ExtensionContextSettings>> {
  const identity = getStorageNamespace()
  savesStarted += 1
  savesPending += 1
  let answer: ContextAnswer<ExtensionContextSettings>
  try {
    answer = await setContextSettings(patch)
  } finally {
    savesPending -= 1
  }
  if (getStorageNamespace() !== identity) {
    set({ status: "unknown" })
    return answer
  }
  if (answer.ok) set({ status: "ready", value: answer.value })
  else {
    const last = lastOf(getSettingsView())
    set({ status: "unavailable", error: answer.error, ...(last ? { last } : {}) })
  }
  return answer
}

/**
 * Turns on reading an AI app's conversations: records the wish, then asks
 * Chrome for the access in the extension's own window. Resolves with whether
 * Chrome granted it; the setting stays on either way, and Settings says when
 * the access is missing.
 */
export async function enableConversationReading(provider: AiProviderId, current: ContextSettings): Promise<{ ok: boolean; granted: boolean }> {
  const saved = await saveSettings({ readConversations: [...new Set([...current.readConversations, provider])] })
  if (!saved.ok) return { ok: false, granted: false }
  if (saved.value.granted.includes(provider)) return { ok: true, granted: true }
  const asked = await requestConversationAccess(provider)
  await refreshSettings()
  return { ok: asked.ok, granted: asked.ok && asked.value.granted }
}

/** Test-only. */
export function __resetSettingsViewForTests(): void {
  view = UNKNOWN
  viewIdentity = undefined
  listeners.clear()
  inFlight = null
  savesStarted = 0
  savesPending = 0
}
