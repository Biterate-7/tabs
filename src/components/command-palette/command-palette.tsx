"use client"

import { Command as CommandPrimitive } from "cmdk"
import { Search } from "lucide-react"
import { Kbd } from "@/components/ui/kbd"
import { modKeyLabel } from "@/lib/keyboard"
import type { Command, CommandGroup } from "./types"

const GROUP_ORDER: CommandGroup[] = [
  "Ask",
  "Navigation",
  "Agents",
  "Workspaces",
  "Workspace",
  "Tabs",
  "Selection",
  "Collections",
  "Sections",
  "Actions",
  "Sort",
  "Settings",
  "Help",
]

/**
 * Matches by substring and by whole words, never by scattered letters.
 *
 * cmdk's default scorer is a fuzzy subsequence match, which is fine for a
 * handful of commands and wrong once every saved tab is in the list: "arxiv"
 * ranked "Connect an agent" first because its keywords happen to contain
 * a, r, x, i and v in order. A label that starts with the query ranks
 * highest, then a label that contains it, then a hint or keyword that does,
 * then every query word appearing somewhere; anything else is hidden.
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase()
  if (!query) return 1
  const label = value.toLowerCase()
  if (label.startsWith(query)) return 1
  if (label.includes(query)) return 0.9
  const haystack = [label, ...(keywords ?? []).map((k) => k.toLowerCase())].join(" ")
  if (haystack.includes(query)) return 0.7
  const words = query.split(/\s+/).filter(Boolean)
  return words.every((word) => haystack.includes(word)) ? 0.5 : 0
}

/**
 * HubbleCommandPalette.
 *
 * Search-first and keyboard-first, in the reference's flyout language: a
 * 640px panel dropped 15vh from the top, the elevated tone, a 10% hairline,
 * a 10px corner and the long window shadow over a plain dim (no blur). A
 * 44px search row with a leading glyph; 30px result rows at 13px with the
 * glyph at the secondary tier and an optional 11px second line; group
 * headings at 11px in sentence case; the highlighted row is a tonal step,
 * never colour. A key-hint footer says how to drive it.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  placeholder = "Type a command or search…",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: Command[]
  placeholder?: string
}) {
  if (!open) return null

  function run(command: Command) {
    onOpenChange(false)
    command.onSelect()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-(--overlay) sm:px-4 sm:pt-[15vh]"
      onClick={() => onOpenChange(false)}
    >
      <CommandPrimitive
        label="Command palette"
        className="flex h-full w-full flex-col overflow-hidden bg-popover text-popover-foreground sm:h-auto sm:max-w-[640px] sm:rounded-lg sm:border sm:border-border sm:shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            onOpenChange(false)
          }
        }}
        shouldFilter
        filter={paletteFilter}
      >
        <div className="flex h-11 items-center gap-2.5 border-b border-border px-3.5">
          <Search className="size-4 shrink-0 text-tertiary" aria-hidden />
          <CommandPrimitive.Input
            autoFocus
            placeholder={placeholder}
            className="h-full w-full bg-transparent text-[length:calc(var(--hb-text-14)*var(--tabdump-font-scale))] text-foreground placeholder:text-tertiary outline-none focus-visible:outline-none"
          />
          <Kbd className="shrink-0">esc</Kbd>
        </div>
        <CommandPrimitive.List className="max-h-none flex-1 overflow-y-auto p-1.5 sm:max-h-[min(60vh,440px)]">
          <CommandPrimitive.Empty className="py-8 text-center text-body-sm text-tertiary">
            No matching commands.
          </CommandPrimitive.Empty>
          {GROUP_ORDER.map((group) => {
            const groupCommands = commands.filter((c) => c.group === group)
            if (groupCommands.length === 0) return null
            return (
              <CommandPrimitive.Group
                key={group}
                heading={group}
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:text-tertiary"
              >
                {groupCommands.map((command) => (
                  <CommandPrimitive.Item
                    key={command.id}
                    value={`${command.label} ${command.group} ${command.id}`}
                    keywords={[...(command.keywords ?? []), ...(command.hint ? [command.hint] : [])]}
                    disabled={command.disabled}
                    onSelect={() => run(command)}
                    className="group/item flex min-h-[30px] cursor-default items-center gap-2.5 rounded-xs px-2 py-1 text-body text-foreground data-[selected=true]:bg-surface-active aria-disabled:opacity-40"
                  >
                    <command.icon
                      className="size-4 shrink-0 text-muted-foreground group-data-[selected=true]/item:text-foreground"
                      aria-hidden
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{command.label}</span>
                      {command.hint && <span className="truncate text-meta text-tertiary">{command.hint}</span>}
                    </span>
                    {command.shortcut && <Kbd keys={command.shortcut} />}
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )
          })}
        </CommandPrimitive.List>
        <div className="hidden h-8 items-center gap-4 border-t border-border px-3.5 text-meta text-tertiary sm:flex">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> select
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd keys={[modKeyLabel(), "K"]} /> toggle
          </span>
        </div>
      </CommandPrimitive>
    </div>
  )
}
