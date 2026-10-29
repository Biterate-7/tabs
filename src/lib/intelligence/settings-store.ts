"use client"

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

let view: SettingsView = { status: "unknown" }
const listeners = new Set<() => void>()
let inFlight: Promise<SettingsView> | null = null

function set(next: SettingsView) {
  view = next
  for (const listener of listeners) listener()
}

const lastOf = (current: SettingsView): ExtensionContextSettings | undefined =>
  current.status === "ready" ? current.value : current.status === "loading" || current.status === "unavailable" ? current.last : undefined

export function getSettingsView(): SettingsView {
  return view
}

export function subscribeSettingsView(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Asks the extension again. Concurrent calls share one request. */
export function refreshSettings(): Promise<SettingsView> {
  if (inFlight) return inFlight
  const last = lastOf(view)
  set({ status: "loading", ...(last ? { last } : {}) })
  inFlight = getContextSettings()
    .then((answer) => {
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
  const answer = await setContextSettings(patch)
  if (answer.ok) set({ status: "ready", value: answer.value })
  else {
    const last = lastOf(view)
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
  view = { status: "unknown" }
  listeners.clear()
  inFlight = null
}
