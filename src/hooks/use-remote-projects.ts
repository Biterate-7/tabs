"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { precheckUpload } from "@/lib/agents/command-centre/remote"
import type {
  RemoteCreateFailure,
  RemoteProjectSummary,
  UploadCandidate,
} from "@/lib/agents/command-centre/remote"
import type { AgentPermissionScope } from "@/lib/agents/control/permissions"

/**
 * The browser's handle on remote projects.
 *
 * ## What this is, and what it is not
 *
 * A typed `fetch` wrapper around one resource. It holds no sandbox, no
 * credential and no execution state; it makes no authorization decision; and
 * the only identifier it ever sends or receives for a project is the opaque
 * id the server minted.
 *
 * It is emphatically **not** a second execution path. Creating a project
 * creates a workspace; starting a session against it still goes through the
 * runtime client, the runtime host, the control service and the adapter,
 * exactly as a local session does. `security.test.ts` asserts that this file
 * names none of those.
 *
 * ## Why the upload is prechecked here
 *
 * To avoid spending a four-megabyte request discovering the folder was too
 * big. The server re-validates every path over the actual bytes and its answer
 * is the authoritative one — see `precheckUpload`, which calls the *same*
 * normalizer the server uses rather than a second copy of the rules.
 */

export const REMOTE_PROJECTS_ENDPOINT = "/api/agents/remote-projects"

export type CreateRemoteProjectInput = {
  name: string
  scopes: readonly AgentPermissionScope[]
  /** What a directory picker produced. Paths come from `webkitRelativePath`. */
  files: readonly File[]
}

export type CreateRemoteProjectOutcome =
  | { ok: true; project: RemoteProjectSummary; excluded: readonly string[] }
  | { ok: false; reason: RemoteCreateFailure }

export type UseRemoteProjects = {
  projects: readonly RemoteProjectSummary[]
  loading: boolean
  /** Set when the list could not be read at all. Distinct from a create failure. */
  unavailable: boolean
  creating: boolean
  refresh: () => Promise<void>
  create: (input: CreateRemoteProjectInput) => Promise<CreateRemoteProjectOutcome>
  remove: (projectId: string) => Promise<boolean>
}

/** The path a browser gave a file. A directory picker sets the first; a file picker does not. */
function pathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return typeof relative === "string" && relative ? relative : file.name
}

function candidatesOf(files: readonly File[]): UploadCandidate[] {
  return files.map((file) => ({ path: pathOf(file), size: file.size }))
}

/**
 * Reads the server's refusal code, or falls back to a network failure.
 *
 * Never renders the server's own message: the codes are a closed set and the
 * sentences belong to `REMOTE_CREATE_MESSAGE`, which is fixed text chosen at
 * build time. A message interpolated from a response is how a platform error
 * string reaches a screen.
 */
function failureOf(body: unknown): RemoteCreateFailure {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code
  const known: readonly RemoteCreateFailure[] = [
    "invalid-name",
    "invalid-scopes",
    "too-many-sandboxes",
    "upload-rejected",
    "sandbox-failed",
    "remote-unavailable",
    "upload-too-large",
    "too-many-files",
  ]
  return typeof code === "string" && (known as readonly string[]).includes(code)
    ? (code as RemoteCreateFailure)
    : "network"
}

export function useRemoteProjects(options: {
  /**
   * Whether to talk to the endpoint at all.
   *
   * False on a runtime with no remote plane, so a local Hubble does not spend
   * a request per mount being told 503.
   */
  enabled: boolean
  /** Injected in tests so the hook can be driven without a network. */
  fetch?: typeof fetch
}): UseRemoteProjects {
  const transport = useMemo(
    () => options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    [options.fetch]
  )

  const [projects, setProjects] = useState<readonly RemoteProjectSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [creating, setCreating] = useState(false)

  /*
    A request that resolves after the dialog closed would otherwise warn, and
    worse, resurrect a list for a surface that is gone. The same guard
    `use-agent-runtime` already applies, for the same reason.
  */
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!options.enabled) {
      setProjects([])
      return
    }

    setLoading(true)
    try {
      const response = await transport(REMOTE_PROJECTS_ENDPOINT, {
        method: "GET",
        credentials: "same-origin",
      })
      const body = await response.json()

      if (!live.current) return

      if (!response.ok || !body?.ok) {
        setUnavailable(true)
        setProjects([])
        return
      }

      setUnavailable(false)
      setProjects(body.value.projects as RemoteProjectSummary[])
    } catch {
      // The thrown value is deliberately not read. A network error's message
      // can carry a URL, and a URL can carry a host and a port.
      if (live.current) {
        setUnavailable(true)
        setProjects([])
      }
    } finally {
      if (live.current) setLoading(false)
    }
  }, [options.enabled, transport])

  useEffect(() => {
    /*
      Synchronizing with an external system on mount, which is what effects are
      for: the list of remote projects is the server's to report, and there is
      no way to derive it during render. Same reasoning, and same directive, as
      `use-agent-runtime`'s status effect.
    */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const create = useCallback(
    async (input: CreateRemoteProjectInput): Promise<CreateRemoteProjectOutcome> => {
      if (!input.name.trim()) return { ok: false, reason: "invalid-name" }

      // Cheap, and it saves a doomed multi-megabyte request. Not a security
      // boundary: the server re-validates every path over the actual bytes.
      const precheck = precheckUpload(candidatesOf(input.files))
      if (!precheck.ok) return { ok: false, reason: precheck.reason }

      setCreating(true)
      try {
        const form = new FormData()
        form.set("name", input.name.trim())
        form.set("scopes", input.scopes.join(","))
        for (const file of input.files) {
          // The third argument is the filename the server reads back. Sending
          // the relative path here is what lets a folder keep its shape — and
          // it is a caller-supplied string that the server re-validates.
          form.append("files", file, pathOf(file))
        }

        const response = await transport(REMOTE_PROJECTS_ENDPOINT, {
          method: "POST",
          credentials: "same-origin",
          body: form,
        })
        const body = await response.json()

        if (!response.ok || !body?.ok) return { ok: false, reason: failureOf(body) }

        const project = body.value as RemoteProjectSummary & { excluded?: readonly string[] }
        if (live.current) setProjects((current) => [project, ...current])

        return { ok: true, project, excluded: project.excluded ?? [] }
      } catch {
        return { ok: false, reason: "network" }
      } finally {
        if (live.current) setCreating(false)
      }
    },
    [transport]
  )

  const remove = useCallback(
    async (projectId: string): Promise<boolean> => {
      try {
        const response = await transport(REMOTE_PROJECTS_ENDPOINT, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId }),
        })

        if (!response.ok) return false
        if (live.current) {
          setProjects((current) => current.filter((project) => project.id !== projectId))
        }
        return true
      } catch {
        return false
      }
    },
    [transport]
  )

  return { projects, loading, unavailable, creating, refresh, create, remove }
}
