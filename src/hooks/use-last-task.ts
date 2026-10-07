"use client"

import { useMemo, useSyncExternalStore } from "react"
import { lastTaskIn, lastTasksSnapshot, subscribeLastTasks } from "@/lib/agents/command-centre/last-task"
import type { LastTask } from "@/lib/agents/command-centre/last-task"

/**
 * A workspace's last agent task (Stage 3), live: re-read whenever the Command
 * Centre records a newer one. What the workspace header and the Command
 * Centre's start screen show a returning developer.
 */
export function useLastTask(workspaceId: string | undefined): LastTask | undefined {
  const snapshot = useSyncExternalStore(subscribeLastTasks, lastTasksSnapshot, () => null)
  return useMemo(() => lastTaskIn(snapshot, workspaceId), [snapshot, workspaceId])
}
