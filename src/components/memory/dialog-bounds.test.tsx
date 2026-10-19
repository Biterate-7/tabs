import "fake-indexeddb/auto"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { CaptureDialog } from "./capture-dialog"
import { ReuseDialog } from "./reuse-dialog"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The shared Textarea grows with its content (field-sizing: content) and
 * DialogContent has no height of its own. Live QA found the reuse dialog
 * taller than the window once a 25,000-word page was chosen: its title and
 * Copy button were off-screen. jsdom lays nothing out, so this holds the two
 * bounds that fix it in place: the dialog fits the viewport and scrolls, and
 * each long text box scrolls inside a capped height.
 */

const workspace: Workspace = { id: "w", name: "History IA", tabs: [], createdAt: 0, updatedAt: 0 }

function expectViewportBounded(dialog: HTMLElement) {
  expect(dialog.className).toContain("max-h-[calc(100dvh-2rem)]")
  expect(dialog.className).toContain("overflow-y-auto")
}

function expectCapped(field: HTMLElement) {
  expect(field.className).toMatch(/\bmax-h-\[\d+dvh\]/)
  expect(field.className).toContain("overflow-y-auto")
}

describe("long text never pushes a dialog off-screen", () => {
  it("reuse: the dialog fits the viewport and the preview scrolls inside it", () => {
    render(<ReuseDialog open onOpenChange={vi.fn()} workspace={workspace} initialRefs={[]} />)
    expectViewportBounded(document.querySelector<HTMLElement>("[data-reuse-dialog]")!)
    expectCapped(screen.getByLabelText("Message for the AI app"))
  })

  it("capture: the dialog fits the viewport and a pasted conversation scrolls inside it", () => {
    const save = vi.fn()
    render(<CaptureDialog open onOpenChange={vi.fn()} projectName="History IA" initialMode="conversation" onSaveConversations={save} onSaveNote={save} />)
    expectViewportBounded(document.querySelector<HTMLElement>("[data-capture-dialog]")!)
    expectCapped(document.querySelector<HTMLElement>("[data-capture-dialog] textarea")!)
  })
})
