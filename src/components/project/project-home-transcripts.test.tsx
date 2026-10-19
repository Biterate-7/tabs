import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectHome } from "./project-home"
import { putContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import { ingestResources } from "@/lib/resources/ingest"
import { EXTRACTION_ERRORS } from "@/lib/resources/extraction"
import type { ResourceActions } from "@/hooks/use-resource-processing"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

/**
 * A project with saved lectures, searched from its own page: transcript
 * matches come back with the time they are said, the time opens YouTube
 * there, and the result opens the video's reader at that line.
 */

const NOW = 1_800_000_000_000
const PHYSICS_ID = "aaaaaaaaaaa"
const CHEM_ID = "bbbbbbbbbbb"

async function subject(): Promise<Workspace> {
  let store: WorkspaceStore = { version: 1, currentId: "w", workspaces: [{ id: "w", name: "Physics", tabs: [], sections: [], createdAt: 1, updatedAt: 1 }] }
  store = ingestResources(
    store,
    "w",
    [
      { url: `https://www.youtube.com/watch?v=${PHYSICS_ID}&t=30`, title: "Physics revision" },
      { url: `https://youtu.be/${CHEM_ID}`, title: "Chemistry: energetics" },
      { url: "https://example.com/notes", title: "Revision notes" },
    ],
    "manual",
    NOW
  )!.store
  const [physics, chemistry, notes] = store.workspaces[0]!.tabs as [Tab, Tab, Tab]
  const physicsSummary = await putContent("w", physics.id, {
    kind: "youtube",
    extractedAt: 10,
    transcriptInfo: { source: "captions", language: "en" },
    transcript: [
      { start: 0, end: 4, text: "Welcome back to physics revision." },
      { start: 522, end: 526, text: "Gravitational potential energy is the energy an object has" },
      { start: 526, end: 530, text: "because of its height." },
    ],
  })
  const chemSummary = await putContent("w", chemistry.id, { kind: "youtube", extractedAt: 11, transcript: [{ start: 75, text: "Bond energy is released when bonds form." }] })
  const notesSummary = await putContent("w", notes.id, { kind: "webpage", extractedAt: 12, text: "Energy is conserved in every closed system we study." })
  const ready = (tab: Tab, content: typeof physicsSummary): Tab => ({ ...tab, resource: { ...tab.resource!, status: "ready", content } })
  return { ...store.workspaces[0]!, tabs: [ready(physics, physicsSummary), ready(chemistry, chemSummary), ready(notes, notesSummary)] }
}

function resources(): ResourceActions {
  return { retry: vi.fn(), attachPdf: vi.fn(), attachTranscript: vi.fn(async () => ({})), forget: vi.fn() }
}

function renderHome(workspace: Workspace, overrides: Partial<Parameters<typeof ProjectHome>[0]> = {}) {
  const props = {
    workspace,
    now: NOW,
    onAddSources: vi.fn(() => []),
    resources: resources(),
    onRenameSource: vi.fn(),
    onRemoveSources: vi.fn(),
    onOpenSource: vi.fn(),
    onOpenSourceAt: vi.fn(),
    onCapture: vi.fn(),
    notes: { update: vi.fn(), saveText: vi.fn(async () => true), remove: vi.fn() },
    ...overrides,
  }
  const view = render(<ProjectHome {...props} />)
  return { ...props, ...view }
}

async function search(text: string) {
  await userEvent.type(screen.getByPlaceholderText("Search Physics…"), text)
}

beforeEach(() => resetContentStoreForTests())
afterEach(() => localStorage.clear())

describe("searching a project's videos", () => {
  it("returns the moment it is said, with its time and a faithful excerpt", async () => {
    renderHome(await subject())
    await search("gravitational potential energy")
    const results = await screen.findByRole("list", { name: "Search results" })
    const moment = within(results).getAllByRole("listitem").find((item) => item.getAttribute("data-search-hit") === "transcript")!
    expect(moment.textContent).toContain("Physics revision")
    expect(moment.textContent).toContain("8:42")
    expect(moment.textContent).toContain("Gravitational potential energy is the energy an object has because of its height.")
    expect([...moment.querySelectorAll("mark")].map((mark) => mark.textContent!.toLowerCase())).toEqual(["gravitational", "potential", "energy", "energy"])
  })

  it("finds one word across several videos, each at its own time", async () => {
    renderHome(await subject())
    await search("energy")
    const results = await screen.findByRole("list", { name: "Search results" })
    await within(results).findByRole("button", { name: "Watch Chemistry: energetics on YouTube from 1:15" })
    const times = within(results)
      .getAllByRole("listitem")
      .filter((item) => item.getAttribute("data-search-hit") === "transcript")
      .map((item) => item.querySelector(".tabular-nums")?.textContent)
    expect(times.sort()).toEqual(["1:15", "8:42"])
  })

  it("opens YouTube at the moment — not at the saved link's start time", async () => {
    const props = renderHome(await subject())
    await search("potential energy")
    await userEvent.click(await screen.findByRole("button", { name: "Watch Physics revision on YouTube from 8:42" }))
    expect(props.onOpenSourceAt).toHaveBeenCalledWith(expect.objectContaining({ title: "Physics revision" }), `https://www.youtube.com/watch?v=${PHYSICS_ID}&t=522s`)
  })

  it("opens the video's reader at that line", async () => {
    renderHome(await subject())
    await search("potential energy")
    const results = await screen.findByRole("list", { name: "Search results" })
    const moment = within(results).getAllByRole("listitem").find((item) => item.getAttribute("data-search-hit") === "transcript")!
    await userEvent.click(within(moment).getAllByRole("button")[0]!)
    const dialog = await screen.findByRole("dialog")
    const list = await within(dialog).findByRole("list", { name: "Transcript lines" })
    expect(list.querySelector('[aria-current="true"]')?.textContent).toContain("Gravitational potential energy")
    expect(within(dialog).getByRole("button", { name: "Open on YouTube at 8:42" })).toBeTruthy()
  })

  it("respects the kind filter: AI conversations leaves the videos and the web page out", async () => {
    const workspace = await subject()
    let store: WorkspaceStore = { version: 1, currentId: "w", workspaces: [workspace] }
    store = ingestResources(store, "w", [{ url: "https://chatgpt.com/c/energy-chat-1", title: "Energy questions" }], "extension", NOW)!.store
    const chat = store.workspaces[0]!.tabs.at(-1)!
    const summary = await putContent("w", chat.id, {
      kind: "conversation",
      extractedAt: 13,
      turns: [
        { role: "user", text: "Why is energy conserved?" },
        { role: "assistant", text: "Because the laws of physics do not change over time." },
      ],
    })
    const tabs = store.workspaces[0]!.tabs.map((tab) => (tab.id === chat.id ? { ...tab, resource: { ...tab.resource!, status: "ready" as const, content: summary } } : tab))
    renderHome({ ...store.workspaces[0]!, tabs })
    await userEvent.click(screen.getByRole("button", { name: /^AI conversations/ }))
    await search("energy")
    const results = await screen.findByRole("list", { name: "Search results" })
    expect((await within(results).findAllByText("Energy questions", { exact: false })).length).toBeGreaterThan(0)
    expect(results.textContent).not.toContain("Revision notes")
    expect(results.textContent).not.toContain("Physics revision")
  })

  it("a removed video is not found, even with its transcript still on the device", async () => {
    const workspace = await subject()
    renderHome({ ...workspace, tabs: workspace.tabs.filter((tab) => tab.title !== "Physics revision") })
    await search("gravitational")
    expect(await screen.findByText("Nothing in this project mentions that.")).toBeTruthy()
  })

  it("says which videos are still being read", async () => {
    const workspace = await subject()
    const reading = { ...workspace, tabs: workspace.tabs.map((tab) => (tab.title === "Chemistry: energetics" ? { ...tab, resource: { ...tab.resource!, status: "processing" as const } } : tab)) }
    renderHome(reading)
    await search("photosynthesis")
    expect(await screen.findByText(/Still reading 1 item/)).toBeTruthy()
  })
})

describe("a video without a transcript", () => {
  it("is saved, says why, and retries in place without a new resource", async () => {
    const workspace = await subject()
    const missing = { ...workspace, tabs: workspace.tabs.map((tab) => (tab.title === "Physics revision" ? { ...tab, resource: { ...tab.resource!, status: "partial" as const, content: undefined, error: EXTRACTION_ERRORS.transcript_busy } } : tab)) }
    const actions = resources()
    const props = renderHome(missing, { resources: actions })
    await userEvent.click(screen.getByRole("button", { name: "Physics revision" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(EXTRACTION_ERRORS.transcript_busy.message)).toBeTruthy()
    // One retry control, the reader's own.
    expect(within(dialog).queryByRole("button", { name: /Read again/ })).toBeNull()
    await userEvent.click(within(dialog).getByRole("button", { name: /Try again/ }))
    expect(actions.retry).toHaveBeenCalledWith("w", missing.tabs[0]!.id)
    expect(props.onAddSources).not.toHaveBeenCalled()
    // The person can still add one themselves.
    expect(within(dialog).getByRole("region", { name: "Add a transcript" })).toBeTruthy()
  })
})
