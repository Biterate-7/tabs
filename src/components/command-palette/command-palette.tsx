"use client"

import { Command as CommandPrimitive } from "cmdk"
import { Kbd } from "@/components/ui/kbd"
import type { Command, CommandGroup } from "./types"

const GROUP_ORDER: CommandGroup[] = ["Ask", "Navigation", "Selection", "Actions", "Sort", "Help"]

export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: Command[]
}) {
  if (!open) return null

  function run(command: Command) {
    onOpenChange(false)
    command.onSelect()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 sm:px-4 sm:pt-[15vh]"
      onClick={() => onOpenChange(false)}
    >
      <CommandPrimitive
        label="Command palette"
        className="flex h-full w-full flex-col overflow-hidden bg-popover text-popover-foreground sm:h-auto sm:max-w-lg sm:rounded-xl sm:shadow-lg sm:ring-1 sm:ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
        shouldFilter
      >
        <CommandPrimitive.Input
          autoFocus
          placeholder="Type a command or search…"
          className="w-full border-b border-subtle bg-transparent px-4 py-3 text-body text-foreground placeholder:text-tertiary outline-none"
        />
        <CommandPrimitive.List className="max-h-none flex-1 overflow-y-auto p-2 sm:max-h-[60vh]">
          <CommandPrimitive.Empty className="py-6 text-center text-body-sm text-tertiary">
            No matching commands.
          </CommandPrimitive.Empty>
          {GROUP_ORDER.map((group) => {
            const groupCommands = commands.filter((c) => c.group === group)
            if (groupCommands.length === 0) return null
            return (
              <CommandPrimitive.Group
                key={group}
                heading={group}
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:text-tertiary"
              >
                {groupCommands.map((command) => (
                  <CommandPrimitive.Item
                    key={command.id}
                    value={`${command.label} ${command.group}`}
                    disabled={command.disabled}
                    onSelect={() => run(command)}
                    className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-body text-foreground data-[selected=true]:bg-primary/15 data-[selected=true]:text-accent-text aria-disabled:opacity-40"
                  >
                    <command.icon className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1">{command.label}</span>
                    {command.shortcut && <Kbd keys={command.shortcut} />}
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )
          })}
        </CommandPrimitive.List>
      </CommandPrimitive>
    </div>
  )
}
