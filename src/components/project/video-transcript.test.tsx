import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { lineAt, VideoTranscript } from "./video-transcript"
import { EXTRACTION_ERRORS } from "@/lib/resources/extraction"
import type { ResourceContent, TabResource } from "@/lib/resources/types"
import type { Tab } from "@/lib/tabs/types"

const ID = "dQw4w9WgXcQ"

const tab: Tab = { id: "t1", url: `https://www.youtube.com/watch?v=${ID}&t=30`, title: "Physics revision", domain: "youtube.com", createdAt: 1, updatedAt: 1, source: "manual" } as unknown as Tab

const readyResource: TabResource = { kind: "youtube", origin: "manual", status: "ready", addedAt: 1, updatedAt: 1, meta: { siteName: "YouTube", author: "Physics Online" }, content: { chars: 100, transcriptLines: 4, extractedAt: 5 } }

const content: ResourceContent = {
  kind: "youtube",
  extractedAt: 5,
  transcriptInfo: { source: "captions", language: "en" },
  transcript: [
    { start: 0, end: 4, text: "Welcome back to physics revision." },
    { start: 4, end: 9, text: "Today: energy stores." },
    { start: 522, end: 526, text: "Gravitational potential energy is the energy an object has" },
    { start: 526, end: 530, text: "because of its height. <script>alert(1)</script>" },
  ],
}

function renderReader(overrides: Partial<Parameters<typeof VideoTranscript>[0]> = {}) {
  const props = { tab, resource: readyResource, content, embeddable: true, onOpenAt: vi.fn(), onRetry: vi.fn(), ...overrides }
  const view = render(<VideoTranscript {...props} />)
  return { ...props, ...view }
}

describe("VideoTranscript states", () => {
  it("says it is getting the transcript while extraction runs", () => {
    renderReader({ resource: { ...readyResource, status: "processing", content: undefined }, content: null })
    expect(screen.getByRole("status").textContent).toContain("Getting the transcript")
    expect(screen.queryByRole("list", { name: "Transcript lines" })).toBeNull()
  })

  it("says it is loading while the device reads the stored transcript", () => {
    renderReader({ content: undefined })
    expect(screen.getByRole("status").textContent).toContain("Loading the transcript")
  })

  it("shows every line with its time, in one format", () => {
    renderReader()
    const lines = within(screen.getByRole("list", { name: "Transcript lines" })).getAllByRole("listitem")
    expect(lines).toHaveLength(4)
    expect(lines.map((line) => line.textContent?.slice(0, 4))).toEqual(["0:00", "0:04", "8:42", "8:46"])
    expect(screen.getByText("English captions")).toBeTruthy()
  })

  it("renders transcript text as text, never markup", () => {
    const { container } = renderReader()
    expect(container.querySelector("script")).toBeNull()
    expect(screen.getByText(/because of its height\. <script>alert\(1\)<\/script>/)).toBeTruthy()
  })

  it("explains an unavailable transcript, with no retry when a retry can't help", () => {
    const onRetry = vi.fn()
    renderReader({ resource: { ...readyResource, status: "partial", content: undefined, error: EXTRACTION_ERRORS.transcript_unavailable }, content: null, onRetry })
    expect(screen.getByText(EXTRACTION_ERRORS.transcript_unavailable.message)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull()
    // The video still plays and opens normally.
    expect(screen.getByRole("button", { name: "Play video" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Open on YouTube/ })).toBeTruthy()
  })

  it("offers Try again for a failure a retry could fix", async () => {
    const onRetry = vi.fn()
    renderReader({ resource: { ...readyResource, status: "partial", content: undefined, error: EXTRACTION_ERRORS.transcript_busy }, content: null, onRetry })
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("says so when a ready transcript is missing from this device", () => {
    renderReader({ content: null })
    expect(screen.getByText(/isn't on this device any more/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Get it again/ })).toBeTruthy()
  })
})

describe("VideoTranscript states — transcripts read from YouTube's page through Chrome", () => {
  const waiting = (error: (typeof EXTRACTION_ERRORS)[keyof typeof EXTRACTION_ERRORS]) => ({ ...readyResource, status: "partial" as const, content: undefined, error })
  const stateOf = (container: HTMLElement) => container.querySelector("[data-transcript-state]")?.getAttribute("data-transcript-state")

  it("is unavailable — no retry — when YouTube has no transcript, or won't show the video", () => {
    for (const error of [EXTRACTION_ERRORS.transcript_unavailable, EXTRACTION_ERRORS.video_unavailable]) {
      const { container, unmount } = renderReader({ resource: waiting(error), content: null })
      expect(stateOf(container)).toBe("unavailable")
      expect(screen.queryByRole("button", { name: /Try again|Allow in Chrome/ })).toBeNull()
      unmount()
    }
  })

  it("is failed, with Try again, when a read went wrong", async () => {
    for (const error of [EXTRACTION_ERRORS.transcript_read_failed, EXTRACTION_ERRORS.transcript_timeout]) {
      const onRetry = vi.fn()
      const { container, unmount } = renderReader({ resource: waiting(error), content: null, onRetry })
      expect(stateOf(container)).toBe("failed")
      expect(screen.getByText(error.message)).toBeTruthy()
      await userEvent.click(screen.getByRole("button", { name: /Try again/ }))
      expect(onRetry).toHaveBeenCalledTimes(1)
      unmount()
    }
  })

  it("asks to connect Hubble for Chrome (a step, not an error), and can try again", async () => {
    const onRetry = vi.fn()
    const { container } = renderReader({ resource: waiting(EXTRACTION_ERRORS.transcript_needs_extension), content: null, onRetry })
    expect(stateOf(container)).toBe("needs-chrome")
    expect(container.querySelector(".text-destructive")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("offers Allow in Chrome when the extension may not read youtube.com yet", async () => {
    let answer!: (value: { granted: boolean }) => void
    const onAllowYouTube = vi.fn(() => new Promise<{ granted: boolean }>((resolve) => (answer = resolve)))
    const { container } = renderReader({ resource: waiting(EXTRACTION_ERRORS.transcript_needs_access), content: null, onAllowYouTube })
    expect(stateOf(container)).toBe("needs-chrome")
    await userEvent.click(screen.getByRole("button", { name: /Allow in Chrome/ }))
    expect(onAllowYouTube).toHaveBeenCalledTimes(1)
    expect((screen.getByRole("button", { name: /Waiting for Chrome/ }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => answer({ granted: false }))
    expect(screen.getByText(/Chrome didn't allow it/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Allow in Chrome/ })).toBeTruthy()
  })

  it("says when Hubble for Chrome didn't answer the Allow request", async () => {
    const onAllowYouTube = vi.fn(async () => ({ granted: false as const, reason: "no_answer" as const }))
    renderReader({ resource: waiting(EXTRACTION_ERRORS.transcript_needs_access), content: null, onAllowYouTube })
    await userEvent.click(screen.getByRole("button", { name: /Allow in Chrome/ }))
    expect(screen.getByText(/didn't answer — open Chrome/)).toBeTruthy()
  })

  it("without a way to ask (no Allow action given), falls back to Try again", () => {
    renderReader({ resource: waiting(EXTRACTION_ERRORS.transcript_needs_access), content: null })
    expect(screen.queryByRole("button", { name: /Allow in Chrome/ })).toBeNull()
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy()
  })
})

describe("searching the transcript", () => {
  it("finds a phrase across lines, ignoring case, and marks the words", async () => {
    renderReader()
    await userEvent.type(screen.getByRole("textbox", { name: "Search the transcript" }), "POTENTIAL energy")
    expect(screen.getByRole("status").textContent).toBe("1 moment")
    const moments = within(screen.getByRole("list", { name: "Matching moments" })).getAllByRole("listitem")
    expect(moments).toHaveLength(1)
    expect(moments[0]!.textContent).toMatch(/^8:42/)
    expect([...moments[0]!.querySelectorAll("mark")].map((mark) => mark.textContent?.toLowerCase())).toEqual(expect.arrayContaining(["potential", "energy"]))
  })

  it("says when something is not said", async () => {
    renderReader()
    await userEvent.type(screen.getByRole("textbox", { name: "Search the transcript" }), "photosynthesis")
    expect(screen.getByRole("status").textContent).toBe("Not said")
  })
})

describe("jumping to a moment", () => {
  it("starts the player at the clicked time — not the saved link's start", async () => {
    renderReader()
    await userEvent.click(screen.getByRole("button", { name: "Play from 8:42" }))
    const frame = screen.getByTitle(/YouTube player/) as HTMLIFrameElement
    const src = new URL(frame.src)
    expect(src.origin).toBe("https://www.youtube-nocookie.com")
    expect(src.pathname).toBe(`/embed/${ID}`)
    expect(src.searchParams.get("start")).toBe("522")
    expect(src.searchParams.get("enablejsapi")).toBe("1")
  })

  it("Play starts at the saved link's own time", async () => {
    renderReader()
    await userEvent.click(screen.getByRole("button", { name: "Play video" }))
    expect(new URL((screen.getByTitle(/YouTube player/) as HTMLIFrameElement).src).searchParams.get("start")).toBe("30")
  })

  it("seeks a loaded player through its messaging API, and marks the line", async () => {
    renderReader()
    await userEvent.click(screen.getByRole("button", { name: "Play video" }))
    const frame = screen.getByTitle(/YouTube player/) as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, "postMessage")
    fireEvent.load(frame)
    await userEvent.click(screen.getByRole("button", { name: "Play from 8:42" }))
    const sent = post.mock.calls.map(([message, origin]) => [JSON.parse(message as string), origin])
    expect(sent).toContainEqual([{ event: "command", func: "seekTo", args: [522, true] }, "https://www.youtube-nocookie.com"])
    expect(screen.getByText(/^Gravitational potential energy is/).closest("li")?.getAttribute("aria-current")).toBe("true")
    expect(screen.getByRole("button", { name: "Open on YouTube at 8:42" })).toBeTruthy()
  })

  it("follows the playing line from the player — and ignores messages from anywhere else", async () => {
    renderReader()
    await userEvent.click(screen.getByRole("button", { name: "Play video" }))
    const frame = screen.getByTitle(/YouTube player/) as HTMLIFrameElement
    const current = () => document.querySelector('[aria-current="true"]')?.getAttribute("data-line")
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", source: frame.contentWindow, data: JSON.stringify({ event: "infoDelivery", info: { currentTime: 5 } }) }))
    })
    expect(current()).toBeUndefined()
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: "https://www.youtube-nocookie.com", source: frame.contentWindow, data: JSON.stringify({ event: "infoDelivery", info: { currentTime: 527 } }) }))
    })
    expect(current()).toBe("3")
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: "https://www.youtube-nocookie.com", source: frame.contentWindow, data: "{not json" }))
    })
    expect(current()).toBe("3")
  })

  it("without a player (the desktop app), opens YouTube at the moment", async () => {
    const onOpenAt = vi.fn()
    renderReader({ embeddable: false, onOpenAt })
    expect(screen.queryByRole("button", { name: "Play video" })).toBeNull()
    expect(document.querySelector("img")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Play from 8:42" }))
    expect(onOpenAt).toHaveBeenCalledWith(`https://www.youtube.com/watch?v=${ID}&t=522s`)
  })

  it("selecting text to copy does not seek", async () => {
    const onOpenAt = vi.fn()
    renderReader({ embeddable: false, onOpenAt })
    const spy = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "potential energy" } as Selection)
    fireEvent.click(screen.getByText(/^Gravitational potential energy is/))
    expect(onOpenAt).not.toHaveBeenCalled()
    spy.mockRestore()
    fireEvent.click(screen.getByText(/^Gravitational potential energy is/))
    expect(onOpenAt).toHaveBeenCalledWith(`https://www.youtube.com/watch?v=${ID}&t=522s`)
  })

  it("opens at a moment from search: that line is marked", () => {
    renderReader({ seek: { line: 2, seconds: 522, nonce: 1 } })
    expect(document.querySelector('[aria-current="true"]')?.getAttribute("data-line")).toBe("2")
    expect(screen.getByRole("button", { name: "Open on YouTube at 8:42" })).toBeTruthy()
  })
})

describe("lineAt", () => {
  it("is the last line that has started", () => {
    const lines = content.transcript!
    expect(lineAt(lines, 0)).toBe(0)
    expect(lineAt(lines, 100)).toBe(1)
    expect(lineAt(lines, 522)).toBe(2)
    expect(lineAt(lines, 9999)).toBe(3)
    expect(lineAt([{ start: 5, text: "x" }], 1)).toBeUndefined()
  })
})
