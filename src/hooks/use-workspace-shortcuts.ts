"use client"

import { useEffect } from "react"

function isTypingInFocusedElement(): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  const tag = active.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable
}

export function useWorkspaceShortcuts(handlers: {
  onOpenPalette: () => void
  onFocusSearch: () => void
  onEscape: () => void
  onSelectAll?: () => void
}) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const key = e.key.toLowerCase()
      const meta = e.metaKey || e.ctrlKey

      if (meta && key === "k") {
        e.preventDefault()
        handlers.onOpenPalette()
        return
      }

      if (meta && key === "a" && handlers.onSelectAll) {
        e.preventDefault()
        handlers.onSelectAll()
        return
      }

      if (key === "escape") {
        handlers.onEscape()
        return
      }

      if (key === "/" && !isTypingInFocusedElement()) {
        e.preventDefault()
        handlers.onFocusSearch()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handlers])
}
