import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AiIntegrationsSection, connectionBadge } from "./ai-integrations-section"
import { setupSnippets } from "@/lib/integrations/setup"
import { PLATFORM_SURFACES } from "@/lib/integrations/platforms"
import type { ConnectionView } from "@/lib/integrations/service"

const TOKEN = "hbpat_" + "A".repeat(43)
const ORIGIN = "https://hubble-hq.vercel.app"

const WORKSPACES = [
  { id: "ws-physics", name: "Physics project", updatedAt: 1 },
  { id: "ws-history", name: "History essay", updatedAt: 2 },
]

function connection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: "conn_1",
    client: "chatgpt",
    clientName: "ChatGPT",
    label: "ChatGPT",
    method: "oauth",
    permission: "read",
    workspaceIds: ["ws-physics"],
    createdAt: Date.now() - 60_000,
    lastUsedAt: Date.now() - 30_000,
    status: "connected",
    ...overrides,
  }
}

type Call = { url: string; method: string; body?: Record<string, unknown> }

function mockServer(options: { status?: number; connections?: ConnectionView[]; proposals?: unknown[]; testResult?: unknown } = {}) {
  const calls: Call[] = []
  let connections = options.connections ?? []
  let proposals = options.proposals ?? []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      if (options.status) return new Response("{}", { status: options.status })
      if (url === "/api/integrations/connections" && method === "POST") {
        const created = connection({ id: "conn_new", client: body.client, clientName: "Gemini", label: body.label, method: "token", status: "waiting_for_client", lastUsedAt: undefined, token: { hint: "AAAA", expiresAt: Date.now() + 1e9 } })
        connections = [created, ...connections]
        return Response.json({ ok: true, value: { token: TOKEN, connection: created } })
      }
      if (url === "/api/integrations/connections" && method === "DELETE") {
        connections = connections.filter((c) => c.id !== body.connectionId)
        return Response.json({ ok: true, value: { revoked: true } })
      }
      if (url === "/api/integrations/test") return Response.json({ ok: true, value: options.testResult })
      if (url === "/api/integrations/proposals") {
        proposals = proposals.map((p) => ({ ...(p as object), status: body.action === "approve" ? "approved" : "declined" }))
        return Response.json({ ok: true, value: { proposal: proposals[0] } })
      }
      return Response.json({
        ok: true,
        value: { mcpUrl: `${ORIGIN}/api/mcp`, connections, proposals, activity: [], workspaces: WORKSPACES, legacyTokens: [] },
      })
    })
  )
  return calls
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe("AiIntegrationsSection", () => {
  it("asks a signed-out person to sign in (setup required)", async () => {
    mockServer({ status: 401 })
    render(<AiIntegrationsSection />)
    expect(await screen.findByText(/Setup required: sign in/)).toBeTruthy()
  })

  it("says the connection is unavailable when the deployment cannot serve it", async () => {
    mockServer({ status: 503 })
    render(<AiIntegrationsSection />)
    expect(await screen.findByText("Connection unavailable")).toBeTruthy()
  })

  it("shows not connected, and the OAuth setup with the real MCP URL for ChatGPT", async () => {
    mockServer()
    render(<AiIntegrationsSection />)
    expect(await screen.findByText(/Not connected\. Choose an AI client/)).toBeTruthy()
    const guide = screen.getByTestId("surface-chatgpt")
    expect(within(guide).getAllByText(`${ORIGIN}/api/mcp`).length).toBeGreaterThan(0)
    expect(within(guide).getByText(/Developer mode is offered on Plus, Pro, Business, Enterprise and Edu/)).toBeTruthy()
    // Never claims a vendor test that has not happened.
    expect(within(guide).getByText("Not yet tested in this app")).toBeTruthy()
  })

  it("creates a token for the Gemini CLI, shows it once in the snippet, and forgets it on Done", async () => {
    const calls = mockServer()
    const user = userEvent.setup()
    render(<AiIntegrationsSection />)
    await screen.findByText(/Not connected/)
    await user.click(screen.getByRole("radio", { name: "Gemini" }))
    const cli = screen.getByTestId("surface-gemini-cli")
    await user.click(within(cli).getByRole("button", { name: /Gemini CLI/ }))
    const create = within(cli).getByRole("button", { name: "Create token" })
    expect((create as HTMLButtonElement).disabled).toBe(true)
    await user.click(within(cli).getByText("Physics project"))
    await user.click(create)

    await waitFor(() => expect(within(cli).getAllByText(new RegExp(TOKEN)).length).toBeGreaterThan(0))
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ client: "gemini", label: "Gemini CLI", permission: "read", workspaceIds: ["ws-physics"] })
    await user.click(within(cli).getByRole("button", { name: "Done" }))
    await waitFor(() => expect(document.body.textContent).not.toContain(TOKEN))
  })

  it("lists a connection with its real status, runs the test, and disconnects after confirming", async () => {
    const calls = mockServer({
      connections: [connection()],
      testResult: { ok: false, testedAt: 1, steps: [{ id: "handshake", label: "Hubble's MCP endpoint answers", ok: false, detail: "The endpoint did not complete the MCP handshake." }] },
    })
    const user = userEvent.setup()
    render(<AiIntegrationsSection />)
    const row = await screen.findByTestId("connection-conn_1")
    expect(within(row).getByText("Connected · read-only")).toBeTruthy()

    await user.click(within(row).getByRole("button", { name: "Test connection" }))
    expect(await within(row).findByText("Connection test failed")).toBeTruthy()
    expect(within(row).getByText(/did not complete the MCP handshake/)).toBeTruthy()

    await user.click(within(row).getByRole("button", { name: "Disconnect" }))
    await user.click(await screen.findByRole("button", { name: "Disconnect" }))
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.body?.connectionId === "conn_1")).toBe(true))
  })

  it("approves a proposal waiting for the person", async () => {
    const calls = mockServer({
      proposals: [
        {
          proposalId: "prop_1",
          workspaceId: "ws-physics",
          status: "pending",
          tabCount: 3,
          changes: ['Create collection "Relativity" with 3 tabs'],
          steps: [{ kind: "create_collection", line: 'Create collection "Relativity" with 3 tabs', subject: "Relativity", tabs: ["A", "B", "C"], movesFrom: [] }],
          createdAt: Date.now(),
          expiresAt: Date.now() + 1e7,
          client: "claude",
          clientName: "Claude",
          connectionId: "conn_1",
        },
      ],
    })
    const user = userEvent.setup()
    render(<AiIntegrationsSection />)
    const card = await screen.findByTestId("proposal-prop_1")
    expect(within(card).getByText(/Claude proposed 1 change in “Physics project”/)).toBeTruthy()
    await user.click(within(card).getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(calls.find((c) => c.url === "/api/integrations/proposals")?.body).toEqual({ proposalId: "prop_1", action: "approve" }))
  })
})

describe("connection states", () => {
  it("distinguishes every observed state", () => {
    expect(connectionBadge(connection({ status: "waiting_for_client" }), undefined, []).label).toBe("Setup incomplete")
    expect(connectionBadge(connection({ status: "expired" }), undefined, []).label).toBe("Authentication expired")
    expect(connectionBadge(connection({ permission: "write" }), undefined, []).label).toBe("Connected · can save")
    expect(connectionBadge(connection(), { failed: "x" }, []).label).toBe("Connection test failed")
    const denied = [{ id: "a", at: 1, kind: "write", operation: "create_collection", outcome: "denied", actor: "ai_client", connectionId: "conn_1" }] as const
    expect(connectionBadge(connection(), undefined, [...denied]).label).toBe("Permission denied on last request")
  })
})

describe("setup snippets", () => {
  it("every supported product has setup steps and copyable configuration", () => {
    for (const surface of PLATFORM_SURFACES) {
      expect(surface.steps.length, surface.id).toBeGreaterThan(0)
      expect(setupSnippets(surface.id, ORIGIN, TOKEN).length, surface.id).toBeGreaterThan(0)
      expect(surface.docs, surface.id).toMatch(/^https:\/\//)
      expect(surface.verification, surface.id).not.toBe("client")
    }
  })

  it("names the bridge and the endpoint in Claude Desktop's config", () => {
    const [snippet] = setupSnippets("claude-desktop-config", ORIGIN, TOKEN)
    expect(JSON.parse(snippet.text).mcpServers.hubble).toEqual({
      command: "node",
      args: ["<path to Hubble>/scripts/tabdump-mcp-bridge.mjs"],
      env: { TABDUMP_MCP_TOKEN: TOKEN, TABDUMP_MCP_URL: `${ORIGIN}/api/mcp` },
    })
  })

  it("uses each vendor's documented keys", () => {
    expect(JSON.parse(setupSnippets("antigravity", ORIGIN, TOKEN)[0].text).mcpServers.hubble.serverUrl).toBe(`${ORIGIN}/api/mcp`)
    expect(JSON.parse(setupSnippets("gemini-cli", ORIGIN, TOKEN)[1].text).mcpServers.hubble.httpUrl).toBe(`${ORIGIN}/api/mcp`)
    expect(setupSnippets("claude-code", ORIGIN, TOKEN)[0].text).toBe(`claude mcp add --transport http hubble ${ORIGIN}/api/mcp --header "Authorization: Bearer ${TOKEN}"`)
    const grok = setupSnippets("grok-api", ORIGIN, TOKEN)[0].text
    expect(grok).toContain('"server_label": "hubble"')
    expect(grok).toContain('"allowed_tools"')
    expect(grok).not.toContain("save_workspace_note")
    // OAuth products get the URL and nothing secret.
    expect(setupSnippets("chatgpt", ORIGIN, TOKEN)[0].text).toBe(`${ORIGIN}/api/mcp`)
  })
})
