"use client"

import { useState } from "react"
import { LandingView } from "@/components/landing-view"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import type { Tab } from "@/lib/tabs/types"

export function AppShell() {
  const [workspaceTabs, setWorkspaceTabs] = useState<Tab[] | null>(null)

  if (!workspaceTabs) {
    return <LandingView onDump={setWorkspaceTabs} />
  }

  return (
    <WorkspaceView
      tabs={workspaceTabs}
      onTabsChange={setWorkspaceTabs}
      onClear={() => setWorkspaceTabs(null)}
    />
  )
}
