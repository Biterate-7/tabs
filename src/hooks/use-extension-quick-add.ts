"use client"

import { useEffect, useRef, useState } from "react"
import { contentLine } from "@/components/project/source-status"
import {
  BROWSER_MESSAGE_SOURCE,
  MSG_EXTENSION_PONG,
  MSG_PROJECT_FOCUS,
  MSG_QUICK_ADD_INFO,
  MSG_SOURCE_STATUS,
  MSG_SOURCE_STATUS_RESULT,
} from "@/lib/browser/protocol"
import { resourceKey } from "@/lib/resources/url"
import type { ResourceStatus } from "@/lib/resources/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Quick add (Hubble 2.0), the page's half.
 *
 * Chrome's tab strip cannot be dragged onto a web page — no drop event, no
 * data — so the closest supported way to put an actual Chrome tab into a
 * project is the extension's item in that tab's own right-click menu (and a
 * shortcut). This hook keeps that item pointed at the project on screen and
 * lets the extension show, in the page the person is on, how Hubble is
 * getting on reading what they added:
 *
 *   - reports the open project (id, plus every project's id and name so a
 *     remembered one can be renamed or found gone, and whether the page is
 *     visible) whenever it changes, whenever Hubble is looked at again, and
 *     whenever the extension's content script announces itself;
 *   - learns the extension's shortcut back, so the project home can say the
 *     real one (`quickAdd`, undefined until the extension answers);
 *   - answers "how far has reading got?" for given addresses in a project,
 *     with the same words the project home uses.
 *
 * Nothing here adds a source: quick add travels the same TABDUMP_IMPORT
 * delivery as the popup, into the one ingestion pipeline.
 */
export type QuickAddInfo = { shortcut: string }

export type SourceStatusAnswer = { url: string; status: ResourceStatus; detail?: string }

/** What a project holds for each address: the source's status and, in words, why or how much. Addresses that are not sources are left out. */
export function sourceStatusesFor(workspace: Pick<Workspace, "tabs"> | undefined, urls: readonly unknown[]): SourceStatusAnswer[] {
  if (!workspace) return []
  const byKey = new Map<string, Workspace["tabs"][number]>()
  for (const tab of workspace.tabs) {
    if (!tab.resource) continue
    const key = resourceKey(tab.url)
    if (key && !byKey.has(key)) byKey.set(key, tab)
  }
  const answers: SourceStatusAnswer[] = []
  for (const url of urls.slice(0, 50)) {
    if (typeof url !== "string") continue
    const key = resourceKey(url)
    const resource = key ? byKey.get(key)?.resource : undefined
    if (!resource) continue
    const detail = resource.status === "ready" ? contentLine(resource) : resource.status === "partial" || resource.status === "failed" ? resource.error?.message : undefined
    answers.push({ url, status: resource.status, ...(detail ? { detail } : {}) })
  }
  return answers
}

type ProjectRef = { id: string; name: string }

/**
 * Tells the extension which project is open. `visible` says the person is
 * looking at it — which is what makes it the current project even after a
 * popup pick; a hidden tab (one the extension opened in the background) only
 * counts when it names a different project.
 */
function reportProject(signature: string) {
  const [focusId, projects] = JSON.parse(signature) as [string | null, ProjectRef[]]
  if (!focusId) return
  window.postMessage(
    { source: BROWSER_MESSAGE_SOURCE, type: MSG_PROJECT_FOCUS, payload: { focus: { id: focusId }, projects, visible: document.visibilityState === "visible" } },
    window.location.origin
  )
}

export function useExtensionQuickAdd(options: { workspaces: readonly Workspace[] | undefined; currentWorkspaceId: string | undefined }): QuickAddInfo | undefined {
  const [info, setInfo] = useState<QuickAddInfo>()
  const workspacesRef = useRef(options.workspaces)
  // eslint-disable-next-line react-hooks/refs
  workspacesRef.current = options.workspaces

  const projects: ProjectRef[] = (options.workspaces ?? []).map((workspace) => ({ id: workspace.id, name: workspace.name }))
  // A primitive dependency: the report goes out when the open project or any name changes, not on every store write.
  const signature = JSON.stringify([options.currentWorkspaceId ?? null, projects])
  const signatureRef = useRef(signature)
  // eslint-disable-next-line react-hooks/refs
  signatureRef.current = signature

  useEffect(() => {
    const report = () => reportProject(signatureRef.current)
    // Coming back to Hubble makes the project on screen the current one again.
    const onVisible = () => {
      if (document.visibilityState === "visible") report()
    }

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== window) return
      const data = event.data as { source?: unknown; type?: unknown; payload?: Record<string, unknown> } | null
      if (!data || data.source !== BROWSER_MESSAGE_SOURCE) return

      // The content script just attached (an injected repair, or a page that loaded first): tell it again.
      if (data.type === MSG_EXTENSION_PONG && data.payload?.requestId === null) report()

      if (data.type === MSG_QUICK_ADD_INFO) {
        const shortcut = typeof data.payload?.shortcut === "string" ? data.payload.shortcut.slice(0, 40) : ""
        setInfo((previous) => (previous?.shortcut === shortcut ? previous : { shortcut }))
      }

      if (data.type === MSG_SOURCE_STATUS) {
        const requestId = data.payload?.requestId
        const workspaceId = data.payload?.workspaceId
        const urls = data.payload?.urls
        if (typeof requestId !== "string" || typeof workspaceId !== "string" || !Array.isArray(urls)) return
        const workspace = workspacesRef.current?.find((entry) => entry.id === workspaceId)
        window.postMessage(
          { source: BROWSER_MESSAGE_SOURCE, type: MSG_SOURCE_STATUS_RESULT, payload: { requestId, statuses: sourceStatusesFor(workspace, urls) } },
          window.location.origin
        )
      }
    }

    window.addEventListener("message", handleMessage)
    window.addEventListener("focus", report)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("message", handleMessage)
      window.removeEventListener("focus", report)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  useEffect(() => reportProject(signature), [signature])

  return info
}
