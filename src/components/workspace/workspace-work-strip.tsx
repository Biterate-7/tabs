"use client"

import { useState } from "react"
import { FolderGit2 } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { Button } from "@/components/ui/button"
import { useLastTask } from "@/hooks/use-last-task"
import { useNow } from "@/hooks/use-now"
import { lastTaskStateLabel } from "@/lib/agents/command-centre/last-task"
import { loadControlProjects } from "@/lib/agents/control/persistence"
import { agentDisplayName } from "@/lib/agents/visual/identity"
import { formatRelativeTime } from "@/lib/time-format"
import { workspaceProjectId } from "@/lib/workspace/project"
import { cn } from "@/lib/utils"
import type { Workspace } from "@/lib/workspace/types"

/**
 * What this workspace is working on (Stage 3), at the top of the workspace:
 *
 *     ⌂ hubble-app · Focus: Password check bypass in the auth route.
 *     ◆ Gemini CLI · Done · Changed 2 files in hubble-app · “Fix the auth bug.” · 3h ago   Open
 *
 * The project is the anchor — what agents in this workspace work on — the
 * brief's focus says what is being worked on now, and the last agent task
 * says where the developer left off. Coming back to a workspace, this is the
 * line that answers "what was happening here?" before anything is opened.
 *
 * Renders nothing for a workspace with none of the three: a workspace used
 * only for tabs stays exactly as it was.
 */
export function WorkspaceWorkStrip({
  workspace,
  onOpenCommandCentre,
  onOpenTask,
}: {
  workspace: Pick<Workspace, "id" | "brief" | "project">
  onOpenCommandCentre?: () => void
  /** Opens the Command Centre on the last task's session. */
  onOpenTask?: (sessionId: string) => void
}) {
  const lastTask = useLastTask(workspace.id)
  const now = useNow(60_000)
  const projectId = workspaceProjectId(workspace)
  // The project's name lives with this device's authorized projects; a workspace synced from elsewhere may name one this device doesn't have.
  const [projectName] = useState(() =>
    projectId && typeof window !== "undefined" ? loadControlProjects().projects.find((project) => project.id === projectId)?.name : undefined
  )
  const focus = workspace.brief?.focus?.trim()

  if (!projectName && !focus && !lastTask) return null
  const when = lastTask ? formatRelativeTime(lastTask.at, now) : null

  return (
    <section aria-label="Work in this workspace" className="mb-5 flex flex-col gap-1 rounded-md border border-subtle bg-card px-3 py-2" data-workspace-work>
      {(projectName || focus) && (
        <p className="flex min-w-0 items-center gap-1.5 text-body-sm">
          {projectName && (
            <>
              <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-tertiary" />
              <span className="shrink-0 text-foreground" data-workspace-project-name>
                {projectName}
              </span>
            </>
          )}
          {projectName && focus && <span className="text-tertiary">·</span>}
          {focus && (
            <span className="min-w-0 truncate text-muted-foreground" title={focus}>
              <span className="text-tertiary">Focus </span>
              {focus}
            </span>
          )}
        </p>
      )}
      {lastTask ? (
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon connector={lastTask.provider} size="xs" />
          <p className="min-w-0 flex-1 truncate text-body-sm text-muted-foreground" title={lastTask.task}>
            {agentDisplayName(lastTask.provider)}
            <span className="text-tertiary"> · </span>
            <span className={cn(lastTask.attention ? "text-link" : "text-foreground")}>{lastTaskStateLabel(lastTask)}</span>
            <span className="text-tertiary"> · </span>
            {lastTask.headline}
            {lastTask.task && <span className="text-tertiary"> · “{lastTask.task}”</span>}
            {when && <span className="text-tertiary"> · {when}</span>}
          </p>
          {onOpenTask && (
            <Button type="button" size="xs" variant="secondary" onClick={() => onOpenTask(lastTask.sessionId)} aria-label={`Open ${agentDisplayName(lastTask.provider)}'s last task`}>
              Open
            </Button>
          )}
        </div>
      ) : (
        onOpenCommandCentre && (
          <div>
            <Button type="button" size="xs" variant="ghost" className="-ml-2" onClick={onOpenCommandCentre}>
              Give an agent a task
            </Button>
          </div>
        )
      )}
    </section>
  )
}
