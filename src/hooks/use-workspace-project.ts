"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { describeProject } from "@/lib/agents/project/describe"
import { readProjectInspection } from "@/lib/agents/project/inspection"
import { workspaceProjectState } from "@/lib/agents/project/present"
import { workspaceProjectId } from "@/lib/workspace/project"
import type { AgentCapability } from "@/lib/agents/control/capabilities"
import type { AgentProject } from "@/lib/agents/control/projects"
import type { ProjectDescriptor } from "@/lib/agents/project/describe"
import type { ProjectInspection } from "@/lib/agents/project/inspection"
import type { WorkspaceProjectState } from "@/lib/agents/project/present"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { RuntimeStatus } from "@/lib/agents/runtime/protocol"
import type { Workspace } from "@/lib/workspace/types"

/**
 * A workspace's project, where it stands, and how an agent would be told it
 * (Hubble 1.6) — one derivation for the context panel, New session, the
 * Context Pack and the handoff.
 *
 * ## What it asks the runtime, and when
 *
 * `inspect_project` — by id; the runtime alone holds the path — when the
 * project is attached or changes, when the runtime is a new generation, when
 * the window regains focus (the project may have been edited elsewhere), and
 * when `refreshKey` changes (an agent's change was measured). Each answer
 * replaces the last; a stale answer for another project is dropped.
 *
 * ## What it never claims
 *
 * A browser or hosted Hubble has no runtime that can reach local files
 * (`status.projects` is absent), and is told so — "unsupported" — rather than
 * shown a project it cannot reach.
 */
export type WorkspaceProjectApi = {
  /** The project the workspace names, if this device still has it. */
  project: AgentProject | undefined
  /** The workspace names a project. */
  attached: boolean
  inspection: ProjectInspection | null
  state: WorkspaceProjectState
  /** As the Context Pack and an agent would be told it — for `providerCapabilities`, or the grant. */
  describe: (providerCapabilities?: readonly AgentCapability[]) => ProjectDescriptor | undefined
  /** Looks again now. */
  refresh: () => void
  /** Looks at any authorized project (the attach preview), without attaching it. */
  inspect: (projectId: string, workspaceId?: string) => Promise<InspectOutcome>
  /** Whether this environment can reach local projects at all. `undefined` while it is being asked. */
  supported: boolean | undefined
}

/** What looking at a project found: the inspection, or the state that says why there is none. */
export type InspectOutcome = { ok: true; inspection: ProjectInspection } | { ok: false; state: WorkspaceProjectState }

export function useWorkspaceProject(options: {
  client: RuntimeClient
  status: RuntimeStatus | null
  executable: boolean
  workspace: Pick<Workspace, "id" | "project"> | undefined
  projects: readonly AgentProject[]
  /** Project-relative files the context names, whose current state the pack carries. */
  files?: readonly string[]
  /** Changes when the project is known to have changed (a measured agent change). */
  refreshKey?: string | number
  /** Projects the runtime refused when they were synced (`useAgentProjects().rejected`). */
  rejected?: readonly { id: string }[]
}): WorkspaceProjectApi {
  const { client, status, executable, workspace, projects } = options
  const projectId = workspaceProjectId(workspace)
  const project = projectId ? projects.find((candidate) => candidate.id === projectId) : undefined
  const supported = status ? Boolean(status.projects && executable) : undefined
  const filesKey = (options.files ?? []).slice(0, 20).join("\n")

  const [inspection, setInspection] = useState<ProjectInspection | null>(null)
  const [failure, setFailure] = useState<{ projectId: string; state: WorkspaceProjectState } | null>(null)
  // Joined, so a new list with the same ids is the same dependency.
  const rejectedJoined = (options.rejected ?? []).map((entry) => entry.id).join("\n")
  const rejectedIds = useMemo(() => (rejectedJoined ? rejectedJoined.split("\n") : []), [rejectedJoined])
  const [tick, setTick] = useState(0)
  const latest = useRef(0)

  const inspect = useCallback(
    async (id: string, workspaceId?: string): Promise<InspectOutcome> => {
      const command = {
        name: "inspect_project" as const,
        projectId: id,
        ...(workspaceId ? { workspaceId } : {}),
        ...(filesKey && id === projectId ? { files: filesKey.split("\n") } : {}),
      }
      let result = await client.send(command)
      // A runtime that restarted since this page last asked: learn it, and ask once more.
      if (!result.ok && result.error.code === "runtime_disconnected") {
        const handshake = await client.status()
        if (handshake.ok) result = await client.send(command)
      }
      if (result.ok) {
        const read = readProjectInspection(result.value)
        return read ? { ok: true, inspection: read } : { ok: false, state: "unavailable" }
      }
      switch (result.error.code) {
        case "runtime_disconnected":
        case "runtime_unavailable":
          return { ok: false, state: "runtime_disconnected" }
        case "unsupported":
          return { ok: false, state: "unsupported" }
        case "project_scope_violation":
          // Unknown to the runtime: refused when it was synced, or not synced yet.
          return { ok: false, state: rejectedIds.includes(id) ? "unavailable" : "checking" }
        default:
          return { ok: false, state: "unavailable" }
      }
    },
    [client, filesKey, projectId, rejectedIds]
  )

  const runtimeId = status?.runtimeId
  useEffect(() => {
    if (!project || !supported) return
    const call = ++latest.current
    void inspect(project.id, workspace?.id).then((found) => {
      // Only the newest question's answer counts.
      if (call !== latest.current) return
      setInspection(found.ok ? found.inspection : null)
      setFailure(found.ok ? null : { projectId: project.id, state: found.state })
    })
  }, [project, supported, inspect, workspace?.id, runtimeId, tick, options.refreshKey])

  // The project may have been edited elsewhere: look again when the person comes back.
  useEffect(() => {
    if (typeof window === "undefined") return
    const again = () => setTick((value) => value + 1)
    window.addEventListener("focus", again)
    return () => window.removeEventListener("focus", again)
  }, [])

  const current = inspection && project && inspection.projectId === project.id ? inspection : null
  const derived = workspaceProjectState({
    attached: Boolean(projectId),
    known: Boolean(project),
    supported,
    runtimeConnected: Boolean(status) && executable,
    ...(current ? { access: current.state } : {}),
  })
  // Why the last look found nothing, when it did: said, never left as "checking".
  const state = derived === "checking" && failure && failure.projectId === project?.id ? failure.state : derived

  const describe = useCallback(
    (providerCapabilities?: readonly AgentCapability[]) =>
      project
        ? describeProject({
            project,
            ...(current ? { inspection: current } : {}),
            local: Boolean(supported),
            ...(providerCapabilities ? { providerCapabilities } : {}),
          })
        : undefined,
    [project, current, supported]
  )

  const refresh = useCallback(() => setTick((value) => value + 1), [])

  return useMemo(
    () => ({ project, attached: Boolean(projectId), inspection: current, state, describe, refresh, inspect, supported }),
    [project, projectId, current, state, describe, refresh, inspect, supported]
  )
}
