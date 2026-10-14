"use client"

import { createContext, useContext } from "react"
import { MessageSquareShare } from "lucide-react"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import type { KnowledgeItemRef } from "@/lib/memory/items"

/**
 * "Use in AI chat": the one action every surface offers on things it shows —
 * a saved page, a selection, a collection, a whole project. It opens the
 * context builder (ReuseDialog) with those things chosen; nothing is sent
 * anywhere until the person copies or inserts the result themselves.
 *
 * Provided by the app shell, which owns the dialog. Absent (null) where the
 * surface is rendered without it — the landing page's demo — and every
 * caller then simply offers nothing.
 */

export type MemorySelection = {
  workspaceId: string
  /** Specific items. Empty with no collections: the person picks in the dialog. */
  refs?: readonly KnowledgeItemRef[]
  /** Saved tabs, by id — sources or not (a plain saved tab is offered by its title and link). */
  tabIds?: readonly string[]
  collectionIds?: readonly string[]
}

export type MemoryActions = {
  /** The project on screen — what a surface that does not know its own project acts on. */
  currentWorkspaceId: string
  reuse: (selection: MemorySelection) => void
}

const MemoryActionsContext = createContext<MemoryActions | null>(null)

export const MemoryActionsProvider = MemoryActionsContext.Provider

export function useMemoryActions(): MemoryActions | null {
  return useContext(MemoryActionsContext)
}

/** The menu item, for any dropdown that acts on something in a project. */
export function UseInAiMenuItem({ selection, label = "Use in AI chat…" }: { selection: MemorySelection; label?: string }) {
  const actions = useMemoryActions()
  if (!actions) return null
  return (
    <DropdownMenuItem onClick={() => actions.reuse(selection)}>
      <MessageSquareShare /> {label}
    </DropdownMenuItem>
  )
}
