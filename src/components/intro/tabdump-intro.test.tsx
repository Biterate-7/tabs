import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { TabDumpIntro } from "./tabdump-intro"
import { shouldPlayIntro, prefersReducedMotion, isMobileViewport } from "@/lib/intro"

vi.mock("@/lib/intro", () => ({
  shouldPlayIntro: vi.fn(),
  prefersReducedMotion: vi.fn(),
  isMobileViewport: vi.fn(),
}))

function setDecision({ play, reduced = false, mobile = false }: { play: boolean; reduced?: boolean; mobile?: boolean }) {
  vi.mocked(shouldPlayIntro).mockReturnValue(play)
  vi.mocked(prefersReducedMotion).mockReturnValue(reduced)
  vi.mocked(isMobileViewport).mockReturnValue(mobile)
}

function overlay() {
  return document.querySelector("[data-intro-phase]")
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("TabDumpIntro", () => {
  it("skips straight to the real page when the setting is off", () => {
    setDecision({ play: false })
    render(
      <TabDumpIntro>
        <div>Real landing page</div>
      </TabDumpIntro>
    )

    expect(overlay()).toBeNull()
    expect(screen.queryByRole("button", { name: "Skip intro →" })).toBeNull()
    expect(screen.getByText("Real landing page")).toBeTruthy()
  })

  it("plays the full cinematic sequence through every phase to done, then reveals the page", () => {
    setDecision({ play: true })
    render(
      <TabDumpIntro>
        <div>Real landing page</div>
      </TabDumpIntro>
    )

    expect(overlay()?.getAttribute("data-intro-phase")).toBe("title")

    act(() => vi.advanceTimersByTime(600))
    expect(overlay()?.getAttribute("data-intro-phase")).toBe("chaos")

    act(() => vi.advanceTimersByTime(2000))
    expect(overlay()?.getAttribute("data-intro-phase")).toBe("converge")

    act(() => vi.advanceTimersByTime(1000))
    expect(overlay()?.getAttribute("data-intro-phase")).toBe("machine")

    act(() => vi.advanceTimersByTime(1700))
    expect(overlay()?.getAttribute("data-intro-phase")).toBe("organized")

    act(() => vi.advanceTimersByTime(1700))
    expect(overlay()?.getAttribute("data-intro-phase")).toBe("graph")

    act(() => vi.advanceTimersByTime(1400))
    expect(overlay()?.getAttribute("data-intro-phase")).toBe("exit")

    act(() => vi.advanceTimersByTime(700))
    expect(overlay()).toBeNull()
    expect(screen.getByText("Real landing page")).toBeTruthy()
  })

  it("skip stops the timeline immediately, cancels every pending timer, and still reveals the page", () => {
    setDecision({ play: true })
    render(
      <TabDumpIntro>
        <div>Real landing page</div>
      </TabDumpIntro>
    )

    act(() => vi.advanceTimersByTime(600)) // now mid-"chaos"
    expect(overlay()?.getAttribute("data-intro-phase")).toBe("chaos")

    const pendingBeforeSkip = vi.getTimerCount()
    expect(pendingBeforeSkip).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("button", { name: "Skip intro →" }))
    expect(overlay()?.getAttribute("data-intro-phase")).toBe("exit")
    // Skip tears down every previously-scheduled phase/sound timer and
    // replaces them with exactly one (the skip-exit -> done timer).
    expect(vi.getTimerCount()).toBe(1)

    act(() => vi.advanceTimersByTime(200))
    expect(overlay()).toBeNull()
    expect(screen.getByText("Real landing page")).toBeTruthy()
  })

  it("uses the short reduced-motion sequence and never throws with audio unavailable", () => {
    setDecision({ play: true, reduced: true })
    render(
      <TabDumpIntro>
        <div>Real landing page</div>
      </TabDumpIntro>
    )

    expect(overlay()?.getAttribute("data-intro-phase")).toBe("title")
    act(() => vi.advanceTimersByTime(1300))
    expect(overlay()).toBeNull()
    expect(screen.getByText("Real landing page")).toBeTruthy()
  })

  it("clears every pending timer on unmount and never touches state afterward", () => {
    setDecision({ play: true })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { unmount } = render(
      <TabDumpIntro>
        <div>Real landing page</div>
      </TabDumpIntro>
    )

    act(() => vi.advanceTimersByTime(600)) // mid-"chaos", several timers pending
    unmount()
    expect(vi.getTimerCount()).toBe(0)

    // Nothing left to fire, but advancing time must not throw or log a
    // "state update on an unmounted component" warning.
    act(() => vi.advanceTimersByTime(10_000))
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("plays without throwing even when window.AudioContext construction throws", () => {
    const OriginalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext
    ;(window as unknown as { AudioContext: unknown }).AudioContext = class {
      constructor() {
        throw new Error("blocked")
      }
    }

    setDecision({ play: true })
    render(
      <TabDumpIntro>
        <div>Real landing page</div>
      </TabDumpIntro>
    )

    expect(() => act(() => vi.advanceTimersByTime(8600))).not.toThrow()
    expect(screen.getByText("Real landing page")).toBeTruthy()

    ;(window as unknown as { AudioContext: unknown }).AudioContext = OriginalAudioContext
  })

  it("never constructs an AudioContext when the intro isn't playing", () => {
    const audioCtorSpy = vi.fn()
    const OriginalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext
    ;(window as unknown as { AudioContext: unknown }).AudioContext = class {
      constructor() {
        audioCtorSpy()
      }
    }

    setDecision({ play: false })
    render(
      <TabDumpIntro>
        <div>Real landing page</div>
      </TabDumpIntro>
    )

    expect(audioCtorSpy).not.toHaveBeenCalled()
    ;(window as unknown as { AudioContext: unknown }).AudioContext = OriginalAudioContext
  })

  it("replays in full on every mount — nothing persists a completed play across instances", () => {
    setDecision({ play: true })
    const { unmount } = render(
      <TabDumpIntro>
        <div>Real landing page</div>
      </TabDumpIntro>
    )
    act(() => vi.advanceTimersByTime(8600))
    expect(overlay()).toBeNull()
    unmount()

    // shouldPlayIntro is the only thing TabDumpIntro consults, and this test
    // never changes what it returns — a fresh mount (a reload, a new tab)
    // must play the full sequence again, exactly like the first mount did.
    render(
      <TabDumpIntro>
        <div>Real landing page</div>
      </TabDumpIntro>
    )
    expect(overlay()?.getAttribute("data-intro-phase")).toBe("title")
  })
})
