"use client"

import { useMemo, useState } from "react"
import { FolderPlus } from "lucide-react"
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
import { Select } from "@/components/ui/select"
import { AgentIcon } from "@/components/agents/agent-icon"
import { canCreateSession, providerUnavailableReason } from "@/lib/agents/command-centre/presentation"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import { cn } from "@/lib/utils"
import type { AddProjectInput, AddProjectOutcome } from "@/hooks/use-agent-projects"
import type { AgentProject } from "@/lib/agents/control/projects"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { RuntimeProviderStatus } from "@/lib/agents/runtime/protocol"

/**
 * Starting a session: an agent, a project, and nothing else.
 *
 * ## Why the project is chosen and the path is not
 *
 * `create_session` names a project by **id**; the protocol has no field for a
 * path, a working directory or a root, and the host resolves the id against
 * projects the user authorized. So the dialog's project control is a list of
 * things already authorized — never a free-text directory.
 *
 * Authorizing a folder *is* possible here, through a second, explicit step
 * with its own button and its own validation, because a user with no projects
 * yet would otherwise be stuck at a dropdown with nothing in it. That step is
 * where a path is typed, and it is deliberately a different action from
 * starting a session: connecting a folder and letting an agent work in it are
 * two decisions, and the control plane keeps them separate too.
 *
 * ## Why unavailable providers are shown rather than hidden
 *
 * A provider that cannot start a session — no adapter, or no declared
 * `create_session` capability, which is Codex's situation today — appears as a
 * disabled row that says why. Hiding it would leave the user wondering whether
 * TabDump supports it at all; offering it would produce a failure the user
 * could not have predicted.
 */
export function NewSessionDialog({
  open,
  onOpenChange,
  providers,
  projects,
  onAddProject,
  onCreate,
  creating,
  error,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: readonly RuntimeProviderStatus[]
  projects: readonly AgentProject[]
  onAddProject: (input: AddProjectInput) => AddProjectOutcome
  onCreate: (input: { provider: AgentProviderId; projectId?: string; title?: string }) => void
  creating: boolean
  /** A sentence from the runtime's refusal of the last attempt. */
  error?: string
}) {
  const startable = useMemo(() => providers.filter(canCreateSession), [providers])

  const [provider, setProvider] = useState<AgentProviderId | null>(null)
  const [projectId, setProjectId] = useState<string>("")
  const [title, setTitle] = useState("")

  const [addingProject, setAddingProject] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [projectPath, setProjectPath] = useState("")
  const [projectError, setProjectError] = useState<string | null>(null)

  const chosen = provider ?? startable[0]?.provider ?? null

  function submitProject() {
    if (!chosen) return

    const outcome = onAddProject({
      name: projectName,
      path: projectPath,
      // Authorized for the agent being set up, not for every provider that is
      // connected — `AgentProject.providers` is an explicit list for exactly
      // this reason.
      providers: [chosen],
    })

    if (!outcome.ok) {
      setProjectError(outcome.message)
      return
    }

    setProjectId(outcome.project.id)
    setProjectName("")
    setProjectPath("")
    setProjectError(null)
    setAddingProject(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New agent session</DialogTitle>
          <DialogDescription>
            Choose an agent and the project it may work in. You can attach TabDump context once the
            session is open.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <fieldset>
            <legend className="text-eyebrow text-tertiary">Agent</legend>
            <div className="mt-1.5 flex flex-col gap-1">
              {providers.length === 0 ? (
                <p className="text-body-sm text-tertiary">No agent providers are registered here.</p>
              ) : (
                providers.map((candidate) => {
                  const reason = providerUnavailableReason(candidate)
                  const identity = agentVisualIdentity(candidate.provider)
                  const selected = chosen === candidate.provider

                  return (
                    <label
                      key={candidate.provider}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-2.5 py-2 transition-colors",
                        reason
                          ? "cursor-not-allowed border-subtle opacity-55"
                          : "cursor-default border-subtle hover:bg-surface-hover",
                        selected && !reason && "border-border bg-surface-selected"
                      )}
                    >
                      <input
                        type="radio"
                        name="agent-provider"
                        className="sr-only"
                        disabled={Boolean(reason)}
                        checked={selected}
                        onChange={() => setProvider(candidate.provider)}
                      />
                      <AgentIcon connector={candidate.provider} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
                        {identity.displayName}
                      </span>
                      {reason && <span className="shrink-0 text-label text-tertiary">{reason}</span>}
                    </label>
                  )
                })
              )}
            </div>
          </fieldset>

          <div>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="session-project" className="text-eyebrow text-tertiary">
                Project
              </label>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setAddingProject((current) => !current)}
              >
                <FolderPlus />
                Authorize a folder
              </Button>
            </div>

            <div className="mt-1.5">
              {projects.length === 0 && !addingProject ? (
                <p className="text-body-sm text-tertiary">
                  No projects authorized yet. The agent can still run, but will not be able to
                  reach files.
                </p>
              ) : (
                projects.length > 0 && (
                  <Select
                    value={projectId}
                    onValueChange={setProjectId}
                    placeholder="No project"
                    options={[
                      { value: "", label: "No project" },
                      ...projects.map((project) => ({ value: project.id, label: project.name })),
                    ]}
                  />
                )
              )}
            </div>

            {addingProject && (
              <div className="mt-2 flex flex-col gap-2 rounded-md border border-subtle bg-surface p-2.5">
                <div className="flex flex-col gap-1">
                  <label htmlFor="project-name" className="text-label text-tertiary">
                    Name
                  </label>
                  <Input
                    id="project-name"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="TabDump"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="project-path" className="text-label text-tertiary">
                    Folder
                  </label>
                  <Input
                    id="project-path"
                    value={projectPath}
                    onChange={(event) => setProjectPath(event.target.value)}
                    placeholder="/Users/you/code/tabdump"
                    className="font-mono"
                  />
                  {/*
                    The honest limitation, stated where the decision is made.

                    A browser-served runtime has no trusted path source, so
                    TabDump validates the shape of what is typed and cannot
                    confirm it is the folder the user meant. Phase F names a
                    native folder picker as the fix.
                  */}
                  <p className="text-body-sm text-tertiary">
                    Type the full path. TabDump checks it is a real project folder, not a drive or
                    your home directory.
                  </p>
                </div>
                {projectError && <p className="text-body-sm text-destructive">{projectError}</p>}
                <div className="flex justify-end gap-1.5">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAddingProject(false)}>
                    Cancel
                  </Button>
                  <Button type="button" size="sm" onClick={submitProject} disabled={!chosen}>
                    Authorize
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="session-title" className="text-eyebrow text-tertiary">
              Title <span className="text-tertiary">· optional</span>
            </label>
            <Input
              id="session-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What this session is for"
            />
          </div>

          {error && <p className="text-body-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!chosen || creating}
            onClick={() =>
              chosen &&
              onCreate({
                provider: chosen,
                ...(projectId ? { projectId } : {}),
                ...(title.trim() ? { title: title.trim() } : {}),
              })
            }
          >
            {creating ? "Starting…" : "Start session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
