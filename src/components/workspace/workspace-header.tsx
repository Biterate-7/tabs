"use client"

import { useState } from "react"
import { Sparkles, Download, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SearchBar } from "@/components/workspace/search-bar"
import { ClearWorkspaceDialog } from "@/components/workspace/clear-workspace-dialog"

export function WorkspaceHeader({
  tabCount,
  searchValue,
  onSearch,
  onSearchArrowDown,
  onSearchArrowUp,
  onSearchEnter,
  onCleanup,
  onExport,
  onClear,
}: {
  tabCount: number
  searchValue: string
  onSearch: (query: string) => void
  onSearchArrowDown?: () => void
  onSearchArrowUp?: () => void
  onSearchEnter?: () => void
  onCleanup: () => void
  onExport: () => void
  onClear: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <header className="border-b border-subtle">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-4">
        <div className="mr-auto">
          <p className="text-sm font-semibold tracking-tight text-foreground">TabDump</p>
          <p className="text-xs text-tertiary">
            {tabCount} tab{tabCount === 1 ? "" : "s"}
          </p>
        </div>

        <SearchBar
          value={searchValue}
          onChange={onSearch}
          onArrowDown={onSearchArrowDown}
          onArrowUp={onSearchArrowUp}
          onEnter={onSearchEnter}
        />
        <Button variant="ghost" size="sm" onClick={onCleanup}>
          <Sparkles /> Cleanup
        </Button>
        <Button variant="ghost" size="sm" onClick={onExport}>
          <Download /> Export
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
          <Trash2 /> Clear
        </Button>
      </div>

      <ClearWorkspaceDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          setConfirmOpen(false)
          onClear()
        }}
      />
    </header>
  )
}
