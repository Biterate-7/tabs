"use client"

import type { ReactNode } from "react"
import { IntelligenceContext, useIntelligenceProcessor } from "@/hooks/use-intelligence-processor"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Runs conversation intelligence for every project in the background, for
 * as long as the app is open, and shares the result with every view
 * (Conversations, Graph, Settings → Conversations). Mounted once, by AppShell.
 *
 * Every project, not only those on screen: what was saved before Hubble
 * could read it — or while it was closed — is analysed after start-up
 * without opening any view.
 */
export function IntelligenceProvider({ workspaces, children }: { workspaces: readonly Workspace[]; children: ReactNode }) {
  const processor = useIntelligenceProcessor(workspaces, { background: true })
  return <IntelligenceContext.Provider value={processor}>{children}</IntelligenceContext.Provider>
}
