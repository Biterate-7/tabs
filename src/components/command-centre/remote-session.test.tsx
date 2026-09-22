import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandCentreView } from "./command-centre-view"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import {
  createScriptedRuntime,
  scriptedStatus,
} from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { RemoteProjectSummary } from "@/lib/agents/command-centre/remote"

/**
 * Starting a remote session, driven through the real command centre.
 *
 * ## Why these go through the whole surface
 *
 * The failure this work is most at risk of is a UI that looks right and
 * reaches nothing — "the dialog exists" is not the requirement. So every
 * assertion about an action below is an assertion about the command the
 * runtime actually received, and the project id that reached it.
 *
 * The remote-projects resource is a REST endpoint rather than the typed
 * command client, so it gets its own injected `fetch`. Nothing here talks to a
 * network, a database or a cloud platform.
 */

const OWNER = "owner-1"

function world(): AgentContextWorld {
  return buildContextWorld({
    ownerId: OWNER,
    workspaces: [
      {
        id: "w1",
        name: "Research",
        createdAt: 0,
        updatedAt: 0,
        tabs: [
          {
            id: "w1-tab-0",
            url: "https://example.com/0",
            normalizedUrl: "https://example.com/0",
            domain: "example.com",
            title: "Tab 0",
          },
        ],
      },
    ],
    collections: [],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

function remoteProject(over: Partial<RemoteProjectSummary> = {}): RemoteProjectSummary {
  return {
    id: "rp-1",
    name: "API service",
    source: "remote_upload",
    scopes: ["read_project", "write_project"],
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

/** A fake of the remote-projects resource. Records every request it received. */
function createRemoteApi(initial: readonly RemoteProjectSummary[] = []) {
  let projects = [...initial]
  const requests: { method: string; body?: FormData | string }[] = []
  let createFailure: { status: number; code: string } | null = null

  const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    requests.push({ method, body: init?.body as FormData | string | undefined })

    if (method === "GET") {
      return new Response(JSON.stringify({ ok: true, value: { projects } }), { status: 200 })
    }

    if (method === "POST") {
      if (createFailure) {
        return new Response(
          JSON.stringify({ ok: false, error: { code: createFailure.code, message: "no" } }),
          { status: createFailure.status }
        )
      }

      const form = init?.body as FormData
      const created = remoteProject({
        id: `rp-${projects.length + 1}`,
        name: String(form.get("name")),
        // Created projects start `ready` here because the *server* said so;
        // the UI never invents that status.
        status: "ready",
      })
      projects = [created, ...projects]
      return new Response(JSON.stringify({ ok: true, value: { ...created, excluded: [] } }), {
        status: 200,
      })
    }

    return new Response(JSON.stringify({ ok: true, value: {} }), { status: 200 })
  }) as typeof fetch

  return {
    transport,
    requests,
    failCreate(status: number, code: string) {
      createFailure = { status, code }
    },
  }
}

type Api = ReturnType<typeof createRemoteApi>

function renderRemote(runtime: ScriptedRuntime, api: Api) {
  return render(
    <CommandCentreView
      world={world()}
      onClose={vi.fn()}
      client={runtime.client}
      remoteFetch={api.transport}
      poll={false}
    />
  )
}

/** A runtime that reports a working remote plane, as a hosted deployment would. */
function remoteRuntime(): ScriptedRuntime {
  return createScriptedRuntime({
    status: scriptedStatus({ environment: "remote", executable: true }),
  })
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /new agent session/i }))
}

beforeEach(() => {
  window.localStorage.clear()
})

/* ------------------------------------------------------------------ *
 * Execution mode
 * ------------------------------------------------------------------ */

describe("execution mode", () => {
  it("offers remote, and never local, on a hosted runtime", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi([remoteProject()])
    renderRemote(remoteRuntime(), api)
    await openDialog(user)

    // Stated, so the user knows where their files are going.
    expect(await screen.findByText(/isolated environment TabDump creates/i)).toBeTruthy()
    // And the local plane is not offered, because it genuinely cannot execute.
    expect(screen.queryByText(/Runs on this machine/i)).toBeNull()
    expect(screen.queryByRole("button", { name: /authorize a folder/i })).toBeNull()
  })

  it("keeps the local flow exactly as it was on a local runtime", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi()
    const runtime = createScriptedRuntime({
      status: scriptedStatus({ environment: "local", executable: true }),
    })
    renderRemote(runtime, api)
    await openDialog(user)

    expect(await screen.findByText(/Runs on this machine/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /authorize a folder/i })).toBeTruthy()
    // No remote project UI, and no request to an endpoint that would 503.
    expect(screen.queryByRole("button", { name: /new remote project/i })).toBeNull()
    expect(api.requests).toEqual([])
  })

  it("does not reach the remote endpoint when the runtime cannot execute", async () => {
    const api = createRemoteApi()
    const runtime = createScriptedRuntime({ status: scriptedStatus({ executable: false }) })
    renderRemote(runtime, api)

    await screen.findByText(/Unavailable/i)
    expect(api.requests).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Selecting a project
 * ------------------------------------------------------------------ */

describe("the remote project selector", () => {
  it("lists the projects the server returned, with human-readable state", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi([
      remoteProject({ id: "rp-1", name: "API service", status: "ready" }),
      remoteProject({ id: "rp-2", name: "Docs site", status: "expired" }),
    ])
    renderRemote(remoteRuntime(), api)
    await openDialog(user)

    expect(await screen.findByText("API service")).toBeTruthy()
    expect(screen.getByText("Docs site")).toBeTruthy()
    expect(screen.getByText("Ready")).toBeTruthy()
    expect(screen.getByText("Expired")).toBeTruthy()
    expect(screen.getAllByText("Uploaded").length).toBe(2)
  })

  it("exposes no sandbox id, path or owner", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi([remoteProject()])
    const { container } = renderRemote(remoteRuntime(), api)
    await openDialog(user)
    await screen.findByText("API service")

    const rendered = container.textContent ?? ""
    expect(rendered).not.toMatch(/tabdump-[a-z0-9]{8}/)
    expect(rendered).not.toContain("/workspace")
    expect(rendered).not.toContain(OWNER)
  })

  it("starts the session with the selected project's id and nothing else", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi([remoteProject({ id: "rp-7", name: "API service" })])
    const runtime = remoteRuntime()
    renderRemote(runtime, api)
    await openDialog(user)

    await user.click(await screen.findByText("API service"))
    await user.click(screen.getByRole("button", { name: /start session/i }))

    await waitFor(() => {
      const created = runtime.commands.find((command) => command.name === "create_session")
      expect(created).toBeTruthy()
    })

    const created = runtime.commands.find((command) => command.name === "create_session")!
    // By **id**, through the same command a local session uses. No path, no
    // sandbox, no cwd — the protocol has no field for one.
    expect(created).toMatchObject({ provider: "claude-code", projectId: "rp-7" })
    expect(JSON.stringify(created)).not.toContain("/workspace")
    expect(JSON.stringify(created)).not.toMatch(/cwd|sandbox|shell|command/i)
  })
})

/* ------------------------------------------------------------------ *
 * Start gating
 * ------------------------------------------------------------------ */

describe("the start button", () => {
  it("is disabled with no project selected, and says why", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi([remoteProject()])
    const runtime = remoteRuntime()
    renderRemote(runtime, api)
    await openDialog(user)

    await screen.findByText("API service")
    const start = screen.getByRole("button", { name: /start session/i })

    expect(start.hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(/Choose a project for the agent to work in/i)).toBeTruthy()

    // And pressing it reaches nothing.
    await user.click(start)
    expect(runtime.commands.some((command) => command.name === "create_session")).toBe(false)
  })

  it("is disabled while a project's environment is still being created", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi([remoteProject({ status: "creating" })])
    renderRemote(remoteRuntime(), api)
    await openDialog(user)

    await user.click(await screen.findByText("API service"))

    expect(screen.getByRole("button", { name: /start session/i }).hasAttribute("disabled")).toBe(
      true
    )
    expect(screen.getByText(/still being created/i)).toBeTruthy()
  })

  it("names authentication separately from unavailability", async () => {
    // The brief forbids collapsing these: one is an operator's problem and the
    // other is the user's.
    const user = userEvent.setup()
    const api = createRemoteApi([remoteProject()])
    const runtime = createScriptedRuntime({
      status: scriptedStatus({
        environment: "remote",
        executable: true,
        providers: [
          {
            provider: "claude-code",
            connection: "configuration_required",
            available: true,
            authentication: "required",
            capabilities: ["create_session", "message"],
          },
        ],
      }),
    })
    renderRemote(runtime, api)
    await openDialog(user)

    await user.click(await screen.findByText("API service"))

    expect(screen.getByText(/needs to be signed in/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /start session/i }).hasAttribute("disabled")).toBe(
      true
    )
  })

  it("permits an expired project, because starting resumes it", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi([remoteProject({ status: "expired" })])
    const runtime = remoteRuntime()
    renderRemote(runtime, api)
    await openDialog(user)

    await user.click(await screen.findByText("API service"))
    await user.click(screen.getByRole("button", { name: /start session/i }))

    await waitFor(() =>
      expect(runtime.commands.some((command) => command.name === "create_session")).toBe(true)
    )
  })
})

/* ------------------------------------------------------------------ *
 * Creating a project
 * ------------------------------------------------------------------ */

describe("creating a remote project", () => {
  /** A `File` carrying the relative path a directory picker would set. */
  function upload(path: string, contents = "x"): File {
    const file = new File([contents], path.split("/").pop() ?? path)
    Object.defineProperty(file, "webkitRelativePath", { value: path })
    return file
  }

  it("uploads a folder and selects the project the server created", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi()
    const runtime = remoteRuntime()
    renderRemote(runtime, api)
    await openDialog(user)

    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    await user.type(screen.getByLabelText(/^Name$/i), "Fresh project")
    await user.upload(screen.getByLabelText(/project folder/i), [
      upload("proj/src/index.ts"),
      upload("proj/package.json"),
    ])

    await user.click(screen.getByRole("button", { name: /create project/i }))

    // The server was actually asked, as multipart.
    await waitFor(() => expect(api.requests.some((entry) => entry.method === "POST")).toBe(true))
    const post = api.requests.find((entry) => entry.method === "POST")!
    expect(post.body).toBeInstanceOf(FormData)
    expect((post.body as FormData).get("name")).toBe("Fresh project")

    // And the new project is selected, so the user does not have to find it.
    await user.click(screen.getByRole("button", { name: /start session/i }))
    await waitFor(() => {
      const created = runtime.commands.find((command) => command.name === "create_session")
      expect(created).toMatchObject({ projectId: "rp-1" })
    })
  })

  it("refuses an unsafe path before spending a request on it", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi()
    renderRemote(remoteRuntime(), api)
    await openDialog(user)

    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    await user.type(screen.getByLabelText(/^Name$/i), "Sneaky")
    await user.upload(screen.getByLabelText(/project folder/i), [upload("../../etc/passwd")])

    expect(await screen.findByText(/can't be used/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /create project/i }).hasAttribute("disabled")).toBe(
      true
    )
    // Nothing was sent. The server would have refused too; this just saves the
    // round trip.
    expect(api.requests.some((entry) => entry.method === "POST")).toBe(false)
  })

  it("will not create without a name or files", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi()
    renderRemote(remoteRuntime(), api)
    await openDialog(user)

    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    const create = screen.getByRole("button", { name: /create project/i })
    expect(create.hasAttribute("disabled")).toBe(true)

    await user.type(screen.getByLabelText(/^Name$/i), "Named but empty")
    expect(create.hasAttribute("disabled")).toBe(true)
  })

  it("shows the server's error category rather than a generic failure", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi()
    api.failCreate(429, "too-many-sandboxes")
    renderRemote(remoteRuntime(), api)
    await openDialog(user)

    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    await user.type(screen.getByLabelText(/^Name$/i), "One too many")
    await user.upload(screen.getByLabelText(/project folder/i), [upload("proj/a.ts")])
    await user.click(screen.getByRole("button", { name: /create project/i }))

    expect(await screen.findByText(/maximum number of remote projects/i)).toBeTruthy()
  })

  it("reports a sandbox failure as its own category", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi()
    api.failCreate(400, "sandbox-failed")
    renderRemote(remoteRuntime(), api)
    await openDialog(user)

    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    await user.type(screen.getByLabelText(/^Name$/i), "Doomed")
    await user.upload(screen.getByLabelText(/project folder/i), [upload("proj/a.ts")])
    await user.click(screen.getByRole("button", { name: /create project/i }))

    expect(await screen.findByText(/could not create the remote environment/i)).toBeTruthy()
    // And no project was added to the list on a failure.
    expect(screen.queryByText("Doomed")).toBeNull()
  })

  it("asks what the agent may do rather than assuming a grant", async () => {
    // A disposable microVM is a statement about who else is safe, not about
    // whether this person consented.
    const user = userEvent.setup()
    const api = createRemoteApi()
    renderRemote(remoteRuntime(), api)
    await openDialog(user)

    await user.click(await screen.findByRole("button", { name: /new remote project/i }))

    expect(screen.getByLabelText(/Read project files/i)).toBeTruthy()
    expect(screen.getByLabelText(/Change project files/i)).toBeTruthy()
    // Running commands is a larger decision and is not pre-selected.
    expect((screen.getByLabelText(/Run commands/i) as HTMLInputElement).checked).toBe(false)
  })

  it("sends only the scopes the user left checked", async () => {
    const user = userEvent.setup()
    const api = createRemoteApi()
    renderRemote(remoteRuntime(), api)
    await openDialog(user)

    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    await user.type(screen.getByLabelText(/^Name$/i), "Read only")
    await user.click(screen.getByLabelText(/Change project files/i))
    await user.upload(screen.getByLabelText(/project folder/i), [upload("proj/a.ts")])
    await user.click(screen.getByRole("button", { name: /create project/i }))

    await waitFor(() => expect(api.requests.some((entry) => entry.method === "POST")).toBe(true))
    const post = api.requests.find((entry) => entry.method === "POST")!
    expect((post.body as FormData).get("scopes")).toBe("read_project")
  })
})

/* ------------------------------------------------------------------ *
 * Context stays separate
 * ------------------------------------------------------------------ */

describe("project scope and TabDump context stay separate", () => {
  it("does not attach any context merely because a remote project was chosen", async () => {
    // Phase E's rule: the project is execution scope, context is
    // informational, and the user chooses the second explicitly.
    const user = userEvent.setup()
    const api = createRemoteApi([remoteProject()])
    const runtime = remoteRuntime()
    renderRemote(runtime, api)
    await openDialog(user)

    await user.click(await screen.findByText("API service"))
    await user.click(screen.getByRole("button", { name: /start session/i }))

    await waitFor(() =>
      expect(runtime.commands.some((command) => command.name === "create_session")).toBe(true)
    )

    const created = runtime.commands.find((command) => command.name === "create_session")!
    expect("context" in created).toBe(false)
    expect(runtime.commands.some((command) => command.name === "attach_context")).toBe(false)
  })
})
