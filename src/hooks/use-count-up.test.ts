import { describe, expect, it, vi, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useCountUp } from "./use-count-up"

describe("useCountUp", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts at 0 and animates toward the target over time", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ target }) => useCountUp(target), {
      initialProps: { target: 100 },
    })
    expect(result.current).toBe(0)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    rerender({ target: 100 })
    expect(result.current).toBe(100)
  })

  it("does not re-animate when the target is unchanged across renders", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ target }) => useCountUp(target), {
      initialProps: { target: 5 },
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    rerender({ target: 5 })
    expect(result.current).toBe(5)
  })
})
