"use client"

import { useCallback, useRef, useState } from "react"
import { computeSemanticClusterHints } from "@/lib/ai/cluster"
import { indexWorkspace } from "@/lib/ai/indexer"
import { analyzeForOrganization } from "@/lib/organize/analyze"
import type { SemanticClusterHint, OrganizationPlan } from "@/lib/organize/types"
import type { Workspace } from "@/lib/workspace/types"

export type AutoOrganizeStatus = "idle" | "analyzing" | "ready"

/**
 * Runs Auto-Organize's analysis pass entirely client-side and automatically
 * (no chat, no question to type) — this is the only AI-facing capability
 * left in the product. Best-effort indexes `workspace`'s tabs so semantic
 * clustering hints are available (see src/lib/ai/cluster.ts); a failure
 * there (missing API key, network error, rate limit) is swallowed, since
 * analyzeForOrganization's deterministic domain/keyword clustering still
 * works without them — organization enhances importing, it's never a
 * dependency that can break it.
 */
export function useAutoOrganize() {
  const [plan, setPlan] = useState<OrganizationPlan | null>(null)
  const [status, setStatus] = useState<AutoOrganizeStatus>("idle")
  const runIdRef = useRef(0)

  const analyze = useCallback(async (workspace: Workspace, allWorkspaces: Workspace[]) => {
    const runId = ++runIdRef.current
    setStatus("analyzing")

    let hints: SemanticClusterHint[] = []
    try {
      await indexWorkspace(workspace.id, workspace.tabs)
      hints = await computeSemanticClusterHints(allWorkspaces.map((w) => w.id))
    } catch {
      hints = []
    }
    if (runIdRef.current !== runId) return

    let result: OrganizationPlan
    try {
      result = analyzeForOrganization([workspace], allWorkspaces, hints)
    } catch {
      if (runIdRef.current === runId) setStatus("idle")
      return
    }
    if (runIdRef.current !== runId) return

    if (!result.noopReason && (result.workspaces.length > 0 || result.uncertainTabs.length > 0)) {
      setPlan(result)
      setStatus("ready")
    } else {
      setPlan(null)
      setStatus("idle")
    }
  }, [])

  const dismiss = useCallback(() => {
    runIdRef.current += 1
    setPlan(null)
    setStatus("idle")
  }, [])

  return { plan, status, analyze, dismiss }
}
