"use client"

import { useEffect, useRef } from "react"

function isTypingInFocusedElement(): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  const tag = active.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable
}

type ShortcutHandlers = {
  onOpenPalette: () => void
  onFocusSearch: () => void
  onEscape: () => void
  onSelectAll?: () => void
}

export function useWorkspaceShortcuts(handlers: ShortcutHandlers) {
  // WorkspaceView passes a new `handlers` object (with inline arrow
  // functions) on every render. Keeping it out of the effect's
  // dependency array — reading the latest values via this ref instead —
  // means the window listener is attached once on mount rather than
  // being torn down and resubscribed on every keystroke/selection change.
  const handlersRef = useRef<ShortcutHandlers>(handlers)
  // Deliberate "latest ref" idiom: this write is a same-render snapshot
  // assignment, not a state mutation read back during this render, so it
  // can't cause the divergent-render bug the rule guards against.
  // eslint-disable-next-line react-hooks/refs
  handlersRef.current = handlers

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const key = e.key.toLowerCase()
      const meta = e.metaKey || e.ctrlKey
      const current = handlersRef.current

      if (meta && key === "k") {
        e.preventDefault()
        current.onOpenPalette()
        return
      }

      if (meta && key === "a" && current.onSelectAll) {
        e.preventDefault()
        current.onSelectAll()
        return
      }

      if (key === "escape") {
        current.onEscape()
        return
      }

      if (key === "/" && !isTypingInFocusedElement()) {
        e.preventDefault()
        current.onFocusSearch()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])
}
