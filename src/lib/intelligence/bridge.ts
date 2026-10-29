"use client"

import { sendBrowserCommand } from "@/lib/browser/bridge"
import { DESKTOP_UNREACHABLE } from "@/lib/browser/protocol"
import { AI_PROVIDER_IDS, isAiProviderId } from "@/lib/providers/registry"
import { sourceKey } from "@/lib/resources/url"
import { readActivityRecord } from "./records"
import { cleanExcludedHost } from "./sites"
import { DETECTION_MODES, RETENTION_CHOICES, SITE_CATEGORIES } from "./types"
import type { AiProviderId } from "@/lib/providers/registry"
import type { ActivityRecord, ContextSettings, DetectionMode, RetentionDays, SiteCategory } from "./types"

/**
 * Hubble's side of context detection's commands (extension/src/browser-commands.js
 * validates them there; background.js answers only this page). Every answer
 * is re-read with a closed shape: the extension is trusted to have applied the
 * person's choices, never to have sent well-formed data.
 *
 * Every call resolves — a missing extension, an older one that doesn't know
 * these commands, and a timeout are values, not exceptions.
 */

export type ContextBridgeError =
  /** Hubble for Chrome isn't answering on this page. */
  | "not-connected"
  /** The installed extension predates context detection. */
  | "needs-update"
  /** Hubble Desktop: the extension can't reach it. */
  | "desktop"
  | "failed"

export type ContextAnswer<T> = { ok: true; value: T } | { ok: false; error: ContextBridgeError; detail?: string }

export type ExtensionContextSettings = {
  settings: ContextSettings
  /** AI apps Chrome has granted Hubble access to right now. */
  granted: AiProviderId[]
  incognitoAllowed: boolean
  version: string
}

export type ActivityPull = {
  epoch: string
  seq: number
  reset: boolean
  records: ActivityRecord[]
  removed: string[]
  /** Hubble's own keys (sourceKey) of the detectable tabs open in Chrome right now. */
  openKeys: string[]
}

function errorOf(error: string): ContextBridgeError {
  if (error === DESKTOP_UNREACHABLE) return "desktop"
  if (/unknown or disallowed browser action/i.test(error)) return "needs-update"
  if (/timed out|extension-unreachable|no-response/i.test(error)) return "not-connected"
  return "failed"
}

async function call<T>(action: Parameters<typeof sendBrowserCommand>[0], args: unknown, read: (value: unknown) => T | undefined, timeoutMs?: number): Promise<ContextAnswer<T>> {
  const answer = await sendBrowserCommand<unknown, unknown>(action, args, timeoutMs ? { timeoutMs } : undefined)
  if (!answer.ok) return { ok: false, error: errorOf(answer.error), detail: answer.error.slice(0, 200) }
  const value = read(answer.result)
  return value === undefined ? { ok: false, error: "failed", detail: "malformed answer" } : { ok: true, value }
}

export function readSettings(value: unknown): ContextSettings | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const mode: DetectionMode = (DETECTION_MODES as readonly unknown[]).includes(raw.mode) ? (raw.mode as DetectionMode) : "off"
  const categories = Array.isArray(raw.categories) ? SITE_CATEGORIES.filter((category) => (raw.categories as unknown[]).includes(category)) : []
  const excludedHosts = Array.isArray(raw.excludedHosts)
    ? [...new Set(raw.excludedHosts.map((host) => (typeof host === "string" ? cleanExcludedHost(host) : undefined)).filter((host): host is string => host !== undefined))]
    : []
  const readConversations = Array.isArray(raw.readConversations) ? AI_PROVIDER_IDS.filter((id) => (raw.readConversations as unknown[]).includes(id)) : []
  const retentionDays: RetentionDays = (RETENTION_CHOICES as readonly unknown[]).includes(raw.retentionDays) ? (raw.retentionDays as RetentionDays) : 30
  const finite = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry) && entry > 0
  return {
    version: 1,
    mode,
    ...(finite(raw.decidedAt) ? { decidedAt: raw.decidedAt } : {}),
    categories: categories as SiteCategory[],
    excludedHosts,
    paused: raw.paused === true,
    ...(raw.paused === true && finite(raw.pausedUntil) ? { pausedUntil: raw.pausedUntil } : {}),
    readConversations,
    retentionDays,
  }
}

function readSettingsAnswer(value: unknown): ExtensionContextSettings | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const settings = readSettings(raw.settings)
  if (!settings) return undefined
  return {
    settings,
    granted: Array.isArray(raw.granted) ? raw.granted.filter(isAiProviderId) : [],
    incognitoAllowed: raw.incognitoAllowed === true,
    version: typeof raw.version === "string" ? raw.version.slice(0, 40) : "",
  }
}

export function readActivityPull(value: unknown): ActivityPull | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.epoch !== "string" || !raw.epoch || raw.epoch.length > 200 || !Number.isInteger(raw.seq) || (raw.seq as number) < 0) return undefined
  const records = (Array.isArray(raw.records) ? raw.records : []).slice(0, 1000).map(readActivityRecord).filter((record): record is ActivityRecord => record !== undefined)
  const strings = (entry: unknown) => (Array.isArray(entry) ? entry.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 2100).slice(0, 2000) : [])
  const openKeys = [...new Set(strings(raw.openUrls).map((url) => sourceKey(url)).filter((key): key is string => key !== undefined))]
  return { epoch: raw.epoch, seq: raw.seq as number, reset: raw.reset === true, records, removed: strings(raw.removed), openKeys }
}

export const getContextSettings = () => call("get_context_settings", {}, readSettingsAnswer)

export const setContextSettings = (settings: Partial<ContextSettings>) => call("set_context_settings", { settings }, readSettingsAnswer)

/** Opens Chrome's permission window for one AI app; waits for the person (up to two minutes). */
export const requestConversationAccess = (provider: AiProviderId) =>
  call(
    "request_context_access",
    { provider },
    (value) => {
      const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
      return raw.provider === provider ? { granted: raw.granted === true } : undefined
    },
    130_000
  )

export const pullActivity = (cursor: { since: number; epoch: string } | undefined) => call("get_context_activity", cursor ?? {}, readActivityPull)

export const forgetActivity = (keys: readonly string[]) =>
  call("forget_context_activity", { keys: keys.slice(0, 400) }, (value) => {
    const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
    return Number.isInteger(raw.forgotten) ? { forgotten: raw.forgotten as number } : undefined
  })

export const clearActivity = () =>
  call("clear_context_activity", {}, (value) => {
    const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
    return typeof raw.epoch === "string" ? { epoch: raw.epoch } : undefined
  })

export type ConversationCaptureAnswer =
  /** The page said it's on disk. */
  | { status: "saved" }
  /** Written down as a job; it is delivered (and retried) by the extension's capture queue. */
  | { status: "queued" }
  | { status: "failed"; reason: string }

/** Saves an open AI conversation's text into a project through Save to Hubble's own job. */
export const captureConversation = (url: string, workspaceId: string) =>
  call(
    "capture_context_conversation",
    { url, workspaceId },
    (value): ConversationCaptureAnswer | undefined => {
      const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
      if (raw.ok === true) return { status: "saved" }
      if (raw.ok !== false) return undefined
      if (raw.queued === true || (raw.job && typeof raw.job === "object" && (raw.job as Record<string, unknown>).status === "queued")) return { status: "queued" }
      return { status: "failed", reason: typeof raw.error === "string" ? raw.error.slice(0, 60) : "failed" }
    },
    60_000
  )
