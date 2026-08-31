"use client"

import { Check, ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export type SelectOption = { value: string; label: string }

/**
 * A single-select dropdown picker built on the same Menu primitive
 * DropdownMenu already wraps (rather than introducing base-ui's separate
 * Select primitive) — keeps every popup surface in the app on one proven,
 * already-styled implementation. Used by Typography's font pickers and
 * Background's size/position pickers.
 */
function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  className,
  contentClassName,
}: {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  contentClassName?: string
}) {
  const current = options.find((o) => o.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="outline" className={cn("w-full justify-between font-normal", className)} />}
      >
        <span className="truncate">{current?.label ?? placeholder}</span>
        <ChevronDown className="size-4 shrink-0 text-tertiary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className={cn("max-h-72 w-(--anchor-width) min-w-[10rem]", contentClassName)}>
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onClick={() => onValueChange(option.value)} className="justify-between">
            <span className="truncate">{option.label}</span>
            {option.value === value && <Check className="size-3.5 shrink-0 text-accent-text" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { Select }
