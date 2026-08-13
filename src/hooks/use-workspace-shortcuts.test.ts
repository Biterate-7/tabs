import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useWorkspaceShortcuts } from "./use-workspace-shortcuts"

function fireKey(init: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent("keydown", init))
}

describe("useWorkspaceShortcuts", () => {
  it("calls onOpenPalette on Cmd/Ctrl+K", () => {
    const onOpenPalette = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({ onOpenPalette, onFocusSearch: vi.fn(), onEscape: vi.fn() })
    )
    fireKey({ key: "k", metaKey: true })
    expect(onOpenPalette).toHaveBeenCalledOnce()
  })

  it("calls onFocusSearch on / when no input is focused", () => {
    const onFocusSearch = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({ onOpenPalette: vi.fn(), onFocusSearch, onEscape: vi.fn() })
    )
    fireKey({ key: "/" })
    expect(onFocusSearch).toHaveBeenCalledOnce()
  })

  it("does not hijack / while an input is focused", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    const onFocusSearch = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({ onOpenPalette: vi.fn(), onFocusSearch, onEscape: vi.fn() })
    )
    fireKey({ key: "/" })
    expect(onFocusSearch).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it("calls onEscape on Escape", () => {
    const onEscape = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({ onOpenPalette: vi.fn(), onFocusSearch: vi.fn(), onEscape })
    )
    fireKey({ key: "Escape" })
    expect(onEscape).toHaveBeenCalledOnce()
  })

  it("calls onSelectAll on Cmd/Ctrl+A when provided", () => {
    const onSelectAll = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({
        onOpenPalette: vi.fn(),
        onFocusSearch: vi.fn(),
        onEscape: vi.fn(),
        onSelectAll,
      })
    )
    fireKey({ key: "a", metaKey: true })
    expect(onSelectAll).toHaveBeenCalledOnce()
  })
})
