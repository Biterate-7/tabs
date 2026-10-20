"use client"

import { useEffect, useRef } from "react"
import { BROWSER_MESSAGE_SOURCE } from "@/lib/browser/protocol"
import { readConversationCapture } from "@/lib/conversations/capture"
import { findSavedConversation } from "@/lib/conversations/lookup"
import { getProjectContents } from "@/lib/resources/content-store"
import { buildMemoryBundle } from "@/lib/memory/bundle"
import { knowledgeItemsOf } from "@/lib/memory/items"
import { searchKnowledge } from "@/lib/memory/search"
import { BUNDLE_LENGTH_BUDGET, EXTENSION_SEARCH_LIMIT, MSG_PAGE_REQUEST, MSG_PAGE_RESPONSE, providerOrUndefined, readPageRequest } from "@/lib/memory/extension-protocol"
import { subjectName } from "@/lib/product/subjects"
import { createId } from "@/lib/id"
import { suggestSessionName } from "@/lib/sessions/capture"
import { cleanSessionName, createSession } from "@/lib/sessions/model"
import { writeSessions } from "@/lib/sessions/persistence"
import type { ConversationInput } from "@/lib/conversations/types"
import type { ExtensionSearchHit, PageRequest } from "@/lib/memory/extension-protocol"
import type { AiProviderId } from "@/lib/providers/registry"
import type { ResourceContent } from "@/lib/resources/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

/** What saving one captured conversation did. */
export type CaptureSaveResult =
  | { ok: true; outcome: "added" | "updated" | "unchanged" | "kept"; title: string }
  | { ok: false; reason: "project-missing" | "storage-failed" }

export type ExtensionMemoryHandlers = {
  /** The latest committed store, read when each request arrives. */
  getStore: () => WorkspaceStore | null
  /** The one conversation save (the shell's), for a capture the extension read. */
  saveCapture: (workspaceId: string, input: ConversationInput, truncated: boolean) => Promise<CaptureSaveResult>
  /** The person copied or inserted context from the extension. */
  onReused?: (info: { workspaceId: string; items: number; provider?: AiProviderId; how: "copied" | "inserted" }) => void
}

/**
 * Answers Hubble for Chrome's memory requests (lib/memory/extension-protocol.ts):
 * list projects, save a captured conversation, search, build context — and
 * save a session of Chrome tabs (lib/sessions).
 *
 * Mounted once, by the shell, once the store can take writes (`ready`).
 * Before that, requests are left unanswered and the extension's own timeout
 * says Hubble isn't ready — never a guess.
 */
export function useExtensionMemory(handlers: ExtensionMemoryHandlers, ready: boolean) {
  const handlersRef = useRef(handlers)
  const readyRef = useRef(ready)
  // eslint-disable-next-line react-hooks/refs
  handlersRef.current = handlers
  // eslint-disable-next-line react-hooks/refs
  readyRef.current = ready

  useEffect(() => {
    function respond(requestId: string, body: { ok: true; result: unknown } | { ok: false; error: string }) {
      window.postMessage({ source: BROWSER_MESSAGE_SOURCE, type: MSG_PAGE_RESPONSE, payload: { requestId, ...body } }, window.location.origin)
    }

    async function answer(request: PageRequest): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
      const store = handlersRef.current.getStore()
      if (!store) return { ok: false, error: "not-ready" }
      switch (request.kind) {
        case "projects":
          return {
            ok: true,
            result: {
              currentId: store.currentId,
              projects: store.workspaces.map((workspace) => ({ id: workspace.id, name: subjectName(workspace), items: knowledgeItemsOf(workspace).length })),
            },
          }
        case "capture": {
          if (!store.workspaces.some((workspace) => workspace.id === request.args.workspaceId)) return { ok: false, error: "project-missing" }
          const read = readConversationCapture(request.args.capture)
          if (!read.ok) return { ok: false, error: read.reason }
          const saved = await handlersRef.current.saveCapture(request.args.workspaceId, read.conversation, read.truncated)
          return saved.ok ? { ok: true, result: { outcome: saved.outcome, title: saved.title, turns: read.conversation.turns.length, truncated: read.truncated } } : { ok: false, error: saved.reason }
        }
        case "saved": {
          // This one conversation's places, never its app's: an address that names no conversation answers none.
          const places = findSavedConversation(store, request.args.url)
          if (!places) return { ok: true, result: { conversation: false, saved: [] } }
          const names = new Map(store.workspaces.map((workspace) => [workspace.id, subjectName(workspace)]))
          return { ok: true, result: { conversation: true, saved: places.map((place) => ({ ...place, projectName: names.get(place.workspaceId) ?? "" })) } }
        }
        case "search": {
          const { query, workspaceId } = request.args
          const workspaces = workspaceId ? store.workspaces.filter((workspace) => workspace.id === workspaceId) : store.workspaces
          if (workspaceId && workspaces.length === 0) return { ok: false, error: "project-missing" }
          const names = new Map(store.workspaces.map((workspace) => [workspace.id, subjectName(workspace)]))
          // No words: the project's newest items, so the popup has something to choose from.
          if (query.trim().length < 2) {
            const recent = workspaces
              .flatMap((workspace) => knowledgeItemsOf(workspace))
              .sort((a, b) => b.addedAt - a.addedAt)
              .slice(0, EXTENSION_SEARCH_LIMIT)
            const hits: ExtensionSearchHit[] = recent.map((item) => ({
              workspaceId: item.workspaceId,
              projectName: names.get(item.workspaceId) ?? "",
              ref: item.ref,
              title: item.title,
              type: item.type,
              ...(item.provider ? { provider: item.provider } : {}),
              hasText: item.hasText,
            }))
            return { ok: true, result: { hits } }
          }
          const contents = new Map<string, ReadonlyMap<string, ResourceContent>>()
          for (const workspace of workspaces) contents.set(workspace.id, await getProjectContents(workspace.id).catch(() => new Map<string, ResourceContent>()))
          const hits: ExtensionSearchHit[] = searchKnowledge({ query, workspaces, contents, limit: EXTENSION_SEARCH_LIMIT }).flatMap((hit) =>
            hit.item
              ? [
                  {
                    workspaceId: hit.workspaceId,
                    projectName: names.get(hit.workspaceId) ?? "",
                    ref: hit.ref,
                    title: hit.item.title,
                    type: hit.item.type,
                    ...(hit.item.provider ? { provider: hit.item.provider } : {}),
                    snippet: hit.snippet.slice(0, 240),
                    hasText: hit.item.hasText,
                  },
                ]
              : []
          )
          return { ok: true, result: { hits } }
        }
        case "bundle": {
          const workspace = store.workspaces.find((entry) => entry.id === request.args.workspaceId)
          if (!workspace) return { ok: false, error: "project-missing" }
          const contents = await getProjectContents(workspace.id).catch(() => undefined)
          if (!contents) return { ok: false, error: "storage-failed" }
          const bundle = buildMemoryBundle({
            workspace,
            refs: request.args.refs,
            contents,
            ...(request.args.request ? { request: request.args.request } : {}),
            budget: BUNDLE_LENGTH_BUDGET[request.args.length ?? "standard"],
          })
          return { ok: true, result: { text: bundle.text, chars: bundle.chars, omitted: bundle.omitted, providers: bundle.providers } }
        }
        case "save-session": {
          const { name, workspaceId, tabs } = request.args
          const project = workspaceId ? store.workspaces.find((workspace) => workspace.id === workspaceId) : undefined
          if (workspaceId && !project) return { ok: false, error: "project-missing" }
          const now = Date.now()
          const saved = writeSessions((state) =>
            createSession(
              state,
              {
                name: cleanSessionName(name) || suggestSessionName({ ...(project ? { projectName: subjectName(project) } : {}), now }),
                tabs,
                ...(project ? { workspaceId: project.id } : {}),
              },
              { now, mintId: createId }
            )
          )
          if (!saved.ok) return { ok: false, error: saved.error === "empty" ? "session-empty" : saved.error }
          // Tabs the page refused (an address that is not an ordinary web page) are counted, never hidden.
          return { ok: true, result: { id: saved.value.id, name: saved.value.name, tabs: saved.value.tabs.length, dropped: tabs.length - saved.value.tabs.length } }
        }
        case "reused": {
          const provider = providerOrUndefined(request.args.provider)
          handlersRef.current.onReused?.({ workspaceId: request.args.workspaceId, items: request.args.items, how: request.args.how, ...(provider ? { provider } : {}) })
          return { ok: true, result: {} }
        }
      }
    }

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      if (event.source !== window) return
      const data = event.data as { source?: unknown; type?: unknown; payload?: unknown } | null
      if (!data || data.source !== BROWSER_MESSAGE_SOURCE || data.type !== MSG_PAGE_REQUEST) return
      const envelope = readPageRequest(data.payload)
      if (!envelope) {
        const requestId = (data.payload as { requestId?: unknown } | undefined)?.requestId
        if (typeof requestId === "string" && requestId.length <= 100) respond(requestId, { ok: false, error: "invalid" })
        return
      }
      // Not able to answer yet: say so, rather than answer from an unloaded store.
      if (!readyRef.current) {
        respond(envelope.requestId, { ok: false, error: "not-ready" })
        return
      }
      void answer(envelope.request)
        .then((body) => respond(envelope.requestId, body))
        .catch(() => respond(envelope.requestId, { ok: false, error: "failed" }))
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [])
}
