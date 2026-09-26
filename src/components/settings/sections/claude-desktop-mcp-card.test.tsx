import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ClaudeDesktopMcpCard, claudeDesktopConfigSnippet } from "./claude-desktop-mcp-card"

const TOKEN = "tdmcp_" + "A".repeat(43)

const VIEW = {
  id: "mcpt_1",
  name: "Work laptop",
  hint: "AAAA",
  scopes: ["read"],
  createdAt: Date.UTC(2026, 8, 1),
  expiresAt: Date.UTC(2026, 11, 1),
  revoked: false,
}

type Call = { method: string; body?: unknown }

function mockServer(options: { status?: number; tokens?: unknown[] } = {}) {
  const calls: Call[] = []
  let tokens = options.tokens ?? []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, body })
      if (options.status) return new Response("{}", { status: options.status })
      if (method === "POST") {
        const connection = { ...VIEW, id: "mcpt_new", name: body.name }
        tokens = [connection, ...tokens]
        return Response.json({ ok: true, value: { token: TOKEN, connection } })
      }
      if (method === "DELETE") {
        tokens = tokens.filter((t) => (t as { id: string }).id !== body.tokenId)
        return Response.json({ ok: true, value: { revoked: true } })
      }
      return Response.json({ ok: true, value: { tokens } })
    })
  )
  return calls
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ClaudeDesktopMcpCard", () => {
  it("asks a signed-out user to sign in", async () => {
    mockServer({ status: 401 })
    render(<ClaudeDesktopMcpCard />)
    expect(await screen.findByText(/Sign in to connect Claude Desktop/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Connect Claude Desktop/ })).toBeNull()
  })

  it("says so when the deployment cannot serve MCP", async () => {
    mockServer({ status: 503 })
    render(<ClaudeDesktopMcpCard />)
    expect(await screen.findByText(/not available on this deployment/)).toBeTruthy()
  })

  it("lists live connections by name and hint, never by token", async () => {
    mockServer({ tokens: [VIEW, { ...VIEW, id: "mcpt_2", name: "Old one", revoked: true }] })
    render(<ClaudeDesktopMcpCard />)
    expect(await screen.findByText("Work laptop")).toBeTruthy()
    expect(screen.getByText(/…AAAA/)).toBeTruthy()
    expect(screen.queryByText("Old one")).toBeNull()
  })

  it("creates a connection and shows the token once, inside the config snippet", async () => {
    const calls = mockServer()
    const user = userEvent.setup()
    render(<ClaudeDesktopMcpCard />)

    await user.click(await screen.findByRole("button", { name: /Connect Claude Desktop/ }))

    const snippet = await screen.findByTestId("mcp-config-snippet")
    expect(snippet.textContent).toContain(TOKEN)
    expect(snippet.textContent).toContain("tabdump-mcp-bridge.mjs")
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Claude Desktop" })

    await user.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() => expect(screen.queryByTestId("mcp-config-snippet")).toBeNull())
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it("revokes a connection", async () => {
    const calls = mockServer({ tokens: [VIEW] })
    const user = userEvent.setup()
    render(<ClaudeDesktopMcpCard />)

    await user.click(await screen.findByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(screen.queryByText("Work laptop")).toBeNull())
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ tokenId: "mcpt_1" })
  })
})

describe("claudeDesktopConfigSnippet", () => {
  it("is a valid Claude Desktop config naming the bridge and the endpoint", () => {
    const config = JSON.parse(claudeDesktopConfigSnippet(TOKEN, "https://tabsdump.vercel.app"))
    expect(config.mcpServers.hubble).toEqual({
      command: "node",
      args: ["<path to Hubble>/scripts/tabdump-mcp-bridge.mjs"],
      env: { TABDUMP_MCP_TOKEN: TOKEN, TABDUMP_MCP_URL: "https://tabsdump.vercel.app/api/mcp" },
    })
  })
})
