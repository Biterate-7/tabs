import type { LucideIcon } from "lucide-react"

export type CommandGroup = "Ask" | "Navigation" | "Workspace" | "Selection" | "Collections" | "Actions" | "Sort" | "Help"

export type Command = {
  id: string
  label: string
  group: CommandGroup
  icon: LucideIcon
  shortcut?: string[]
  onSelect: () => void
  disabled?: boolean
}
