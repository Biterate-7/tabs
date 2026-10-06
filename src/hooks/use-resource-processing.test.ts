import { afterEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useResourceProcessing } from "./use-resource-processing"
import { ingestResources } from "@/lib/resources/ingest"
import { getContent, putContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import type { ExtractionResponse } from "@/lib/resources/extraction"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * The background reader: every pending source ends ready, partial or failed —
 * never left spinning — written against the store as it is when it finishes.
 */

afterEach(() => {
  resetContentStoreForTests()
  localStorage.clear()
})

function setup(urls: string[], extract: (url: string) => Promise<ExtractionResponse>) {
  let initial: WorkspaceStore = { version: 1, currentId: "w", workspaces: [{ id: "w", name: "History IA", tabs: [], sections: [], createdAt: 1, updatedAt: 1 }] }
  initial = ingestResources(initial, "w", urls.map((url) => ({ url })), "chrome", 1)!.store
  // The app shell's shape: the committed store in a ref (read at write time) and in state (what renders).
  const holder = { store: initial }
  const hook = renderHook(() => {
    const [store, setStore] = useState(initial)
    const replace = (next: WorkspaceStore) => {
      holder.store = next
      setStore(next)
    }
    const actions = useResourceProcessing({
      store,
      getStore: () => holder.store,
      commit: replace,
      enabled: true,
      deps: { extract: ({ url }) => extract(url), putContent, now: () => 5 },
    })
    return { actions, replace }
  })
  return { holder, hook }
}

const tabsOf = (holder: { store: WorkspaceStore }) => holder.store.workspaces[0]!.tabs

describe("useResourceProcessing", () => {
  it("reads pending sources and settles each honestly", async () => {
    const { holder } = setup(["https://a.example/page", "https://b.example/x.pdf", "https://c.example/down"], async (url) =>
      url.endsWith("page")
        ? { ok: true, kind: "webpage", status: "ready", finalUrl: url, title: "A page", meta: {}, content: { text: "Body text" } }
        : url.endsWith(".pdf")
          ? { ok: true, kind: "pdf", status: "partial", finalUrl: url, meta: {}, error: { code: "pdf_needs_file", message: "PDF detected. Hubble needs the file itself to read its contents.", retryable: true } }
          : { ok: false, error: { code: "unreachable", message: "Hubble couldn't reach this page.", retryable: true } }
    )
    await waitFor(() => expect(tabsOf(holder).map((tab) => tab.resource!.status)).toEqual(["ready", "partial", "failed"]))
    expect(tabsOf(holder)[0]!.title).toBe("A page")
    expect((await getContent("w", tabsOf(holder)[0]!.id))?.text).toBe("Body text")
  })

  it("never claims a source that was removed while it was read", async () => {
    let finish: (value: ExtractionResponse) => void = () => undefined
    const { holder, hook } = setup(["https://a.example/slow"], () => new Promise((resolve) => (finish = resolve)))
    await waitFor(() => expect(tabsOf(holder)[0]!.resource!.status).toBe("processing"))
    // The person removes it.
    const removed = { ...holder.store, workspaces: [{ ...holder.store.workspaces[0]!, tabs: [] }] }
    act(() => hook.result.current.replace(removed))
    await act(async () => finish({ ok: true, kind: "webpage", status: "ready", finalUrl: "https://a.example/slow", meta: {}, content: { text: "late" } }))
    expect(tabsOf(holder)).toEqual([])
  })

  it("Retry reads a failed source again", async () => {
    const extract = vi.fn(async (url: string): Promise<ExtractionResponse> => ({ ok: false, error: { code: "timeout", message: "The page took too long to respond.", retryable: true }, url } as never))
    const { holder, hook } = setup(["https://a.example/flaky"], extract)
    await waitFor(() => expect(tabsOf(holder)[0]!.resource!.status).toBe("failed"))
    extract.mockResolvedValueOnce({ ok: true, kind: "webpage", status: "ready", finalUrl: "https://a.example/flaky", meta: {}, content: { text: "ok" } })
    act(() => hook.result.current.actions.retry("w", tabsOf(holder)[0]!.id))
    await waitFor(() => expect(tabsOf(holder)[0]!.resource!.status).toBe("ready"))
  })

  it("gives up on a source interrupted three times instead of waiting forever", async () => {
    const { holder } = setup(["https://a.example/crashy"], () => new Promise(() => undefined))
    await waitFor(() => expect(tabsOf(holder)[0]!.resource!.status).toBe("processing"))
    // As if the page reloaded mid-read three times: back to pending with its attempts spent.
    const tab = tabsOf(holder)[0]!
    expect(tab.resource!.attempts).toBe(1)
  })
})
