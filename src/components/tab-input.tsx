"use client"

import { useDeferredValue, useMemo, useState } from "react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { DumpConfirmation } from "@/components/dump-confirmation"
import { parseTabInput } from "@/lib/tabs"
import type { Tab } from "@/lib/tabs/types"

const ORGANIZING_DELAY_MS = 550

export function TabInput({ onDump }: { onDump?: (tabs: Tab[]) => void }) {
  const [raw, setRaw] = useState("")
  const [organizing, setOrganizing] = useState(false)
  // Set once the Organizing beat finishes — replaces the form with
  // DumpConfirmation, and holds the exact tab list onDump will receive so a
  // fast-typing user editing `raw` afterward can't change what gets dumped.
  const [readyTabs, setReadyTabs] = useState<Tab[] | null>(null)
  const deferredRaw = useDeferredValue(raw)

  const { tabs, invalidCount } = useMemo(
    () => parseTabInput(deferredRaw),
    [deferredRaw]
  )

  const validCount = tabs.length
  const hasInput = raw.trim().length > 0

  const ctaLabel = organizing
    ? `Organizing ${validCount} tab${validCount === 1 ? "" : "s"}…`
    : validCount === 0
      ? "Dump my tabs →"
      : validCount === 1
        ? "Dump 1 tab →"
        : `Dump ${validCount} tabs →`

  function handleSubmit() {
    if (validCount === 0 || organizing) return
    setOrganizing(true)
    window.setTimeout(() => {
      setOrganizing(false)
      setReadyTabs(tabs)
    }, ORGANIZING_DELAY_MS)
  }

  if (readyTabs) {
    return <DumpConfirmation count={readyTabs.length} onView={() => onDump?.(readyTabs)} />
  }

  return (
    <div className="w-full">
      <Textarea
        aria-label="Paste your tabs"
        placeholder={
          "Paste your tabs here...\n\nhttps://github.com/...\nhttps://arxiv.org/...\nhttps://amazon.in/..."
        }
        rows={8}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        disabled={organizing}
        className={
          "w-full resize-none text-left text-sm sm:text-base" +
          (validCount > 0 ? " border-primary/60" : "")
        }
      />

      <div className="mt-2 flex min-h-5 items-center justify-between gap-4 text-tertiary">
        <span className="text-meta">
          {hasInput &&
            `${validCount} tab${validCount === 1 ? "" : "s"} detected${
              invalidCount > 0 ? ` · ${invalidCount} invalid` : ""
            }`}
        </span>
        <span className="text-right text-body-sm">
          Paste 20, 50, or even 100 tabs at once.
        </span>
      </div>

      <Button
        size="lg"
        className="mt-6 w-full sm:w-auto"
        disabled={validCount === 0 || organizing}
        onClick={handleSubmit}
      >
        {ctaLabel}
      </Button>
    </div>
  )
}
