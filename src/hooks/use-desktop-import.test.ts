import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useDesktopImport, type DesktopImportBridge } from "./use-desktop-import"

function pending(requestId: string, tabs = 2, expiresInMs = 180_000) {
  return { requestId, tabs: Array.from({ length: tabs }, (_, i) => ({ url: `https://example.com/${requestId}/${i}` })), received: tabs, rejected: 0, expiresInMs }
}

/** Rust's half, in memory: a queue, an event, and the answers it was given. */
function fakeBridge(initial: unknown[] = []) {
  let waiting = [...initial]
  let notify: (() => void) | undefined
  const finished: { requestId: string; outcome: unknown }[] = []
  const bridge: DesktopImportBridge = {
    take: vi.fn(async () => waiting),
    finish: vi.fn(async (requestId, outcome) => {
      finished.push({ requestId, outcome })
      waiting = waiting.filter((entry) => (entry as { requestId: string }).requestId !== requestId)
    }),
    onRequested: vi.fn(async (handler) => {
      notify = handler
      return () => (notify = undefined)
    }),
  }
  return {
    bridge,
    finished,
    arrive(entry: unknown) {
      waiting.push(entry)
      notify?.()
    },
  }
}

afterEach(() => vi.useRealTimers())

describe("useDesktopImport", () => {
  it("does nothing on the web", () => {
    const { result } = renderHook(() => useDesktopImport(undefined, true))
    expect(result.current.current).toBeUndefined()
  })

  it("holds a batch that arrived during start-up until the app can take it", async () => {
    const fake = fakeBridge([pending("req-startup1")])
    const { result, rerender } = renderHook(({ ready }) => useDesktopImport(fake.bridge, ready), { initialProps: { ready: false } })
    expect(fake.bridge.take).not.toHaveBeenCalled()
    rerender({ ready: true })
    await waitFor(() => expect(result.current.current?.requestId).toBe("req-startup1"))
  })

  it("picks up batches that arrive later, oldest first, each once", async () => {
    const fake = fakeBridge()
    const { result } = renderHook(() => useDesktopImport(fake.bridge, true))
    await waitFor(() => expect(fake.bridge.onRequested).toHaveBeenCalled())
    act(() => fake.arrive(pending("req-first001")))
    act(() => fake.arrive(pending("req-second01")))
    await waitFor(() => expect(result.current.waiting).toBe(2))
    expect(result.current.current?.requestId).toBe("req-first001")

    act(() => result.current.answer("req-first001", { status: "done", project: "Research", added: 2, duplicates: 0, failed: 0 }))
    expect(result.current.current?.requestId).toBe("req-second01")
    act(() => result.current.answer("req-second01", { status: "cancelled", added: 0, duplicates: 0, failed: 0 }))
    expect(result.current.current).toBeUndefined()
    expect(fake.finished.map((entry) => entry.requestId)).toEqual(["req-first001", "req-second01"])
  })

  it("answers a batch with nothing usable in it at once, rather than showing an empty choice", async () => {
    const fake = fakeBridge([{ requestId: "req-empty001", tabs: [{ url: "file:///etc/passwd" }], received: 1, rejected: 0, expiresInMs: 1000 }])
    const { result } = renderHook(() => useDesktopImport(fake.bridge, true))
    await waitFor(() => expect(fake.finished).toHaveLength(1))
    expect(fake.finished[0]).toEqual({ requestId: "req-empty001", outcome: { status: "failed", added: 0, duplicates: 0, failed: 1 } })
    expect(result.current.current).toBeUndefined()
  })

  it("queues a conversation beside batches of tabs, read the way a capture on the web is", async () => {
    const conversation = {
      kind: "conversation",
      requestId: "req-convo001",
      provider: "claude",
      url: "https://claude.ai/chat/0a1b2c3d-4e5f-6789-abcd-ef0123456789",
      title: "Essay outline",
      turns: [
        { role: "user", text: "Outline my essay" },
        { role: "assistant", text: "1. Intro" },
      ],
      truncated: false,
      expiresInMs: 180_000,
    }
    const fake = fakeBridge([pending("req-tabs0001"), conversation])
    const { result } = renderHook(() => useDesktopImport(fake.bridge, true))
    await waitFor(() => expect(result.current.waiting).toBe(2))
    act(() => result.current.answer("req-tabs0001", { status: "cancelled", added: 0, duplicates: 0, failed: 0 }))
    const current = result.current.current
    expect(current?.kind).toBe("conversation")
    expect(current?.kind === "conversation" && current.conversation).toMatchObject({ provider: "claude", title: "Essay outline", method: "page" })
    act(() => result.current.answer("req-convo001", { status: "done", project: "English", saved: "added", turns: 2, truncated: false }))
    expect(fake.finished[1]).toEqual({ requestId: "req-convo001", outcome: { status: "done", project: "English", saved: "added", turns: 2, truncated: false } })
  })

  it("saves a conversation through the shell's save and answers Rust with what it did", async () => {
    const entry = {
      kind: "conversation",
      requestId: "req-convo003",
      url: "https://gemini.google.com/app/abc123def456",
      title: "Cell biology",
      turns: [{ role: "user", text: "What is a ribosome?" }],
      truncated: true,
      expiresInMs: 180_000,
    }
    const fake = fakeBridge([entry])
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "project-missing" })
      .mockResolvedValueOnce({ ok: true, outcome: "updated", title: "Cell biology" })
    const { result } = renderHook(() => useDesktopImport(fake.bridge, true, undefined, save))
    await waitFor(() => expect(result.current.current?.requestId).toBe("req-convo003"))
    const request = result.current.current
    if (request?.kind !== "conversation") throw new Error("not a conversation")

    // A project that vanished is not an answer: the person chooses again.
    await act(async () => expect(await result.current.saveCapture(request, "ws-gone", "Gone")).toEqual({ ok: false, reason: "project-missing" }))
    expect(fake.finished).toHaveLength(0)
    expect(result.current.current?.requestId).toBe("req-convo003")

    await act(async () => expect(await result.current.saveCapture(request, "ws-bio", "Biology")).toMatchObject({ ok: true, outcome: "updated" }))
    expect(save).toHaveBeenLastCalledWith("ws-bio", expect.objectContaining({ provider: "gemini", method: "page" }), true)
    expect(fake.finished).toEqual([{ requestId: "req-convo003", outcome: { status: "done", project: "Biology", saved: "updated", turns: 1, truncated: true } }])
    expect(result.current.current).toBeUndefined()
  })

  it("answers a conversation that isn't one at once, and never shows it", async () => {
    const fake = fakeBridge([{ kind: "conversation", requestId: "req-convo002", provider: "chatgpt", url: "https://example.com/c/1", turns: [{ role: "user", text: "Hi" }], expiresInMs: 1000 }])
    const { result } = renderHook(() => useDesktopImport(fake.bridge, true))
    await waitFor(() => expect(fake.finished).toHaveLength(1))
    expect(fake.finished[0]).toEqual({ requestId: "req-convo002", outcome: { status: "failed", added: 0, duplicates: 0, failed: 0 } })
    expect(result.current.current).toBeUndefined()
  })

  it("lets a batch go before Rust stops waiting for it, so it can't be added after Chrome was told it wasn't", async () => {
    const fake = fakeBridge([pending("req-expires1", 1, 5000)])
    const onExpire = vi.fn()
    const { result } = renderHook(() => useDesktopImport(fake.bridge, true, onExpire))
    await waitFor(() => expect(result.current.current?.requestId).toBe("req-expires1"))
    await waitFor(() => expect(result.current.current).toBeUndefined(), { timeout: 5000 })
    expect(onExpire).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req-expires1" }))
    expect(fake.finished).toHaveLength(0)
  })

  it("stops listening when unmounted", async () => {
    const fake = fakeBridge()
    const { unmount } = renderHook(() => useDesktopImport(fake.bridge, true))
    await waitFor(() => expect(fake.bridge.onRequested).toHaveBeenCalled())
    unmount()
    act(() => fake.arrive(pending("req-late0001")))
    expect(fake.bridge.take).toHaveBeenCalledTimes(1)
  })
})
