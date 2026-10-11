import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlayCircle, Search } from "lucide-react"
import { CommandPalette } from "./command-palette"
import { useTranscriptSearch } from "@/hooks/use-transcript-search"
import { putContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import type { Command } from "./types"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

/** ⌘K over every subject's videos: what is said, where, and when. */

function videoTab(id: string, title: string, extractedAt: number, lines = 3): Tab {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id.padEnd(11, "x")}`,
    title,
    domain: "youtube.com",
    resource: { kind: "youtube", origin: "manual", status: "ready", addedAt: 1, updatedAt: 1, content: { chars: 10, transcriptLines: lines, extractedAt } },
  } as Tab
}

function workspace(id: string, name: string, tabs: Tab[]): Workspace {
  return { id, name, tabs, sections: [], createdAt: 1, updatedAt: 1 }
}

beforeEach(() => resetContentStoreForTests())

describe("useTranscriptSearch", () => {
  it("finds moments across subjects, and nothing until it is enabled", async () => {
    await putContent("physics", "p1", { kind: "youtube", extractedAt: 1, transcript: [{ start: 522, text: "Gravitational potential energy is mgh." }] })
    await putContent("chem", "c1", { kind: "youtube", extractedAt: 1, transcript: [{ start: 75, text: "Bond energy is released." }] })
    const workspaces = [workspace("physics", "Physics", [videoTab("p1", "Physics revision", 1)]), workspace("chem", "Chemistry", [videoTab("c1", "Energetics", 1)])]

    const { result, rerender } = renderHook(({ enabled }) => useTranscriptSearch(workspaces, enabled), { initialProps: { enabled: false } })
    expect(result.current("energy")).toEqual([])

    rerender({ enabled: true })
    await waitFor(() => expect(result.current("energy")).toHaveLength(2))
    expect(result.current("energy").map((hit) => [hit.workspaceId, hit.location.start]).sort()).toEqual([
      ["chem", 75],
      ["physics", 522],
    ])
    expect(result.current("potential energy")[0]).toMatchObject({ workspaceId: "physics", tabId: "p1", location: { start: 522 } })
  })

  it("never returns a video that has been removed from its subject", async () => {
    await putContent("physics", "p1", { kind: "youtube", extractedAt: 1, transcript: [{ start: 522, text: "Gravitational potential energy." }] })
    const before = [workspace("physics", "Physics", [videoTab("p1", "Physics revision", 1)])]
    const { result, rerender } = renderHook(({ list }) => useTranscriptSearch(list, true), { initialProps: { list: before } })
    await waitFor(() => expect(result.current("gravitational")).toHaveLength(1))
    rerender({ list: [workspace("physics", "Physics", [])] })
    expect(result.current("gravitational")).toEqual([])
  })

  it("picks up a transcript that arrives after the video was added", async () => {
    const pending = { ...videoTab("p1", "Physics revision", 1), resource: { kind: "youtube", origin: "manual", status: "processing", addedAt: 1, updatedAt: 1 } } as Tab
    const { result, rerender } = renderHook(({ list }) => useTranscriptSearch(list, true), { initialProps: { list: [workspace("physics", "Physics", [pending])] } })
    expect(result.current("gravitational")).toEqual([])
    await putContent("physics", "p1", { kind: "youtube", extractedAt: 2, transcript: [{ start: 9, text: "Gravitational fields." }] })
    rerender({ list: [workspace("physics", "Physics", [videoTab("p1", "Physics revision", 2, 1)])] })
    await waitFor(() => expect(result.current("gravitational")).toHaveLength(1))
  })
})

describe("CommandPalette with searchContent", () => {
  const statics: Command[] = [{ id: "go", label: "Go to Home", group: "Navigation", icon: Search, onSelect: vi.fn() }]

  it("shows moments for what is typed, marks the words, and opens the selected one", async () => {
    const onSelect = vi.fn()
    const searchContent = vi.fn((query: string): Command[] =>
      query.toLowerCase().includes("energy")
        ? [{ id: "moment-1", label: "Physics revision", hint: "8:42 · Gravitational potential energy is mgh.", highlight: ["energy"], forceMount: true, group: "Moments", icon: PlayCircle, onSelect }]
        : []
    )
    render(<CommandPalette open onOpenChange={vi.fn()} commands={statics} searchContent={searchContent} />)
    await userEvent.type(screen.getByRole("combobox"), "potential-energy")
    const heading = await screen.findByText("Said in your videos")
    // Rendered *and visible*: cmdk hides a group its own filter emptied.
    expect(heading.closest("[cmdk-group]")?.hasAttribute("hidden")).toBe(false)
    expect(screen.getByText("Physics revision").closest("[cmdk-item]")?.hasAttribute("hidden")).toBe(false)
    expect(screen.queryByText("No matching commands.")).toBeNull()
    const mark = document.querySelector("mark")
    expect(mark?.textContent).toBe("energy")
    await userEvent.click(screen.getByText("Physics revision"))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("asks for nothing on a one-letter query", async () => {
    const searchContent = vi.fn(() => [])
    render(<CommandPalette open onOpenChange={vi.fn()} commands={statics} searchContent={searchContent} />)
    await userEvent.type(screen.getByRole("combobox"), "e")
    expect(searchContent).not.toHaveBeenCalled()
  })
})
