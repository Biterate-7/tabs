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
