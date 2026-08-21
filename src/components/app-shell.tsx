"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { LandingView } from "@/components/landing-view"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import {
  clearWorkspaceStorage,
  isStorageAvailable,
  loadWorkspace,
  saveWorkspace,
} from "@/lib/workspace/persistence"
import { useTitleResolution } from "@/hooks/use-title-resolution"
import { useExtensionImport } from "@/hooks/use-extension-import"
import { markDuplicates } from "@/lib/tabs"
import { buildTabsFromBrowserImport, type BrowserImportEntry } from "@/lib/tabs/browser-import"
import type { Tab } from "@/lib/tabs/types"

export function AppShell() {
  const [workspaceTabs, setWorkspaceTabs] = useState<Tab[] | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [canPersist, setCanPersist] = useState(true)

  useEffect(() => {
    // Hydrating from localStorage: this can only run post-mount (SSR has no
    // access to it, and reading it during render would cause a hydration
    // mismatch), so there is no way to derive this during render instead —
    // it's exactly the "synchronize with an external system on mount" case
    // effects exist for, not the derived-state anti-pattern this rule targets.
    const available = isStorageAvailable()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanPersist(available)
    if (available) {
      const persisted = loadWorkspace()
      if (persisted && persisted.length > 0) setWorkspaceTabs(persisted)
    } else {
      toast.info("Your workspace won't be saved between visits", {
        description: "Local storage isn't available in this browser.",
      })
    }
    setHydrated(true)
  }, [])

  function persist(tabs: Tab[]) {
    if (canPersist) saveWorkspace(tabs)
  }

  function handleDump(tabs: Tab[]) {
    setWorkspaceTabs(tabs)
    persist(tabs)
  }

  function handleTabsChange(tabs: Tab[]) {
    setWorkspaceTabs(tabs)
    persist(tabs)
  }

  // Resolves titles asynchronously and patches them in via the same path
  // every other tab mutation already uses — no separate state or
  // persistence needed, and a tab always shows its domain until (or unless)
  // this ever succeeds.
  useTitleResolution(workspaceTabs ?? [], handleTabsChange)

  // Tabs arriving from the browser extension go through the exact same
  // parsing/categorization the paste flow uses (buildTabsFromBrowserImport
  // wraps parseSingleUrl + categorizeTabs), then either become a fresh dump
  // or get merged into whatever's already open — `markDuplicates` runs over
  // the combined list either way, so cross-batch duplicates are still
  // caught, not just duplicates within the incoming batch.
  function handleBrowserImport(entries: BrowserImportEntry[]) {
    const incoming = buildTabsFromBrowserImport(entries)
    if (incoming.length === 0) return

    if (!workspaceTabs) {
      handleDump(markDuplicates(incoming))
    } else {
      handleTabsChange(markDuplicates([...workspaceTabs, ...incoming]))
    }
  }

  useExtensionImport(handleBrowserImport)

  function handleClear() {
    setWorkspaceTabs(null)
    clearWorkspaceStorage()
  }

  if (!hydrated) return null

  if (!workspaceTabs) {
    return <LandingView onDump={handleDump} />
  }

  return (
    <WorkspaceView
      tabs={workspaceTabs}
      onTabsChange={handleTabsChange}
      onClear={handleClear}
    />
  )
}
