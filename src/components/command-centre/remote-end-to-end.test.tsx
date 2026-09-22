import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandCentreView } from "./command-centre-view"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { createRuntimeClient } from "@/lib/agents/runtime/client"
import { createRuntimeHost } from "@/lib/agents/runtime/host"
import { createRemoteBindings } from "@/lib/agents/remote/bindings"
import { createFakeSandboxService } from "@/lib/agents/remote/__fixtures__/sandbox"
import { createMemoryRemoteStore } from "@/lib/agents/remote/store"
import { createRemoteProject } from "@/lib/agents/remote/projects"
import { createClaudeCodeControlAdapter } from "@/lib/agents/control/providers/claude-code/adapter"
import { createRemoteClaudeRuntime } from "@/lib/agents/control/providers/claude-code/remote-runtime"
import { assistantText, systemInit } from "@/lib/agents/control/providers/claude-code/__fixtures__/scripted-runtime"
import { REMOTE_WORKSPACE_ROOT } from "@/lib/agents/remote/types"
import { parseRuntimeRequest } from "@/lib/agents/runtime/protocol"
import type { FakeSandboxService } from "@/lib/agents/remote/__fixtures__/sandbox"
import type { RemoteStore } from "@/lib/agents/remote/store"
import type { ExecutionGateResult } from "@/lib/agents/runtime/gate"
import type { RuntimeActor } from "@/lib/agents/runtime/host"
import type { AgentContextWorld } from "@/lib/agents/context/world"

/**
 * The whole hosted flow, joined end to end.
 *
 * ## Why this file exists beside the other two
 *
 * `remote-session.test.tsx` proves the UI issues the right command.
 * `remote-runtime.test.ts` proves the runtime does the right thing with one.
 * Between them sits a seam — a scripted client on one side, a hand-made
 * command on the other — and "the UI exists and the backend exists" is
 * precisely the claim that can be true while the product does not work.
 *
 * So nothing is scripted here. The component talks to a real
 * `RuntimeClient`, whose transport dispatches into a real `RuntimeHost` in
 * remote mode, which resolves a real `ControlService`, which drives the real
 * `ClaudeCodeControlAdapter`, which drives the real `RemoteClaudeRuntime`.
 * Creating a project runs the real `createRemoteProject` against the real
 * store and the real upload validator.
 *
 * The only fake is the cloud platform itself — `RemoteSandboxService` — which
 * is a real implementation of the real seam rather than a mock, so the
 * lifecycle exercised here is the lifecycle production has.
 *
 * ## Every host is a new one
 *
 * A fresh `RuntimeHost` per request, because that is what a serverless
 * deployment is. If any of this only works because two commands shared a
 * process, these tests fail.
 */

const OWNER = "account:alice"
const ACTOR: RuntimeActor = { id: OWNER }
const SANDBOX_ENV = { ANTHROPIC_API_KEY: "sk-ant-e2e" }

const REMOTE_GATE: ExecutionGateResult = {
  allowed: true,
  environment: "remote",
  kind: "remote",
  decision: { allowed: true, kind: "remote-sandbox" },
}

let store: RemoteStore
let sandbox: FakeSandboxService

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

/** One request's worth of runtime, exactly as `server.ts` builds it for a remote actor. */
function newHost() {
  const adapter = createClaudeCodeControlAdapter({
    runtime: createRemoteClaudeRuntime({ sandbox, store, ownerId: ACTOR.id, env: SANDBOX_ENV }),
  })

  return createRuntimeHost({
    gate: REMOTE_GATE,
    resolveAdapter: (provider) => (provider === "claude-code" ? adapter : undefined),
    remote: createRemoteBindings({ store }),
    providers: ["claude-code"],
    // Stable across requests, as a deployment id is. A fresh one per host
    // would make the client re-handshake on every command.
    runtimeId: "remote-e2e",
  })
}

/**
 * The transport the browser's runtime client uses.
 *
 * Stands in for the HTTP hop and nothing else: it parses the body with the
 * *real* `parseRuntimeRequest`, so a command the protocol would refuse is
 * refused here too, and dispatches into a brand-new host.
 */
function runtimeTransport(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = parseRuntimeRequest(JSON.parse(String(init?.body ?? "{}")))
    if (!parsed) return new Response(JSON.stringify({ ok: false, error: { code: "invalid_request", message: "no" } }))

    const result = await newHost().execute(ACTOR, parsed.command as never)
    return new Response(JSON.stringify(result), { status: 200 })
  }) as typeof fetch
}

/** The remote-projects resource, backed by the real creation flow. */
function projectsTransport(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"

    if (method === "GET") {
      const projects = await store.listProjects(OWNER)
      return new Response(
        JSON.stringify({
          ok: true,
          value: {
            projects: projects.map((project) => ({
              id: project.id,
              name: project.name,
              source: project.source,
              scopes: project.scopes,
              status: project.status,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            })),
          },
        }),
        { status: 200 }
      )
    }

    const form = init?.body as FormData
    const files = await Promise.all(
      form.getAll("files").map(async (entry) => {
        const file = entry as File
        return {
          // The filename the browser sent is the relative path, exactly as the
          // real route reads it back.
          path: file.name,
          content: new Uint8Array(await file.arrayBuffer()),
        }
      })
    )

    // The real function: real limits, real upload validation, real sandbox
    // lifecycle, real store write.
    const created = await createRemoteProject(
      { store, sandbox },
      {
        ownerId: OWNER,
        name: String(form.get("name")),
        scopes: String(form.get("scopes") ?? "").split(",").filter(Boolean),
        files,
      }
    )

    if (!created.ok) {
      return new Response(JSON.stringify({ ok: false, error: { code: created.reason, message: "no" } }), {
        status: 400,
      })
    }

    return new Response(
      JSON.stringify({
        ok: true,
        value: {
          id: created.project.id,
          name: created.project.name,
          source: created.project.source,
          scopes: created.project.scopes,
          status: created.project.status,
          createdAt: created.project.createdAt,
          excluded: created.excluded,
        },
      }),
      { status: 200 }
    )
  }) as typeof fetch
}

function renderCentre() {
  return render(
    <CommandCentreView
      world={world()}
      onClose={vi.fn()}
      client={createRuntimeClient({ fetch: runtimeTransport() })}
      remoteFetch={projectsTransport()}
      poll={false}
    />
  )
}

/** A `File` carrying the relative path a directory picker would set. */
function upload(path: string, contents = "export const x = 1\n"): File {
  const file = new File([contents], path)
  Object.defineProperty(file, "webkitRelativePath", { value: path })
  return file
}

beforeEach(() => {
  window.localStorage.clear()
  store = createMemoryRemoteStore()
  sandbox = createFakeSandboxService()
})

describe("the hosted flow, from click to sandbox", () => {
  it("creates a project, starts a session, and reaches the remote runtime", async () => {
    const user = userEvent.setup()
    renderCentre()

    // The runtime bar reports the plane it actually resolved.
    expect(await screen.findByText(/REMOTE · Ready/i)).toBeTruthy()

    await user.click((await screen.findAllByRole("button", { name: /new agent session/i }))[0])

    // --- create the remote project ------------------------------------
    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    await user.type(screen.getByLabelText(/^Name$/i), "API service")
    await user.upload(screen.getByLabelText(/project folder/i), [
      upload("src/index.ts"),
      upload("package.json", "{}\n"),
    ])
    await user.click(screen.getByRole("button", { name: /create project/i }))

    // A sandbox was genuinely created and the files genuinely written.
    await waitFor(() =>
      expect(sandbox.calls.some((call) => call.kind === "writeWorkspace")).toBe(true)
    )

    const projects = await store.listProjects(OWNER)
    expect(projects).toHaveLength(1)
    const sandboxName = projects[0].sandboxName
    expect(sandbox.peek(sandboxName)?.files.has("src/index.ts")).toBe(true)
    expect(sandbox.peek(sandboxName)?.files.has("package.json")).toBe(true)

    // --- start the session --------------------------------------------
    await user.click(screen.getByRole("button", { name: /start session/i }))

    // The agent bridge was started, inside *that* project's sandbox, with the
    // provider credential in its environment and nothing else.
    await waitFor(() =>
      expect(sandbox.calls.some((call) => call.kind === "startBridge")).toBe(true)
    )

    const started = sandbox.calls.find((call) => call.kind === "startBridge")!
    expect(started.kind === "startBridge" && started.input.sandboxName).toBe(sandboxName)
    expect(started.kind === "startBridge" && started.input.env).toEqual(SANDBOX_ENV)

    // The bridge's configuration came from the grant the user chose, not from
    // anything the browser could set.
    const config = sandbox.peek(sandboxName)?.config as {
      permissionMode: string
      allowedTools: string[]
    }
    expect(config.permissionMode).toBe("default")
    expect(config.allowedTools.length).toBeGreaterThan(0)

    // A durable session row exists, so the next request can pick it up.
    const sessions = await store.listSessions(OWNER)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].sandboxName).toBe(sandboxName)
    expect(sessions[0].commandId).toBeTruthy()
  })

  it("streams the agent's real output back into the event stream", async () => {
    const user = userEvent.setup()
    renderCentre()

    await user.click((await screen.findAllByRole("button", { name: /new agent session/i }))[0])
    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    await user.type(screen.getByLabelText(/^Name$/i), "API service")
    await user.upload(screen.getByLabelText(/project folder/i), [upload("src/index.ts")])
    await user.click(screen.getByRole("button", { name: /create project/i }))
    await waitFor(() =>
      expect(sandbox.calls.some((call) => call.kind === "writeWorkspace")).toBe(true)
    )

    /*
      The agent's output is put into the sandbox's log *before* the session
      starts, and that is not a shortcut — it is the situation this design
      exists for. A remote agent writes to its log while no serverless
      instance is listening, and what proves the drain works is that the
      output is found by a request that was not running when it was produced.

      Written before rather than after because polling is off in these tests,
      so there is exactly one drain to observe: the one the session's first
      fetch performs.
    */
    const sandboxName = (await store.listProjects(OWNER))[0].sandboxName
    sandbox.emit(sandboxName, { t: "ready" })
    sandbox.emit(sandboxName, {
      t: "message",
      payload: systemInit("provider-session-1", REMOTE_WORKSPACE_ROOT),
    })
    sandbox.emit(sandboxName, {
      t: "message",
      payload: assistantText("provider-session-1", "I read the project."),
    })

    await user.click(screen.getByRole("button", { name: /start session/i }))
    await waitFor(() =>
      expect(sandbox.calls.some((call) => call.kind === "startBridge")).toBe(true)
    )

    // Normalized by the same pipeline a local session uses, sequenced by the
    // same journal, and rendered by a stream that cannot tell where it came
    // from.
    expect(await screen.findByText("I read the project.")).toBeTruthy()
  })

  it("refuses a traversing upload through the real validator, before any sandbox exists", async () => {
    const user = userEvent.setup()
    renderCentre()

    await user.click((await screen.findAllByRole("button", { name: /new agent session/i }))[0])
    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    await user.type(screen.getByLabelText(/^Name$/i), "Sneaky")
    await user.upload(screen.getByLabelText(/project folder/i), [upload("../../etc/passwd")])

    expect(await screen.findByText(/can't be used/i)).toBeTruthy()
    expect(sandbox.calls).toEqual([])
    expect(await store.listProjects(OWNER)).toEqual([])
  })

  it("never lets a filesystem path or sandbox name cross the wire", async () => {
    const sent: string[] = []
    const recording = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""))
      const parsed = parseRuntimeRequest(JSON.parse(String(init?.body ?? "{}")))
      const result = await newHost().execute(ACTOR, parsed!.command as never)
      return new Response(JSON.stringify(result), { status: 200 })
    }) as typeof fetch

    const user = userEvent.setup()
    render(
      <CommandCentreView
        world={world()}
        onClose={vi.fn()}
        client={createRuntimeClient({ fetch: recording })}
        remoteFetch={projectsTransport()}
        poll={false}
      />
    )

    await user.click((await screen.findAllByRole("button", { name: /new agent session/i }))[0])
    await user.click(await screen.findByRole("button", { name: /new remote project/i }))
    await user.type(screen.getByLabelText(/^Name$/i), "API service")
    await user.upload(screen.getByLabelText(/project folder/i), [upload("src/index.ts")])
    await user.click(screen.getByRole("button", { name: /create project/i }))
    await waitFor(() =>
      expect(sandbox.calls.some((call) => call.kind === "writeWorkspace")).toBe(true)
    )
    await user.click(screen.getByRole("button", { name: /start session/i }))
    await waitFor(() =>
      expect(sandbox.calls.some((call) => call.kind === "startBridge")).toBe(true)
    )

    const sandboxName = (await store.listProjects(OWNER))[0].sandboxName
    const everything = sent.join("\n")

    // The browser named a project id and nothing else. Not the workspace root
    // it resolves to, not the sandbox that backs it, not a command.
    expect(everything).not.toContain(REMOTE_WORKSPACE_ROOT)
    expect(everything).not.toContain(sandboxName)
    expect(everything).not.toMatch(/"cwd"|"sandbox|"shell"|"argv"|"path"|"root"/)
    expect(everything).toContain((await store.listProjects(OWNER))[0].id)
  })
})
