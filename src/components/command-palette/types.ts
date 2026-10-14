import type { LucideIcon } from "lucide-react"

export type CommandGroup =
  | "Ask"
  /** Moments in saved videos' transcripts, matched to what is typed. */
  | "Moments"
  | "Navigation"
  | "Workspaces"
  /** Using saved knowledge in an AI chat, and bringing knowledge in. */
  | "Memory"
  | "Workspace"
  | "Tabs"
  | "Selection"
  | "Collections"
  | "Sections"
  | "Actions"
  | "Sort"
  | "Settings"
  | "Help"

export type Command = {
  id: string
  label: string
  group: CommandGroup
  icon: LucideIcon
  shortcut?: string[]
  onSelect: () => void
  disabled?: boolean
  /**
   * A quiet second line — a tab's address, what a command will do. Shown
   * under the label and searched along with it.
   */
  hint?: string
  /**
   * Set on a result that is a website (a saved tab): the palette draws that
   * site's favicon in place of `icon`, and falls back to `icon` — the globe —
   * whenever there is none to show.
   */
  site?: { domain: string; favicon?: string }
  /** Extra words the filter should match that are not shown (synonyms). */
  keywords?: string[]
  /** Words to mark in the hint — it is an excerpt that matched them. */
  highlight?: readonly string[]
  /** Already matched by its own search: shown whatever the palette's filter thinks. */
  forceMount?: boolean
}
