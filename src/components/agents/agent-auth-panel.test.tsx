import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentAuthPanel } from "./agent-auth-panel"
import { platformProvider } from "@/lib/agents/platform/catalog"
import type { AgentAuthPanelProps } from "./agent-auth-panel"
import type { UseProviderConnections } from "@/hooks/use-provider-connections"
import type { PlatformProvider } from "@/lib/agents/platform/catalog"
import type { ProviderConnectionView } from "@/lib/agents/runtime/protocol"

/**
 * The provider-neutral authentication panel (Agent Authentication &
 * Runtime). It shows only what the capability model offers on this surface,
 * says why for the rest, never invents account details, and gives every
 * failure its way forward.
 */

const claude = platformProvider("claude-code")!
const gemini = platformProvider("gemini")!
const custom = platformProvider("custom")!

function view(over: Partial<ProviderConnectionView>): ProviderConnectionView {
  return {
    provider: "gemini",
    connection: "connected",
    available: true,
    authentication: "required",
    capabilities: ["create_session"],
    nativeSignIn: true,
    authMethods: [],
    ...over,
  }
}

function renderPanel(over: Partial<AgentAuthPanelProps> & Pick<AgentAuthPanelProps, "provider">) {
  const onSignIn = vi.fn()
  const onRetry = vi.fn()
  render(
    <AgentAuthPanel
      surface="desktop"
      phase="sign_in_required"
      sentence="Needs sign-in."
      asked
      busy={false}
      onSignIn={onSignIn}
      onRetry={onRetry}
      {...over}
    />
  )
  return { onSignIn, onRetry, panel: screen.getByRole("region", { name: "Authentication" }) }
}

function apiKeys(over: Partial<UseProviderConnections> = {}): UseProviderConnections {
  return {
    connections: [],
    connectable: [],
    loading: false,
    failure: null,
    unavailable: false,
    durable: true,
    busy: false,
    refresh: vi.fn(),
    connect: vi.fn(async () => ({ ok: true })),
    rotate: vi.fn(async () => ({ ok: true })),
    revalidate: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => true),
    forProvider: () => undefined,
    connectableFor: () => ({
      provider: "claude-code",
      authMethods: ["api_key"],
      input: {
        label: "Anthropic API key",
        placeholder: "sk-ant-...",
        issueUrl: "https://console.anthropic.com/settings/keys",
        explanation: "Use your own Anthropic API credentials.",
      },
    }),
    ...over,
  } as UseProviderConnections
}

describe("only supported methods", () => {
  it("offers the agent's own sign-in and lists API-key and environment methods as not available, with reasons", async () => {
    const user = userEvent.setup()
    const { panel, onSignIn } = renderPanel({
      provider: gemini,
      status: view({
        authMethods: [
          { id: "oauth-personal", name: "Log in with Google" },
          { id: "gemini-api-key", name: "Use Gemini API key" },
        ],
      }),
    })

    expect(within(panel).getByText(/Gemini CLI can authenticate using your existing Google account/)).toBeTruthy()
    await user.click(within(panel).getByRole("button", { name: "Log in with Google" }))
    expect(onSignIn).toHaveBeenCalledWith("oauth-personal")
    // The API key the agent advertised is never a button.
    expect(within(panel).queryByRole("button", { name: /api key/i })).toBeNull()
    expect(within(panel).getByText("Not available in Hubble (2)")).toBeTruthy()
    expect(within(panel).getByText(/Hubble starts agents with no keys in their environment/)).toBeTruthy()
  })

  it("says so plainly when nothing is offered here", () => {
    const { panel } = renderPanel({ provider: custom, phase: "runtime_unavailable" })
    expect(
      within(panel).getByText("Authentication through Hubble isn't currently supported for Custom MCP agent in the desktop app.")
    ).toBeTruthy()
  })

  it("offers a choice only between supported methods, keyboard-reachable as a radio group", async () => {
    const user = userEvent.setup()
    // A future provider offering two methods on one surface.
    const two: PlatformProvider = {
      ...claude,
      auth: [
        { ...claude.auth[0]!, support: { status: "offered", surfaces: ["desktop"] } },
        claude.auth[1]!,
      ],
    }
    const { panel } = renderPanel({
      provider: two,
      apiKeys: apiKeys(),
      status: view({ provider: "claude-code", authMethods: [{ id: "console", name: "Sign in with Anthropic Console" }] }),
    })
    const group = within(panel).getByRole("radiogroup", { name: "Authentication method" })
    const radios = within(group).getAllByRole("radio")
    expect(radios).toHaveLength(2)
    radios[0]!.focus()
    await user.keyboard("{ArrowDown}")
    expect((radios[1] as HTMLInputElement).checked).toBe(true)
    expect(within(panel).getByRole("button", { name: "Sign in with Anthropic Console" })).toBeTruthy()
  })
})

describe("already authenticated", () => {
  it("says so with the method the runtime reported, and never an account it did not", () => {
    const { panel } = renderPanel({
      provider: claude,
      phase: "awaiting_approval",
      status: view({ provider: "claude-code", authentication: "authenticated", authKind: "account" }),
    })
    expect(within(panel).getByText("Already authenticated")).toBeTruthy()
    expect(within(panel).getByText(/Claude Code is signed in locally/).textContent).toContain("Anthropic Console account")
    expect(within(panel).getByText(/Account authentication is managed by Claude Code/)).toBeTruthy()
    expect(panel.textContent).not.toMatch(/@|org|plan/i)
  })

  it("names no method when the agent only said it is signed in", () => {
    const { panel } = renderPanel({ provider: gemini, phase: "awaiting_approval", status: view({ authentication: "authenticated" }) })
    const line = within(panel).getByText(/Gemini CLI is signed in locally/)
    expect(line.textContent).not.toContain("Google account")
  })
})

describe("API-key authentication", () => {
  it("collects a key only through the secure form, and shows nothing of it afterwards", async () => {
    const user = userEvent.setup()
    const keys = apiKeys()
    const { panel } = renderPanel({ provider: claude, surface: "web", apiKeys: keys, status: undefined, asked: false })
    expect(within(panel).getByText("Claude Code runs on your own Anthropic API key here.")).toBeTruthy()
    await user.click(within(panel).getByRole("button", { name: "Connect Anthropic API key" }))
    const field = within(panel).getByLabelText("Anthropic API key") as HTMLInputElement
    expect(field.type).toBe("password")
    await user.type(field, "sk-ant-test-0123456789abcdef")
    await user.click(within(panel).getByRole("button", { name: /^connect$/i }))
    expect(keys.connect).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude-code", secret: "sk-ant-test-0123456789abcdef" }))
    expect(panel.textContent).not.toContain("sk-ant-test")
  })
})

describe("failures always have a way forward", () => {
  it("timeout: Retry asks again, Setup opens the provider's documentation", async () => {
    const user = userEvent.setup()
    const { panel, onRetry } = renderPanel({ provider: gemini, phase: "timeout", sentence: "Gemini CLI didn't respond in time." })
    expect(within(panel).getByRole("status").textContent).toContain("didn't respond in time")
    await user.click(within(panel).getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalled()
    const setup = within(panel).getByRole("link", { name: /Setup/ })
    expect(setup.getAttribute("href")).toMatch(/^https:\/\//)
    expect(setup.getAttribute("rel")).toContain("noopener")
  })

  it("sign-in failed: Try again restarts the agent's own sign-in", async () => {
    const user = userEvent.setup()
    const { panel, onSignIn } = renderPanel({
      provider: gemini,
      phase: "auth_failed",
      sentence: "Gemini CLI couldn't authenticate.",
      status: view({ authMethods: [{ id: "oauth-personal", name: "Log in with Google" }] }),
    })
    await user.click(within(panel).getByRole("button", { name: "Try again" }))
    expect(onSignIn).toHaveBeenCalledWith("oauth-personal")
  })

  it("a sign-in Hubble cannot use: explains it and offers the permitted method, switching nothing", () => {
    const { panel, onSignIn } = renderPanel({
      provider: claude,
      phase: "auth_unsupported",
      status: view({
        provider: "claude-code",
        authentication: "authenticated",
        authKind: "subscription",
        authIssue: "method_not_permitted",
        authMethods: [{ id: "console", name: "Sign in with Anthropic Console" }],
      }),
    })
    expect(within(panel).getByRole("note").textContent).toMatch(
      /signed in with a Claude subscription, which Hubble can't use[\s\S]*Sign in with Anthropic Console account to use it here/
    )
    expect(within(panel).queryByText("Already authenticated")).toBeNull()
    expect(within(panel).getByRole("button", { name: "Sign in with Anthropic Console" })).toBeTruthy()
    expect(onSignIn).not.toHaveBeenCalled()
  })

  it("hides every sign-in action for an agent Hubble will not start sessions with", () => {
    const { panel } = renderPanel({
      provider: platformProvider("openai-codex")!,
      sessionsBlocked: true,
      status: view({ provider: "openai-codex", authMethods: [{ id: "chat-gpt", name: "ChatGPT" }] }),
    })
    expect(within(panel).queryByRole("button", { name: /ChatGPT/ })).toBeNull()
  })
})
