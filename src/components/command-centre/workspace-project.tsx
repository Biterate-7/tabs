"use client"

import { useState } from "react"
import { FolderGit2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AgentStatusPill } from "@/components/agents/agent-status-pill"
import { ProjectCheckButtons } from "@/components/agents/project-work"
import { PROJECT_STATE_COPY, projectCapabilityLabels, projectKindLine } from "@/lib/agents/project/present"
import { projectCapabilitiesOf } from "@/lib/agents/project/capabilities"
import { gitCountsLine } from "@/lib/agents/project/checks"
import { agentDisplayName } from "@/lib/agents/visual/identity"
import { cn } from "@/lib/utils"
import type { ProjectWorkActions } from "@/components/agents/project-work"
import type { AddProjectInput, AddProjectOutcome } from "@/hooks/use-agent-projects"
import type { AgentProject } from "@/lib/agents/control/projects"
import type { AgentPermissionScope } from "@/lib/agents/control/permissions"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { GitStatusCounts } from "@/lib/agents/project/checks"
import type { ProjectInspection } from "@/lib/agents/project/inspection"
import type { WorkspaceProjectState } from "@/lib/agents/project/present"
import type { InspectOutcome } from "@/hooks/use-workspace-project"
import type { ProjectCapability } from "@/lib/agents/project/capabilities"

/**
 * A workspace's project, in the context panel (Hubble 1.6).
 *
 *     Project                                   Change
 *     ● Connected
 *     hubble
 *     Next.js · Git main
 *     Agent may  Read files · Modify files · asks first · …
 *     Git        3 modified · 1 untracked
 *     Agent changed 2 files
 *
 * Not a dashboard and not a file browser: what the project is, whether an
 * agent can work in it right now, and what it may do there. Every sentence is
 * the canonical one (lib/agents/project/present.ts).
 */

const STATE_TONE = { good: "good", muted: "muted", warn: "bad", bad: "bad" } as const

export function WorkspaceProjectSection({
  state,
  project,
  inspection,
  capabilities,
  git,
  agentChangedFiles,
  checks,
  onAttach,
  onDetach,
  onRetry,
}: {
  state: WorkspaceProjectState
  project?: Pick<AgentProject, "name">
  inspection: ProjectInspection | null
  /** What the session's agent — or, with none, the grant — may do there. */
  capabilities: readonly ProjectCapability[]
  /** The latest Git status the person read, as counts. */
  git?: GitStatusCounts
  /** Files this session's agent changed, as Hubble measured them. */
  agentChangedFiles?: number
  /** A live session's checks. Absent: none can be run from here. */
  checks?: ProjectWorkActions
  onAttach?: () => void
  onDetach?: () => void
  onRetry?: () => void
}) {
  const copy = PROJECT_STATE_COPY[state]
  const kind = inspection ? projectKindLine({ ...(inspection.type ? { type: inspection.type } : {}), ...(inspection.repository ? { repository: inspection.repository } : {}) }) : undefined
  const problem = state !== "connected" && state !== "none" && state !== "unsupported" && state !== "checking"

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-workspace-project={state}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <AgentStatusPill tone={STATE_TONE[copy.tone]} label={copy.label} />
        <div className="flex shrink-0 items-center gap-1">
          {onAttach && state !== "unsupported" && (
            <Button type="button" size="xs" variant="ghost" onClick={onAttach}>
              {project ? "Change" : "Attach project"}
            </Button>
          )}
          {onDetach && project && (
            <Button type="button" size="xs" variant="ghost" onClick={onDetach} aria-label={`Detach ${project.name} from this workspace`}>
              Detach
            </Button>
          )}
        </div>
      </div>

      {project ? (
        <>
          <p className="flex min-w-0 items-center gap-1.5 text-body-sm text-foreground">
            <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-tertiary" />
            <span className="truncate">{project.name}</span>
          </p>
          {kind && <p className="text-meta text-muted-foreground">{kind}</p>}
          <p className={cn("text-meta", problem ? "text-warning" : "text-tertiary")}>
            {problem ? `${copy.title}. ${copy.detail}` : copy.title}
          </p>
          {problem && onRetry && (
            <Button type="button" size="xs" variant="outline" className="self-start" onClick={onRetry}>
              Check again
            </Button>
          )}
          {state === "connected" && capabilities.length > 0 && (
            <div className="flex min-w-0 flex-col">
              <span className="text-meta text-tertiary">Agent may</span>
              <ul aria-label="What the agent may do in this project" className="flex flex-col">
                {projectCapabilityLabels(capabilities).map((label) => (
                  <li key={label} className="text-body-sm text-muted-foreground">
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {git && (
            <p className="text-meta text-muted-foreground">
              <span className="text-tertiary">Git </span>
              {gitCountsLine(git)}
            </p>
          )}
          {agentChangedFiles !== undefined && agentChangedFiles > 0 && (
            <p className="text-meta text-muted-foreground">
              Agent changed {agentChangedFiles} {agentChangedFiles === 1 ? "file" : "files"}
            </p>
          )}
          {checks && state === "connected" && (
            <div className="mt-1 flex flex-col gap-1">
              <span className="text-meta text-tertiary">Checks</span>
              <ProjectCheckButtons actions={checks} />
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-body-sm text-foreground">{copy.title}</p>
          <p className="text-meta text-tertiary">{copy.detail}</p>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Attaching
 * ------------------------------------------------------------------ */

type Step =
  | { kind: "choose" }
  | { kind: "inspecting"; projectId: string }
  | { kind: "review"; projectId: string; inspection: ProjectInspection | null; failure?: WorkspaceProjectState }

/**
 * Attach project → choose (or add) a folder → see what Hubble found → confirm.
 *
 * A folder is only ever one a person chose: picked in the system dialog on
 * the desktop, or typed in full on a local web runtime, and validated by the
 * runtime either way. Attaching grants nothing new: what agents may do there
 * is the project's grant, shown before confirming.
 */
export function AttachProjectDialog({
  open,
  onOpenChange,
  workspaceName,
  projects,
  currentProjectId,
  agents,
  scopesFor,
  onAddProject,
  pickFolder,
  inspect,
  onAttach,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceName: string
  projects: readonly AgentProject[]
  currentProjectId?: string
  /** Agents a new folder is authorized for: the connected ones that start sessions. */
  agents: readonly AgentProviderId[]
  /** What each agent was approved for in Connect Agent. A new folder gets what every chosen agent may do. */
  scopesFor: (provider: AgentProviderId) => readonly AgentPermissionScope[]
  onAddProject: (input: AddProjectInput) => AddProjectOutcome
  pickFolder?: () => Promise<{ path: string; name: string } | null>
  inspect: (projectId: string) => Promise<InspectOutcome>
  onAttach: (projectId: string) => void
}) {
  const [step, setStep] = useState<Step>({ kind: "choose" })
  const [adding, setAdding] = useState(projects.length === 0)
  const [name, setName] = useState("")
  const [path, setPath] = useState("")
  const [error, setError] = useState<string | null>(null)

  const look = (projectId: string) => {
    setStep({ kind: "inspecting", projectId })
    void inspect(projectId).then((found) =>
      setStep(found.ok ? { kind: "review", projectId, inspection: found.inspection } : { kind: "review", projectId, inspection: null, failure: found.state })
    )
  }

  const add = () => {
    // What every chosen agent may do — never more than any one of them was approved for.
    const scopes = agents.length > 0 ? agents.map(scopesFor).reduce((shared, next) => shared.filter((scope) => next.includes(scope))) : []
    const outcome = onAddProject({ name, path, providers: agents, scopes })
    if (!outcome.ok) return setError(outcome.message)
    setError(null)
    setAdding(false)
    look(outcome.project.id)
  }

  const reviewing = step.kind !== "choose" ? projects.find((project) => project.id === step.projectId) : undefined
  const inspection = step.kind === "review" ? step.inspection : null
  const ready = inspection?.state === "ready"
  const found = inspection ? projectKindLine({ ...(inspection.type ? { type: inspection.type } : {}), ...(inspection.repository ? { repository: inspection.repository } : {}) }) : undefined
  const capabilities = reviewing
    ? projectCapabilitiesOf({ grant: reviewing.permissions, projectId: reviewing.id, local: true, checks: Boolean(inspection && inspection.checks.length > 0) })
    : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach a project</DialogTitle>
          <DialogDescription>
            Agents working in {workspaceName} will work on this project. Hubble asks before any file changes.
          </DialogDescription>
        </DialogHeader>

        {step.kind === "choose" ? (
          <div className="flex flex-col gap-3">
            {projects.length > 0 && (
              <ul aria-label="Authorized projects" className="flex flex-col gap-1">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => look(project.id)}
                      className="flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-subtle px-3 py-2 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-body-sm text-foreground">{project.name}</span>
                        <span className="block truncate text-meta text-tertiary">
                          {project.providers.length > 0 ? project.providers.map(agentDisplayName).join(", ") : "No agents yet"}
                        </span>
                      </span>
                      {project.id === currentProjectId && <span className="shrink-0 text-meta text-tertiary">Attached</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {adding ? (
              <div className="flex flex-col gap-2 rounded-md border border-subtle bg-surface p-2.5">
                <label htmlFor="attach-project-name" className="text-label text-tertiary">
                  Name
                </label>
                <Input id="attach-project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Hubble" />
                <label htmlFor="attach-project-path" className="text-label text-tertiary">
                  Folder
                </label>
                {pickFolder ? (
                  <div className="flex items-center gap-2">
                    <Input id="attach-project-path" value={path} readOnly placeholder="No folder chosen" className="font-mono" />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void pickFolder().then((picked) => {
                          if (!picked) return
                          setPath(picked.path)
                          if (!name.trim()) setName(picked.name)
                        })
                      }
                    >
                      Choose folder…
                    </Button>
                  </div>
                ) : (
                  <Input id="attach-project-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/you/code/hubble" className="font-mono" />
                )}
                <p className="text-meta text-tertiary">
                  {agents.length > 0
                    ? `For ${agents.map(agentDisplayName).join(", ")} — each may do only what it was approved for in Connect Agent.`
                    : "Connect an agent first: a folder is authorized for the agents that will work in it."}
                </p>
                {error && <p className="text-body-sm text-destructive">{error}</p>}
                <div className="flex justify-end gap-1.5">
                  {projects.length > 0 && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                      Cancel
                    </Button>
                  )}
                  <Button type="button" size="sm" onClick={add} disabled={agents.length === 0}>
                    Authorize folder
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setAdding(true)}>
                Add a folder…
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2" aria-live="polite">
            <p className="text-body-sm text-foreground">{reviewing?.name ?? "Project"}</p>
            {step.kind === "inspecting" ? (
              <p className="text-meta text-tertiary">{PROJECT_STATE_COPY.checking.title}</p>
            ) : !inspection ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-body-sm text-warning">
                  {PROJECT_STATE_COPY[step.kind === "review" && step.failure ? step.failure : "unavailable"].title}.{" "}
                  {PROJECT_STATE_COPY[step.kind === "review" && step.failure ? step.failure : "unavailable"].detail}
                </p>
                <Button type="button" size="xs" variant="outline" className="self-start" onClick={() => look(step.projectId)}>
                  Check again
                </Button>
              </div>
            ) : ready ? (
              <dl className="flex flex-col gap-1">
                <div>
                  <dt className="text-meta text-tertiary">Hubble found</dt>
                  <dd className="text-body-sm text-foreground">
                    {found ?? "A folder"}
                    {inspection.checks.length > 0 ? ` · ${inspection.checks.length} ${inspection.checks.length === 1 ? "check" : "checks"}` : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-meta text-tertiary">Agents may</dt>
                  <dd className="text-body-sm text-foreground">
                    {capabilities.length > 0 ? projectCapabilityLabels(capabilities).join(" · ") : "Nothing in the project"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-body-sm text-warning">
                {PROJECT_STATE_COPY[inspection.state === "ready" ? "connected" : inspection.state].title}. {PROJECT_STATE_COPY[inspection.state === "ready" ? "connected" : inspection.state].detail}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {step.kind !== "choose" && (
            <Button type="button" variant="ghost" onClick={() => setStep({ kind: "choose" })}>
              Back
            </Button>
          )}
          <Button
            type="button"
            disabled={!ready || step.kind !== "review"}
            onClick={() => {
              if (step.kind !== "review") return
              onAttach(step.projectId)
              onOpenChange(false)
            }}
          >
            Attach project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
