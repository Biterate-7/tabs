"use client"

import { useRef, useState } from "react"
import { FolderUp, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AGENT_TONE_TEXT_CLASS } from "@/components/agents/agent-tone"
import {
  REMOTE_CREATE_MESSAGE,
  expiresInLabel,
  precheckUpload,
  remoteSourceLabel,
} from "@/lib/agents/command-centre/remote"
import {
  REMOTE_STATUS_DETAIL,
  REMOTE_STATUS_TONE,
  remoteStatusLabel,
} from "@/lib/agents/command-centre/presentation"
import { cn } from "@/lib/utils"
import type {
  RemoteCreateFailure,
  RemoteProjectSummary,
} from "@/lib/agents/command-centre/remote"
import type { AgentPermissionScope } from "@/lib/agents/control/permissions"
import type { CreateRemoteProjectInput, CreateRemoteProjectOutcome } from "@/hooks/use-remote-projects"

/**
 * Choosing, or making, the environment a remote agent works in.
 *
 * ## What this surface is allowed to show
 *
 * A name, what the project was made from, and what its environment is doing.
 * Not a sandbox name, not a path, not an owner id — the API route refuses to
 * serialize those, and `RemoteProjectSummary` has nowhere to put one. A user
 * choosing where their agent will work does not need the handle that addresses
 * a microVM, and showing it would put it in a screenshot.
 *
 * ## The status is never guessed
 *
 * Every row's label comes from the status the server last reported. There is
 * deliberately no optimistic "Ready" while a create is in flight: the project
 * is `creating` until the backend says otherwise, and a picker that said
 * otherwise would let a user start a session against an environment that does
 * not exist yet.
 *
 * ## The permissions question is asked, not assumed
 *
 * A remote project's grant is chosen here, at creation, exactly as a local
 * project's is. "It runs in a disposable microVM" is a statement about who
 * *else* is safe, not about whether this person consented to an agent running
 * commands over their files.
 */

/**
 * The scopes offered at creation.
 *
 * Read and write, and deliberately not `run_commands` or `network_access` as
 * defaults. The first two are what a coding agent needs to be useful; the
 * others are a larger decision, and a checkbox row that pre-selected them
 * would be a consent dialog answering itself.
 */
const OFFERED_SCOPES: readonly { scope: AgentPermissionScope; label: string; detail: string }[] = [
  {
    scope: "read_project",
    label: "Read project files",
    detail: "The agent can open the files you upload.",
  },
  {
    scope: "write_project",
    label: "Change project files",
    detail: "The agent can edit them, with your approval per change.",
  },
  {
    scope: "run_commands",
    label: "Run commands",
    detail: "The agent can run build and test commands inside the environment.",
  },
]

export function RemoteProjectPicker({
  projects,
  loading,
  unavailable,
  selectedId,
  onSelect,
  onCreate,
  creating,
  now,
}: {
  projects: readonly RemoteProjectSummary[]
  loading: boolean
  /** The endpoint could not be read at all — a different thing from having no projects. */
  unavailable: boolean
  selectedId: string
  onSelect: (projectId: string) => void
  onCreate: (input: CreateRemoteProjectInput) => Promise<CreateRemoteProjectOutcome>
  creating: boolean
  now: number
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [scopes, setScopes] = useState<AgentPermissionScope[]>(["read_project", "write_project"])
  const [failure, setFailure] = useState<RemoteCreateFailure | null>(null)
  const [excluded, setExcluded] = useState<readonly string[]>([])
  const input = useRef<HTMLInputElement | null>(null)

  /*
    The folder as the browser reported it, run through the *same* normalizer
    the server uses. Shown before the upload is attempted so a user who picked
    the wrong directory learns immediately rather than after four megabytes.
    Not a security boundary: the server re-validates over the actual bytes.
  */
  const precheck = files.length > 0
    ? precheckUpload(files.map((file) => ({ path: relativePathOf(file), size: file.size })))
    : null

  async function submit() {
    setFailure(null)
    setExcluded([])

    const outcome = await onCreate({ name, scopes, files })
    if (!outcome.ok) {
      setFailure(outcome.reason)
      return
    }

    // Selected immediately, because making a project and then having to find
    // it in a list is a step nobody wanted.
    onSelect(outcome.project.id)
    setExcluded(outcome.excluded)
    setName("")
    setFiles([])
    setAdding(false)
    if (input.current) input.current.value = ""
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-eyebrow text-tertiary">Remote project</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => setAdding((current) => !current)}
        >
          <Plus />
          New remote project
        </Button>
      </div>

      <div className="mt-1.5 flex flex-col gap-1">
        {unavailable ? (
          <p className="text-body-sm text-tertiary">
            Hubble could not load your remote projects.
          </p>
        ) : loading && projects.length === 0 ? (
          <p className="text-body-sm text-tertiary">Loading projects…</p>
        ) : projects.length === 0 && !adding ? (
          <p className="text-body-sm text-tertiary">
            No remote projects yet. Create one to give the agent something to work on.
          </p>
        ) : (
          projects.map((project) => {
            const selected = project.id === selectedId
            const tone = REMOTE_STATUS_TONE[project.status] ?? "muted"
            const expires = expiresInLabel(project.expiresAt, now)

            return (
              <label
                key={project.id}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-md border px-2.5 py-2 transition-colors",
                  "border-subtle hover:bg-surface-hover",
                  selected && "border-border bg-surface-selected"
                )}
              >
                <input
                  type="radio"
                  name="remote-project"
                  className="sr-only"
                  checked={selected}
                  onChange={() => onSelect(project.id)}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body-sm text-foreground">{project.name}</span>
                  <span className="truncate text-label text-tertiary">
                    {remoteSourceLabel(project.source)}
                    {expires ? ` · ${expires}` : ""}
                  </span>
                </span>
                <span
                  className={cn("shrink-0 text-label", AGENT_TONE_TEXT_CLASS[tone])}
                  title={REMOTE_STATUS_DETAIL[project.status] ?? undefined}
                >
                  {remoteStatusLabel(project.status)}
                </span>
              </label>
            )
          })
        )}
      </div>

      {excluded.length > 0 && (
        <p className="mt-1.5 text-body-sm text-tertiary">
          {excluded.length} file{excluded.length === 1 ? "" : "s"} were left out, including
          dependencies and anything that looked like a secret.
        </p>
      )}

      {adding && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-subtle bg-surface p-2.5">
          <div className="flex flex-col gap-1">
            <label htmlFor="remote-project-name" className="text-label text-tertiary">
              Name
            </label>
            <Input
              id="remote-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="API service"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="remote-project-files" className="text-label text-tertiary">
              Project folder
            </label>
            <input
              id="remote-project-files"
              ref={input}
              type="file"
              multiple
              // A directory picker, so a project keeps its shape. Each file's
              // `webkitRelativePath` becomes its path inside the workspace,
              // and every one of those is re-validated server-side.
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
              className="text-body-sm text-muted-foreground file:mr-2 file:rounded-md file:border file:border-subtle file:bg-card file:px-2 file:py-1 file:text-label file:text-foreground"
            />
            {precheck?.ok && (
              <p className="text-body-sm text-tertiary">
                {precheck.files} file{precheck.files === 1 ? "" : "s"} ·{" "}
                {Math.max(1, Math.round(precheck.bytes / 1024))} KB
                {precheck.excluded > 0 ? ` · ${precheck.excluded} will be left out` : ""}
              </p>
            )}
            {precheck && !precheck.ok && (
              <p className="text-body-sm text-destructive">
                {REMOTE_CREATE_MESSAGE[precheck.reason]}
              </p>
            )}
          </div>

          <fieldset>
            <legend className="text-label text-tertiary">What the agent may do</legend>
            <div className="mt-1 flex flex-col gap-1">
              {OFFERED_SCOPES.map((offered) => {
                const checked = scopes.includes(offered.scope)
                return (
                  <label
                    key={offered.scope}
                    className="flex cursor-default items-start gap-2 text-body-sm text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setScopes((current) =>
                          checked
                            ? current.filter((scope) => scope !== offered.scope)
                            : [...current, offered.scope]
                        )
                      }
                      className="mt-0.5"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span>{offered.label}</span>
                      <span className="text-label text-tertiary">{offered.detail}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          {failure && (
            <p className="text-body-sm text-destructive">{REMOTE_CREATE_MESSAGE[failure]}</p>
          )}

          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={submit}
              // Disabled until there is genuinely something to send. A create
              // that would be refused is not offered.
              disabled={creating || !name.trim() || !precheck?.ok}
            >
              <FolderUp />
              {creating ? "Creating…" : "Create project"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The path a browser gave a file. A directory picker sets the first; a file picker does not. */
function relativePathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return typeof relative === "string" && relative ? relative : file.name
}
