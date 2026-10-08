import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { sourceStatusesFor, useExtensionQuickAdd } from "./use-extension-quick-add"
import { useExtensionImport } from "./use-extension-import"
import { ingestResources } from "@/lib/resources/ingest"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

/** Quick add (Hubble 2.0), on the page's side: which project is open, the shortcut back, and reading progress. */

const NOW = 1_800_000_000_000

function store(): WorkspaceStore {
  let next: WorkspaceStore = {
    version: 1,
    currentId: "ws-history",
    workspaces: [
      { id: "ws-history", name: "History IA", tabs: [], sections: [], createdAt: 1, updatedAt: 1 },
      { id: "ws-physics", name: "Physics EE", tabs: [], sections: [], createdAt: 1, updatedAt: 1 },
    ],
  }
  next = ingestResources(next, "ws-history", [{ url: "https://www.britannica.com/event/Cuban-missile-crisis" }, { url: "https://example.com/paper.pdf" }], "extension", NOW)!.store
  return next
}

function withStatus(workspace: Workspace, url: string, resource: Partial<NonNullable<Workspace["tabs"][number]["resource"]>>): Workspace {
  return { ...workspace, tabs: workspace.tabs.map((tab) => (tab.url === url ? { ...tab, resource: { ...tab.resource!, ...resource } } : tab)) }
}

function post(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin, source: window }))
}

function collect(type: string): unknown[] {
  const seen: unknown[] = []
  const listener = (event: MessageEvent) => {
    if ((event.data as { type?: string })?.type === type) seen.push(event.data.payload)
  }
  window.addEventListener("message", listener)
  cleanups.push(() => window.removeEventListener("message", listener))
  return seen
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("sourceStatusesFor", () => {
  it("answers in the project home's words, matching addresses the way duplicate detection does", () => {
    let workspace = store().workspaces[0]!
    workspace = withStatus(workspace, "https://www.britannica.com/event/Cuban-missile-crisis", { status: "ready", content: { chars: 11_040, extractedAt: NOW } })
    workspace = withStatus(workspace, "https://example.com/paper.pdf", { status: "partial", error: { code: "pdf_needs_file", message: "PDF detected. Hubble needs the file itself.", retryable: false } })
    expect(
      sourceStatusesFor(workspace, ["http://britannica.com/event/Cuban-missile-crisis/?utm_source=x", "https://example.com/paper.pdf", "https://not-a-source.example/"])
    ).toEqual([
      { url: "http://britannica.com/event/Cuban-missile-crisis/?utm_source=x", status: "ready", detail: "1,840 words" },
      { url: "https://example.com/paper.pdf", status: "partial", detail: "PDF detected. Hubble needs the file itself." },
    ])
  })

  it("says nothing about a project it doesn't have, or about junk", () => {
    expect(sourceStatusesFor(undefined, ["https://example.com/paper.pdf"])).toEqual([])
    expect(sourceStatusesFor(store().workspaces[0], [7, null, "not a url"])).toEqual([])
  })
})

describe("useExtensionQuickAdd", () => {
  it("reports the open project with every project's id and name, and again when it changes", async () => {
    const reports = collect("TABDUMP_PROJECT_FOCUS")
    const { workspaces } = store()
    const { rerender } = renderHook((props: { current: string }) => useExtensionQuickAdd({ workspaces, currentWorkspaceId: props.current }), { initialProps: { current: "ws-history" } })
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toEqual({
      focus: { id: "ws-history" },
      projects: [{ id: "ws-history", name: "History IA" }, { id: "ws-physics", name: "Physics EE" }],
      visible: document.visibilityState === "visible",
    })
    rerender({ current: "ws-physics" })
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    expect(reports[1]).toMatchObject({ focus: { id: "ws-physics" } })
  })

  it("does not report again for a store write that changes neither the project nor any name", async () => {
    const reports = collect("TABDUMP_PROJECT_FOCUS")
    const first = store().workspaces
    const { rerender } = renderHook((props: { workspaces: Workspace[] }) => useExtensionQuickAdd({ workspaces: props.workspaces, currentWorkspaceId: "ws-history" }), { initialProps: { workspaces: first } })
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    rerender({ workspaces: first.map((workspace) => ({ ...workspace, updatedAt: 99 })) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reports).toHaveLength(1)
  })

  it("reports again when the extension's content script announces itself late", async () => {
    const reports = collect("TABDUMP_PROJECT_FOCUS")
    renderHook(() => useExtensionQuickAdd({ workspaces: store().workspaces, currentWorkspaceId: "ws-history" }))
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    act(() => post({ source: "tabdump-extension", type: "TABDUMP_EXTENSION_PONG", payload: { requestId: null } }))
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    // A pong answering the page's own ping (a requestId) is not a new arrival.
    act(() => post({ source: "tabdump-extension", type: "TABDUMP_EXTENSION_PONG", payload: { requestId: "ping-1" } }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reports).toHaveLength(2)
  })

  it("reports again, as visible, when the person comes back to Hubble", async () => {
    const reports = collect("TABDUMP_PROJECT_FOCUS") as { visible: boolean }[]
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    try {
      renderHook(() => useExtensionQuickAdd({ workspaces: store().workspaces, currentWorkspaceId: "ws-history" }))
      await vi.waitFor(() => expect(reports).toHaveLength(1))
      expect(reports[0]!.visible).toBe(false)
      visibility.mockReturnValue("visible")
      act(() => void document.dispatchEvent(new Event("visibilitychange")))
      await vi.waitFor(() => expect(reports).toHaveLength(2))
      expect(reports[1]!.visible).toBe(true)
    } finally {
      visibility.mockRestore()
    }
  })

  it("learns the shortcut from the extension", () => {
    const { result } = renderHook(() => useExtensionQuickAdd({ workspaces: store().workspaces, currentWorkspaceId: "ws-history" }))
    expect(result.current).toBeUndefined()
    act(() => post({ source: "tabdump-extension", type: "TABDUMP_QUICK_ADD_INFO", payload: { shortcut: "Alt+Shift+H" } }))
    expect(result.current).toEqual({ shortcut: "Alt+Shift+H" })
  })

  it("answers how reading is going for the project the extension names — and only that project", async () => {
    const replies = collect("TABDUMP_SOURCE_STATUS_RESULT")
    renderHook(() => useExtensionQuickAdd({ workspaces: store().workspaces, currentWorkspaceId: "ws-physics" }))
    act(() => post({ source: "tabdump-extension", type: "TABDUMP_SOURCE_STATUS", payload: { requestId: "r1", workspaceId: "ws-history", urls: ["https://example.com/paper.pdf"] } }))
    act(() => post({ source: "tabdump-extension", type: "TABDUMP_SOURCE_STATUS", payload: { requestId: "r2", workspaceId: "ws-physics", urls: ["https://example.com/paper.pdf"] } }))
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies).toContainEqual({ requestId: "r1", statuses: [{ url: "https://example.com/paper.pdf", status: "pending" }] })
    expect(replies).toContainEqual({ requestId: "r2", statuses: [] })
  })

  it("ignores messages from another origin", () => {
    const { result } = renderHook(() => useExtensionQuickAdd({ workspaces: store().workspaces, currentWorkspaceId: "ws-history" }))
    act(() => window.dispatchEvent(new MessageEvent("message", { data: { source: "tabdump-extension", type: "TABDUMP_QUICK_ADD_INFO", payload: { shortcut: "X" } }, origin: "https://evil.example", source: window })))
    expect(result.current).toBeUndefined()
  })
})

describe("a quick add into a project that no longer exists", () => {
  it("is acked as project-missing, so the extension can say so", async () => {
    const acks = collect("TABDUMP_IMPORT_ACK")
    renderHook(() => useExtensionImport(() => ({ accepted: 0, duplicates: 0, projectMissing: true })))
    post({ source: "tabdump-extension", type: "TABDUMP_IMPORT", payload: { importId: "imp-gone", tabs: [{ url: "https://a.example" }], target: { workspaceId: "ws-deleted", as: "sources" } } })
    await vi.waitFor(() => expect(acks).toContainEqual({ importId: "imp-gone", accepted: 0, reason: "project-missing" }))
  })
})
