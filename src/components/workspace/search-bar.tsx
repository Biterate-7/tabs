"use client"

import { Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { IconButton } from "@/components/ui/icon-button"

export function SearchBar({
  value,
  onChange,
  onArrowDown,
  onArrowUp,
  onEnter,
  className,
}: {
  value: string
  onChange: (value: string) => void
  onArrowDown?: () => void
  onArrowUp?: () => void
  onEnter?: () => void
  className?: string
}) {
  return (
    <div className={cn("relative w-40 sm:w-64", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
      <Input
        id="workspace-search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search tabs..."
        className="h-7 pl-7 text-body-sm"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("")
            e.currentTarget.blur()
          } else if (e.key === "ArrowDown") {
            e.preventDefault()
            onArrowDown?.()
          } else if (e.key === "ArrowUp") {
            e.preventDefault()
            onArrowUp?.()
          } else if (e.key === "Enter") {
            e.preventDefault()
            onEnter?.()
          }
        }}
      />
      {value && (
        <IconButton
          aria-label="Clear search"
          className="absolute top-1/2 right-0.5 size-6 -translate-y-1/2"
          onClick={() => onChange("")}
        >
          <X className="size-3.5" />
        </IconButton>
      )}
    </div>
  )
}
