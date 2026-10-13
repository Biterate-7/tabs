import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OAuthConsent } from "./oauth-consent"

vi.mock("@/components/auth/sign-in-dialog", () => ({ SignInDialog: () => null }))

const SEARCH = "?response_type=code&client_id=hbcl_AAAAAAAAAAAAAAAAAAAAAA&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=x&code_challenge_method=S256&state=s1&scope=hubble.write"

const REQUEST = { clientName: "Claude", client: "claude", clientProduct: "Claude", redirectHost: "claude.ai", requestedLevel: "write" }

type Answer = Record<string, unknown>

function mockServer(get: Answer, post: Answer = { ok: true, value: { redirect: "https://claude.ai/api/mcp/auth_callback?code=hbcode_x&state=s1" } }) {
  const posts: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)))
        return Response.json(post)
      }
      expect(url).toBe(`/api/oauth/authorize${SEARCH}`)
      return Response.json(get)
    })
  )
  return posts
}

let assign: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.history.replaceState(null, "", `/oauth/authorize${SEARCH}`)
  assign = vi.fn()
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, search: SEARCH, assign } })
})

afterEach(() => vi.unstubAllGlobals())

describe("OAuthConsent", () => {
  it("shows the client's claim beside the verified host, and asks a signed-out person to sign in", async () => {
    mockServer({ ok: true, value: { valid: true, signedIn: false, request: REQUEST } })
    render(<OAuthConsent />)
    expect(await screen.findByText(/Connect Claude to Hubble\?/)).toBeTruthy()
    expect(screen.getByText("claude.ai")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy()
  })

  it("defaults to read only, requires a workspace, and approves exactly what was chosen", async () => {
    const posts = mockServer({
      ok: true,
      value: { valid: true, signedIn: true, account: { name: "Alice", email: "alice@example.com" }, request: REQUEST, workspaces: [{ id: "w1", name: "Physics", updatedAt: 1 }, { id: "w2", name: "History", updatedAt: 2 }] },
    })
    const user = userEvent.setup()
    render(<OAuthConsent />)
    const approve = await screen.findByRole("button", { name: "Approve" })
    expect((screen.getByRole("radio", { name: /^Read only/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/It asked to save changes too/)).toBeTruthy()
    expect((approve as HTMLButtonElement).disabled).toBe(true)

    await user.click(screen.getByText("Physics"))
    await user.click(approve)
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://claude.ai/api/mcp/auth_callback?code=hbcode_x&state=s1"))
    expect(posts[0]).toMatchObject({ decision: "approve", permission: "read", workspaceIds: ["w1"], params: { client_id: "hbcl_AAAAAAAAAAAAAAAAAAAAAA", state: "s1" } })
  })

  it("denies without choosing anything", async () => {
    const posts = mockServer(
      { ok: true, value: { valid: true, signedIn: true, account: { name: "A", email: "a@x" }, request: REQUEST, workspaces: [] } },
      { ok: true, value: { redirect: "https://claude.ai/api/mcp/auth_callback?error=access_denied" } }
    )
    const user = userEvent.setup()
    render(<OAuthConsent />)
    expect(await screen.findByText(/None of your workspaces is synced/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Deny" }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://claude.ai/api/mcp/auth_callback?error=access_denied"))
    expect(posts[0]).toMatchObject({ decision: "deny" })
  })

  it("never redirects for an unverifiable request", async () => {
    mockServer({ ok: true, value: { valid: false, error: "This app is not registered with Hubble." } })
    render(<OAuthConsent />)
    expect(await screen.findByText("This app is not registered with Hubble.")).toBeTruthy()
    expect(screen.queryByRole("link")).toBeNull()
    expect(assign).not.toHaveBeenCalled()
  })
})
