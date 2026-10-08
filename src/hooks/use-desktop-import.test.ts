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
