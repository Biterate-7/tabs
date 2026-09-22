"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { loadControlProjects, saveControlProjects } from "@/lib/agents/control/persistence"
import { createProject, PROJECT_PATH_REJECTION_MESSAGES } from "@/lib/agents/control/projects"
import type { AgentProject, CreateProjectResult } from "@/lib/agents/control/projects"
import type { AgentPermissionScope } from "@/lib/agents/control/permissions"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { AuthorizedProjectInput } from "@/lib/agents/runtime/protocol"

/**
 * The projects this browser has authorized, and their sync to the runtime.
 *
 * ## Why the durable record lives here and not in the host
 *
 * TabDump is local-first: a project is a thing the *user* authorized, and it
 * has to survive a server restart, so it is kept in browser storage exactly as
 * workspaces and collections are (`control/persistence.ts`). The host is told
 * about the set on each connection, because an id means nothing to it until it
 * has been.
 *
 * ## What the sync does and does not establish
 *
 * `authorize_projects` is not a grant of trust. The host re-runs
 * `validateProjectPath` and `createProject` over every record that arrives and
 * drops the ones that fail, so a tampered storage key cannot widen a project
 * into a filesystem root, a home directory or a traversal. What crosses the
 * boundary afterwards is an **id**, and `create_session` has nowhere to put a
 * path at all.
 *
 * The honest limit, which Phase F states and this hook does not paper over: on
 * a browser-served runtime there is no trusted path source to compare against,
 * so TabDump knows the path is *shaped* like a project and not that it is the
 * folder the user meant. A native folder picker is the fix and belongs to a
 * later phase; until then the user types the path themselves and sees exactly
 * what they authorized.
 *
 * ## Why the set is replaced rather than merged
 *
 * The protocol says so, and the reason is revocation: a project the user
 * removed must disappear from the runtime on the next sync. A merge would
 * leave it authorized until the process restarted.
 */

/** What a new project is granted when the user authorizes a folder for an agent. */
export const DEFAULT_PROJECT_SCOPES: readonly AgentPermissionScope[] = [
  "read_workspace",
  "read_project",
  "write_project",
] as const

export type ProjectSyncState = "idle" | "syncing" | "synced" | "failed"

export type AddProjectInput = {
  name: string
  path: string
  providers: readonly AgentProviderId[]
  scopes?: readonly AgentPermissionScope[]
}

export type AddProjectOutcome =
  | { ok: true; project: AgentProject }
  /** A sentence to put under the field. Never a raw reason code. */
  | { ok: false; message: string }

export type AgentProjectsApi = {
  projects: readonly AgentProject[]
  /** Whether the runtime has been told about the current set. */
  syncState: ProjectSyncState
  /** Ids the host refused, with the reason it gave. Empty when everything took. */
  rejected: readonly { id: string; reason: string }[]
  addProject: (input: AddProjectInput) => AddProjectOutcome
  removeProject: (projectId: string) => void
  /** Pushes the current set to the runtime. Called automatically when it changes. */
  sync: () => Promise<void>
}

/**
 * Turns a `createProject` refusal into something a person can act on.
 *
 * The path rejections already have written sentences; the three structural
 * ones do not, because nothing had needed to show them before.
 */
function messageForRejection(result: Extract<CreateProjectResult, { ok: false }>): string {
  switch (result.reason) {
    case "invalid-name":
      return "Give the project a name."
    case "invalid-permissions":
      return "Those permissions do not make sense together."
    case "invalid-additional-directory":
      return "One of the additional folders is not a valid path."
    default:
      return PROJECT_PATH_REJECTION_MESSAGES[result.reason]
  }
}

/** A fresh project id. `crypto.randomUUID` where it exists, which is everywhere this runs. */
function defaultProjectId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `project-${Math.random().toString(36).slice(2)}`
}

/** The protocol's project shape. Timestamps are the host's to set, so they are not sent. */
function toAuthorizedInput(project: AgentProject): AuthorizedProjectInput {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    providers: project.providers,
    additionalDirectories: project.additionalDirectories,
    permissions: {
      scopes: project.permissions.scopes,
      ...(project.permissions.projectId ? { projectId: project.permissions.projectId } : {}),
      grantedAt: project.permissions.grantedAt,
    },
  }
}

export function useAgentProjects(options: {
  client: RuntimeClient
  /**
   * Whether the runtime can be addressed at all.
   *
   * Sync is skipped when it cannot, so a build that cannot run agents does not
   * spend a request per mount being told the same refusal.
   */
  executable: boolean
  /** Changes whenever the host's generation does, which is when a re-sync is required. */
  runtimeId?: string
  now?: () => number
  createId?: () => string
}): AgentProjectsApi {
  const { client, executable, runtimeId } = options

  /*
    Kept as the raw options and resolved inside the callback below.

    Defaulting them here would build a new function identity on every render,
    which would change `addProject`'s dependencies every render and defeat the
    memoisation entirely.
  */
  const nowOption = options.now
  const createIdOption = options.createId

  const [projects, setProjects] = useState<readonly AgentProject[]>(() =>
    typeof window === "undefined" ? [] : loadControlProjects().projects
  )
  const [syncState, setSyncState] = useState<ProjectSyncState>("idle")
  const [rejected, setRejected] = useState<readonly { id: string; reason: string }[]>([])

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const sync = useCallback(async () => {
    if (!executable) return

    setSyncState("syncing")
    const result = await client.send({
      name: "authorize_projects",
      projects: projects.map(toAuthorizedInput),
    })

    if (!mountedRef.current) return

    if (!result.ok) {
      setSyncState("failed")
      return
    }

    setRejected(result.value.rejected)
    setSyncState("synced")
  }, [client, executable, projects])

  /*
    Re-syncs on the two events that invalidate the host's copy: the set
    changed, or the host is a different generation than the one that was told.
  */
  useEffect(() => {
    /*
      Synchronizing with an external system on mount, which is what effects are
      for: which projects the host recognises is the runtime host's to report, and there is no way to
      derive it during render. Same reasoning, and same directive, as
      AuthProvider's hydrate-on-mount effect.
    */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void sync()
  }, [sync, runtimeId])

  const persist = useCallback((next: readonly AgentProject[]) => {
    setProjects(next)
    saveControlProjects({ version: 1, projects: [...next] })
  }, [])

  const addProject = useCallback(
    (input: AddProjectInput): AddProjectOutcome => {
      const id = createIdOption ? createIdOption() : defaultProjectId()
      const grantedAt = nowOption ? nowOption() : Date.now()

      /*
        The grant names the project it applies within.

        `isValidGrant` refuses a project-scoped scope with no `projectId`, and
        a grant that failed validation would make the whole project be dropped
        by the host — authorized-looking and refusing everything.
      */
      const result = createProject(
        {
          id,
          name: input.name,
          path: input.path,
          providers: input.providers,
          permissions: {
            scopes: input.scopes ?? DEFAULT_PROJECT_SCOPES,
            projectId: id,
            grantedAt,
          },
        },
        grantedAt
      )

      if (!result.ok) return { ok: false, message: messageForRejection(result) }

      persist([...projects, result.project])
      return { ok: true, project: result.project }
    },
    [createIdOption, nowOption, persist, projects]
  )

  const removeProject = useCallback(
    (projectId: string) => {
      persist(projects.filter((project) => project.id !== projectId))
    },
    [persist, projects]
  )

  return useMemo(
    () => ({ projects, syncState, rejected, addProject, removeProject, sync }),
    [projects, syncState, rejected, addProject, removeProject, sync]
  )
}
