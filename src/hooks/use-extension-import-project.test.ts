import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useExtensionImport } from "./use-extension-import"
import { useExtensionWorkspaceQuery } from "./use-extension-workspace-query"

/** "Add to project" from the extension (Hubble 2.0), on the page's side. */

function post(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin, source: window }))
}

function acks(): unknown[] {
  const seen: unknown[] = []
  const listener = (event: MessageEvent) => {
    if ((event.data as { type?: string })?.type === "TABDUMP_IMPORT_ACK") seen.push(event.data.payload)
  }
  window.addEventListener("message", listener)
  return seen
}

describe("useExtensionImport with a project target", () => {
  it("hands a well-formed target to the importer and acks added and duplicate counts", async () => {
    const onImport = vi.fn(() => ({ accepted: 2, duplicates: 1 }))
    const seen = acks()
    renderHook(() => useExtensionImport(onImport))
    post({
      source: "tabdump-extension",
      type: "TABDUMP_IMPORT",
      payload: { importId: "imp-p1", tabs: [{ url: "https://a.example" }, { url: "https://b.example" }, { url: "https://c.example" }], target: { workspaceId: "ws-history", as: "sources" } },
    })
    expect(onImport).toHaveBeenCalledWith(expect.any(Array), { workspaceId: "ws-history", as: "sources" })
    await vi.waitFor(() => expect(seen).toContainEqual({ importId: "imp-p1", accepted: 2, duplicates: 1 }))
  })

  it("treats a malformed target as an ordinary dump, never as a project", () => {
    const onImport = vi.fn(() => 1)
    renderHook(() => useExtensionImport(onImport))
    for (const target of [{ workspaceId: "ws", as: "admin" }, { as: "sources" }, "ws-history", { workspaceId: "", as: "sources" }]) {
      onImport.mockClear()
      post({ source: "tabdump-extension", type: "TABDUMP_IMPORT", payload: { importId: `imp-${JSON.stringify(target)}`, tabs: [{ url: "https://a.example" }], target } })
      expect(onImport).toHaveBeenCalledWith([{ url: "https://a.example" }])
    }
  })
})

describe("useExtensionWorkspaceQuery with projects", () => {
  it("lists the projects for the popup's choice — ids, names and source counts only", async () => {
    const replies: unknown[] = []
    window.addEventListener("message", (event) => {
      if ((event.data as { type?: string })?.type === "TABDUMP_CHECK_IMPORTED_RESULT") replies.push(event.data.payload)
    })
    renderHook(() => useExtensionWorkspaceQuery([], [{ id: "ws-history", name: "History IA", sources: 5 }]))
    post({ source: "tabdump-extension", type: "TABDUMP_CHECK_IMPORTED", payload: { requestId: "r1", urls: [] } })
    await vi.waitFor(() =>
      expect(replies).toContainEqual({ requestId: "r1", existingUrls: [], projects: [{ id: "ws-history", name: "History IA", sources: 5 }] })
    )
  })
})
