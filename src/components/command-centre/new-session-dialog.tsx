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
import { SegmentedControl } from "@/components/ui/segmented-control"
import { AgentIcon } from "@/components/agents/agent-icon"
import { RemoteProjectPicker } from "./remote-project-picker"
import {
  PERMISSION_SCOPE_LABEL,
  canCreateSession,
  providerUnavailableReason,
} from "@/lib/agents/command-centre/presentation"
import { requiresApproval } from "@/lib/agents/control/permissions"
import {
  EXECUTION_MODE_DETAIL,
  EXECUTION_MODE_LABEL,
  START_BLOCKER_MESSAGE,
  availableModes,
  startBlocker,
} from "@/lib/agents/command-centre/remote"
import { agentDisplayName } from "@/lib/agents/visual/identity"
import { AUTH_METHOD_LABEL } from "@/lib/agents/credentials/types"
import { cn } from "@/lib/utils"
import type { AddProjectInput, AddProjectOutcome } from "@/hooks/use-agent-projects"
import type {
  CreateRemoteProjectInput,
  CreateRemoteProjectOutcome,
} from "@/hooks/use-remote-projects"
import type { ExecutionMode, RemoteProjectSummary } from "@/lib/agents/command-centre/remote"
import type { AgentPermissionScope } from "@/lib/agents/control/permissions"
import type { AgentRequestFailure } from "@/lib/agents/request-failure"
import type { AgentProject } from "@/lib/agents/control/projects"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { ProviderConnectionView } from "@/lib/agents/credentials/types"
import type { RuntimeProviderStatus, RuntimeStatus } from "@/lib/agents/runtime/protocol"

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
 * Hubble supports it at all; offering it would produce a failure the user
 * could not have predicted.
 */
/** Why an agent cannot start a session yet because of its connection, and the fix. */
export type ConnectionBlocker = {
  /** The row's short state: "Not connected", "Sign-in required", "Didn't respond". */
  label: string
  /** What the footer says: "Claude Code needs you to sign in." */
  sentence: string
  /** The one button that fixes it here, when there is one. */
  action?: string
  /**
   * The exact prerequisite, shown under a row that cannot be chosen at all —
   * an agent that is signed in but that Hubble will not start sessions with.
   * A disabled row never reaches the footer, so it says why itself.
   */
  detail?: string
}

export function NewSessionDialog({
  open,
  onOpenChange,
  status,
  providers,
  projects,
  onAddProject,
  remote,
  connectionFor,
  onCreate,
  onConnectProvider,
  creating,
  error,
  now,
  workspaces,
  defaultWorkspaceId,
  defaultTitle,
  connectionBlocker,
  onConnectAgent,
  pickFolder,
  projectScopesFor,
  defaultProvider,
  contextSummaryFor,
  firstMessage,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * The runtime's own report, which is what decides which execution modes
   * exist. Never a build flag and never a guess made in the browser.
   */
  status: RuntimeStatus | null
  providers: readonly RuntimeProviderStatus[]
  projects: readonly AgentProject[]
  onAddProject: (input: AddProjectInput) => AddProjectOutcome
  /** The remote plane's half. Absent on a runtime that has none. */
  remote?: {
    projects: readonly RemoteProjectSummary[]
    loading: boolean
    unavailable: boolean
    /** Why the list could not be read, when it could not. */
    failure?: AgentRequestFailure | null
    creating: boolean
    create: (input: CreateRemoteProjectInput) => Promise<CreateRemoteProjectOutcome>
  }
  /**
   * This user's provider connection for an agent, when they have one.
   *
   * Rendered so the start flow answers "whose credentials is this about to
   * run on?" before anything starts, rather than only when it refuses. The
   * answer is always "yours" — which is the point worth making visible in a
   * product where it could plausibly have been otherwise.
   */
  connectionFor?: (provider: AgentProviderId) => ProviderConnectionView | undefined
  onCreate: (input: {
    provider: AgentProviderId
    projectId?: string
    workspaceId?: string
    title?: string
  }) => void
  /**
   * The Hubble workspaces a session can be associated with (Phase J).
   *
   * The association is recorded on the session and on the agent's roster
   * entry, and it is the workspace context is drawn from. Absent: no choice
   * is offered and the session belongs to no workspace, as before.
   */
  workspaces?: readonly { id: string; name: string }[]
  defaultWorkspaceId?: string
  /** A title the person already typed, kept across a detour to sign in. */
  defaultTitle?: string
  /**
   * Why an agent cannot start a session yet, when the reason is its
   * connection — not approved, not signed in, signed in with a method Hubble
   * cannot use, not answering (Phase J; Agent Authentication & Runtime).
   * `undefined` for an agent that is ready. Absent: no connection gate.
   *
   * `label` is the row's short state, `sentence` what the footer says, and
   * `action` the one button that fixes it ("Connect", "Sign in", "Retry") —
   * absent when nothing here can.
   */
  connectionBlocker?: (provider: AgentProviderId) => ConnectionBlocker | undefined
  /**
   * Opens Connect Agent for a provider that is not ready, with what the
   * person has chosen so far, so it can be handed back when they return.
   */
  onConnectAgent?: (provider: AgentProviderId, intent: { workspaceId?: string; title?: string }) => void
  /**
   * The native folder picker (the desktop app, Phase J.1).
   *
   * When present, a project folder can only be chosen with it: the path field
   * becomes read-only and is filled by the dialog, because the desktop shell
   * refuses to authorize any folder that did not come from its own picker.
   */
  pickFolder?: () => Promise<{ path: string; name: string } | null>
  /**
   * The scopes a newly authorized folder grants for an agent: never more than
   * the agent was approved for when it was connected. Without this, a folder
   * would grant writes to an agent approved only to read, and the session
   * would be refused as exceeding its approval.
   */
  projectScopesFor?: (provider: AgentProviderId) => readonly AgentPermissionScope[]
  /** The agent to start with, when the user already chose one (from the empty state or a request). */
  defaultProvider?: AgentProviderId
  /**
   * What a session in this workspace would be pointed at, in words — the
   * tabs or collection the user brought from the workspace. `undefined`:
   * the whole workspace.
   */
  contextSummaryFor?: (workspaceId: string) => string | undefined
  /** What the user already typed; sent as the session's first message once it can take one. */
  firstMessage?: string
  /**
   * Takes the user to where they connect their own provider credentials.
   *
   * Optional: a surface that has nowhere to send them simply shows the
   * sentence without a button, rather than offering an action that goes
   * nowhere.
   */
  onConnectProvider?: (provider?: AgentProviderId, intent?: { workspaceId?: string; title?: string }) => void
  creating: boolean
  /** A sentence from the runtime's refusal of the last attempt. */
  error?: string
  now: number
}) {
  const startable = useMemo(
    () => providers.filter((candidate) => canCreateSession(candidate) && !connectionBlocker?.(candidate.provider)),
    [providers, connectionBlocker]
  )
  const [workspaceChoice, setWorkspaceChoice] = useState<string | null>(null)
  const workspaceId =
    workspaceChoice ?? (defaultWorkspaceId && workspaces?.some((entry) => entry.id === defaultWorkspaceId)
      ? defaultWorkspaceId
      : "")

  /*
    Which planes this runtime can actually execute in.

    Derived from the host's own status, so a hosted deployment offers Remote
    and never Local — it genuinely cannot execute locally, and offering it
    would produce a failure the user could not have predicted. A local Hubble
    offers Local, exactly as before.
  */
  const modes = useMemo(() => availableModes(status), [status])

  const [provider, setProvider] = useState<AgentProviderId | null>(null)
  const [mode, setMode] = useState<ExecutionMode | null>(null)
  const [projectId, setProjectId] = useState<string>("")
  const [remoteProjectId, setRemoteProjectId] = useState<string>("")
  const [title, setTitle] = useState(defaultTitle ?? "")
  /** What the person has chosen so far, handed back if they leave to sign in. */
  const intent = { ...(workspaceId ? { workspaceId } : {}), ...(title.trim() ? { title: title.trim() } : {}) }

  const [addingProject, setAddingProject] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [projectPath, setProjectPath] = useState("")
  const [projectError, setProjectError] = useState<string | null>(null)

  /*
    An agent that could start if one thing were fixed — signed in, retried —
    stays the choice when nothing else can start, so the dialog says what is
    missing for *it* and offers the fix, rather than "not available". Its
    choice survives the detour (Agent Authentication & Runtime).
  */
  const recoverable = providers.filter(
    (candidate) => canCreateSession(candidate) && Boolean(connectionBlocker?.(candidate.provider)?.action)
  )
  const preferred =
    defaultProvider &&
    [...startable, ...recoverable].some((candidate) => candidate.provider === defaultProvider)
      ? defaultProvider
      : undefined
  const chosen = provider ?? preferred ?? startable[0]?.provider ?? recoverable[0]?.provider ?? null
  const connectionIssue = chosen ? connectionBlocker?.(chosen) : undefined
  /*
    The runtime decides the default, and there is only ever one plane to
    default to: `availableModes` returns what this host can execute in, which
    is one entry or none. An explicit choice wins when a future runtime
    reports both.
  */
  const activeMode = mode ?? modes[0] ?? null
  const chosenStatus = providers.find((candidate) => candidate.provider === chosen)

  const selectedRemote = remote?.projects.find((project) => project.id === remoteProjectId) ?? null

  /*
    What authorizing a folder here would grant, shown before Authorize is
    pressed: the agent's Connect Agent approval, and nothing more. Every scope
    that asks per use says so, and a missing Run commands is named, because
    it is the one a person otherwise discovers only when nothing runs.
  */
  const folderGrant = chosen && projectScopesFor ? projectScopesFor(chosen) : null

  /*
    Whether Start may be pressed, and if not, precisely why.

    One call, and the answer is the sentence shown beside the button. Nothing
    here is a second opinion about permission: every fact consulted was decided
    by the host, and pressing anyway would produce the same refusal with a
    worse message.
  */
  const blocker = startBlocker({
    status,
    provider: chosenStatus,
    mode: activeMode,
    project: activeMode === "remote" ? selectedRemote : null,
  })

  function submitProject() {
    if (!chosen) return

    const outcome = onAddProject({
      name: projectName,
      path: projectPath,
      // Authorized for the agent being set up, not for every provider that is
      // connected — `AgentProject.providers` is an explicit list for exactly
      // this reason.
      providers: [chosen],
      ...(projectScopesFor ? { scopes: projectScopesFor(chosen) } : {}),
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
            Choose an agent. It works in the Hubble workspace below, and in a project folder if it needs files.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {workspaces && workspaces.length > 0 && (
            <div className="flex flex-col gap-1">
              <label htmlFor="session-workspace" className="text-eyebrow text-tertiary">
                Working in
              </label>
              <Select
                value={workspaceId}
                onValueChange={setWorkspaceChoice}
                placeholder="No workspace"
                options={[
                  { value: "", label: "No workspace — no Hubble context" },
                  ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name })),
                ]}
              />
              {workspaceId ? (
                <p className="text-body-sm text-muted-foreground">
                  <span className="text-tertiary">Context · </span>
                  {contextSummaryFor?.(workspaceId) ?? "Whole workspace"}
                </p>
              ) : (
                <p className="text-body-sm text-tertiary">The agent won&apos;t see any of your Hubble workspaces.</p>
              )}
            </div>
          )}

          <fieldset>
            <legend className="text-eyebrow text-tertiary">Agent</legend>
            <div className="mt-1.5 flex flex-col gap-1">
              {providers.length === 0 ? (
                <p className="text-body-sm text-tertiary">No agent providers are registered here.</p>
              ) : (
                providers.map((candidate) => {
                  const unconnected = connectionBlocker?.(candidate.provider)
                  const reason = providerUnavailableReason(candidate) ?? unconnected?.label
                  const agentName = agentDisplayName(candidate.provider)
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
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body-sm text-foreground">{agentName}</span>
                        {unconnected?.detail && (
                          <span className="text-meta text-tertiary">{unconnected.detail}</span>
                        )}
                      </span>
                      {reason && <span className="shrink-0 text-label text-tertiary">{reason}</span>}
                      {/* The one unavailable reason with a fix one click away. */}
                      {/* The chosen agent's fix is in the footer, beside its sentence — once. */}
                      {unconnected?.action && !providerUnavailableReason(candidate) && onConnectAgent && !selected && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => onConnectAgent(candidate.provider, intent)}
                        >
                          {unconnected.action}
                        </Button>
                      )}
                    </label>
                  )
                })
              )}
            </div>
          </fieldset>

          {/*
            Whose credentials the agent runs on.

            Only when there is something true to say. A provider the user has
            not connected is already covered by the blocker sentence at the
            bottom, and saying "Not connected" twice would be noise.
          */}
          {chosen &&
            (() => {
              const connection = connectionFor?.(chosen)
              if (!connection || connection.status !== "connected") return null

              return (
                <div>
                  <p className="text-eyebrow text-tertiary">Provider</p>
                  <p className="mt-1.5 text-body-sm text-muted-foreground">
                    <span className="text-foreground">
                      {AUTH_METHOD_LABEL[connection.authMethod]}
                    </span>
                    {" · "}
                    {/* Accurate about whose credentials these are. Hubble
                        provides the command centre; the user provides the
                        provider. */}
                    Your own credentials
                  </p>
                </div>
              )
            })()}

          {/*
            Where the agent will run.

            Rendered even when there is only one mode, because "this runs on
            your machine" and "this runs in a container we made" are different
            promises about where the user's files are, and a surface that says
            neither leaves them to guess. With one mode it is a statement; with
            two it is a choice.
          */}
          <fieldset>
            <legend className="text-eyebrow text-tertiary">Runs</legend>
            {modes.length === 0 ? (
              <p className="mt-1.5 text-body-sm text-tertiary">
                {START_BLOCKER_MESSAGE["runtime-unavailable"]}
              </p>
            ) : modes.length === 1 ? (
              <p className="mt-1.5 text-body-sm text-muted-foreground">
                <span className="text-foreground">{EXECUTION_MODE_LABEL[modes[0]]}</span>
                {" · "}
                {EXECUTION_MODE_DETAIL[modes[0]]}
              </p>
            ) : (
              <div className="mt-1.5 flex flex-col gap-1.5">
                <SegmentedControl
                  value={activeMode ?? modes[0]}
                  onValueChange={(next) => setMode(next)}
                  options={modes.map((candidate) => ({
                    value: candidate,
                    label: EXECUTION_MODE_LABEL[candidate],
                  }))}
                  size="sm"
                />
                {activeMode && (
                  <p className="text-body-sm text-tertiary">
                    {EXECUTION_MODE_DETAIL[activeMode]}
                  </p>
                )}
              </div>
            )}
          </fieldset>

          {activeMode === "remote" && remote ? (
            <RemoteProjectPicker
              projects={remote.projects}
              loading={remote.loading}
              unavailable={remote.unavailable}
              listFailure={remote.failure ?? null}
              selectedId={remoteProjectId}
              onSelect={setRemoteProjectId}
              onCreate={remote.create}
              creating={remote.creating}
              now={now}
            />
          ) : activeMode === "remote" ? (
            <p className="text-body-sm text-tertiary">
              {START_BLOCKER_MESSAGE["runtime-unavailable"]}
            </p>
          ) : (
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
                    placeholder="Hubble"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="project-path" className="text-label text-tertiary">
                    Folder
                  </label>
                  {pickFolder ? (
                    <div className="flex items-center gap-2">
                      <Input
                        id="project-path"
                        value={projectPath}
                        readOnly
                        placeholder="No folder chosen"
                        className="font-mono"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void pickFolder().then((picked) => {
                            if (!picked) return
                            setProjectPath(picked.path)
                            if (!projectName.trim()) setProjectName(picked.name)
                          })
                        }}
                      >
                        Choose folder…
                      </Button>
                    </div>
                  ) : (
                    <Input
                      id="project-path"
                      value={projectPath}
                      onChange={(event) => setProjectPath(event.target.value)}
                      placeholder="/Users/you/code/hubble"
                      className="font-mono"
                    />
                  )}
                  {/*
                    The honest limitation, stated where the decision is made.

                    A browser-served runtime has no trusted path source, so
                    Hubble validates the shape of what is typed and cannot
                    confirm it is the folder the user meant. Phase F names a
                    native folder picker as the fix.
                  */}
                  <p className="text-body-sm text-tertiary">
                    {pickFolder
                      ? "Choose the folder in the system dialog. Hubble checks it is a real project folder, not a drive or your home directory."
                      : "Type the full path. Hubble checks it is a real project folder, not a drive or your home directory."}
                  </p>
                </div>
                {folderGrant && chosen && (
                  <div data-testid="folder-grant" className="flex flex-col gap-0.5">
                    <p className="text-label text-tertiary">
                      {agentDisplayName(chosen)} may, in this folder
                    </p>
                    {folderGrant.length === 0 ? (
                      <p className="text-body-sm text-muted-foreground">
                        Nothing yet. Choose what it may do in Connect Agent.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {folderGrant.map((scope) => (
                          <li key={scope} className="text-body-sm text-foreground">
                            {PERMISSION_SCOPE_LABEL[scope]}
                            {requiresApproval(scope) && (
                              <span className="text-meta text-tertiary"> · asks every time</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {!folderGrant.includes("run_commands") && (
                      <p className="text-meta text-tertiary">
                        Running commands is off for this agent. Turn it on in Connect Agent to allow it here.
                      </p>
                    )}
                  </div>
                )}
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
          )}

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

          {firstMessage && (
            <div>
              <p className="text-eyebrow text-tertiary">First message</p>
              <p className="mt-1 line-clamp-3 text-body-sm text-muted-foreground">{firstMessage}</p>
            </div>
          )}

          {error && <p className="text-body-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          {/*
            Why the block is stated rather than only enforced.

            A disabled button with no explanation is the failure the brief
            names: the user cannot tell whether the runtime is missing, the
            provider needs signing in, or they simply have not chosen a
            project. Each has a different next step, so each gets its own
            sentence.
          */}
          {/*
            The chosen agent's own connection comes first when it is the
            thing in the way — "Claude Code needs you to sign in. [Sign in]" —
            with the one action that fixes it. The person's choices go with
            them and come back (Agent Authentication & Runtime).
          */}
          {connectionIssue && chosen ? (
            <div className="mr-auto flex min-w-0 items-center gap-2">
              <p role="status" className="min-w-0 text-body-sm text-tertiary">
                {connectionIssue.sentence}
              </p>
              {connectionIssue.action && onConnectAgent && (
                <Button type="button" size="sm" variant="outline" onClick={() => onConnectAgent(chosen, intent)}>
                  {connectionIssue.action}
                </Button>
              )}
            </div>
          ) : blocker && (
            <div className="mr-auto flex min-w-0 items-center gap-2">
              <p className="min-w-0 text-body-sm text-tertiary">
                {START_BLOCKER_MESSAGE[blocker]}
              </p>
              {/*
                The one blocker with a fix the user can reach from here.
                Everything else on the list is a property of the deployment or
                of a project they have already chosen; this one is a button
                they have not pressed yet, and sending them to hunt for it in
                settings is how a product loses somebody at the last step.
              */}
              {blocker === "authentication-required" && onConnectProvider && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onConnectProvider(chosen ?? undefined, intent)}
                >
                  Connect
                </Button>
              )}
            </div>
          )}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!chosen || creating || blocker !== null || Boolean(connectionIssue)}
            onClick={() => {
              if (!chosen || blocker || connectionIssue) return

              /*
                The project the session is scoped to, by **id**, whichever
                plane it came from. `create_session` has no field for a path
                and the host resolves the id against what this actor
                authorized — so a remote id and a local id travel the same way
                and are checked the same way. There is no UI-specific
                execution path here.
              */
              const scopedProjectId = activeMode === "remote" ? remoteProjectId : projectId

              onCreate({
                provider: chosen,
                ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
                ...(workspaceId ? { workspaceId } : {}),
                ...(title.trim() ? { title: title.trim() } : {}),
              })
            }}
          >
            {creating ? "Starting…" : "Start session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
