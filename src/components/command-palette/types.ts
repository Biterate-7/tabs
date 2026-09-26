import type { LucideIcon } from "lucide-react"

export type CommandGroup =
  | "Ask"
  | "Navigation"
  | "Workspaces"
  | "Agents"
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
  /** Extra words the filter should match that are not shown (synonyms). */
  keywords?: string[]
}
