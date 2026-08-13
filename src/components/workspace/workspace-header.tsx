"use client"

import { useState } from "react"
import { Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { SearchBar } from "@/components/workspace/search-bar"
import { ExportMenu } from "@/components/workspace/export-menu"
import { ClearWorkspaceDialog } from "@/components/workspace/clear-workspace-dialog"
import type { Tab } from "@/lib/tabs/types"

export function WorkspaceHeader({
  tabs,
  searchValue,
  onSearch,
  onSearchArrowDown,
  onSearchArrowUp,
  onSearchEnter,
  onCleanup,
  onClear,
  onOpenPalette,
}: {
  tabs: Tab[]
  searchValue: string
  onSearch: (query: string) => void
  onSearchArrowDown?: () => void
  onSearchArrowUp?: () => void
  onSearchEnter?: () => void
  onCleanup: () => void
  onClear: () => void
  onOpenPalette?: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const tabCount = tabs.length

  return (
    <header className="border-b border-subtle">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-4">
        <div className="mr-auto">
          <p className="text-body font-semibold tracking-tight text-foreground">TabDump</p>
          <p className="text-meta text-tertiary">
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

        {onOpenPalette && (
          <button
            type="button"
            onClick={onOpenPalette}
            className="hidden items-center gap-1.5 rounded-lg border border-subtle px-2 py-1 text-tertiary transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border hover:text-foreground md:inline-flex"
            aria-label="Open command palette"
          >
            <span className="text-label">Commands</span>
            <Kbd keys={["⌘", "K"]} />
          </button>
        )}

        <Button variant="ghost" size="sm" onClick={onCleanup}>
          <Sparkles /> Cleanup
        </Button>
        <ExportMenu tabs={tabs} />
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
