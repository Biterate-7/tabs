"use client"

import { useState } from "react"
import { Search, Sparkles, Download, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ClearWorkspaceDialog } from "@/components/workspace/clear-workspace-dialog"

export function WorkspaceHeader({
  tabCount,
  onSearch,
  onCleanup,
  onExport,
  onClear,
}: {
  tabCount: number
  onSearch: (query: string) => void
  onCleanup: () => void
  onExport: () => void
  onClear: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  return (
    <header className="border-b border-subtle">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-4">
        <div className="mr-auto">
          <p className="text-sm font-semibold tracking-tight text-foreground">TabDump</p>
          <p className="text-xs text-tertiary">
            {tabCount} tab{tabCount === 1 ? "" : "s"}
          </p>
        </div>

        {searchOpen && (
          <Input
            autoFocus
            placeholder="Search tabs..."
            className="h-8 w-40 sm:w-56"
            onChange={(e) => onSearch(e.target.value)}
            onBlur={(e) => {
              if (!e.target.value) setSearchOpen(false)
            }}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Search /> Search
        </Button>
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
