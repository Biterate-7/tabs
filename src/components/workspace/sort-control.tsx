"use client"

import { ArrowUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { SortKey } from "@/lib/workspace/search"

const LABELS: Record<SortKey, string> = {
  recent: "Recently added",
  title: "Title",
  domain: "Domain",
  category: "Category",
}

const ORDER: SortKey[] = ["recent", "title", "domain", "category"]

export function SortControl({
  value,
  onChange,
}: {
  value: SortKey
  onChange: (value: SortKey) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm">
            <ArrowUpDown className="size-3.5" />
            {LABELS[value]}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {ORDER.map((key) => (
          <DropdownMenuItem key={key} onClick={() => onChange(key)}>
            {LABELS[key]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
