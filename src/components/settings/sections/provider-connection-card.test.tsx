import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProviderConnectionCard } from "./provider-connection-card"
import type { ConnectionInputShape } from "./provider-connection-card"
import type { ProviderConnectionView } from "@/lib/agents/credentials/types"

/**
 * Settings → AI Connectors → Connection.
 *
 * Three claims are asserted here, and each of them is a product promise rather
 * than an implementation detail:
 *
 *   1. the wording says what is actually happening — "Connect Anthropic API",
 *      not "Connect Claude account";
 *   2. the credential goes into the request and is never displayed back, in
 *      whole or in part;
 *   3. a provider Hubble cannot hold credentials for does not get a button
 *      that would fail.
 */

const T0 = 1_700_000_000_000

/** The shape the server derives from the registry. Not a table in the UI. */
const CLAUDE_INPUT: ConnectionInputShape = {
  label: "Anthropic API key",
  placeholder: "sk-ant-...",
  issueUrl: "https://console.anthropic.com/settings/keys",
  explanation:
    "Use your own Anthropic API credentials. Hubble does not provide a shared Claude account, and your key is only ever used for your own sessions.",
}

const KEY = "sk-ant-api03-DO-NOT-DISPLAY-aaaaaaaa"

function connection(over: Partial<ProviderConnectionView> = {}): ProviderConnectionView {
  return {
    id: "pc-1",
    provider: "claude-code",
    authMethod: "api_key",
    displayName: "Personal key",
    status: "connected",
    createdAt: T0,
    updatedAt: T0,
    lastValidatedAt: T0,
    ...over,
  }
}

function renderCard(over: Partial<React.ComponentProps<typeof ProviderConnectionCard>> = {}) {
  const onConnect = vi.fn(async () => ({ ok: true }))
  const onRotate = vi.fn(async () => ({ ok: true }))
  const onDisconnect = vi.fn(async () => true)

  const props = {
    provider: "claude-code" as const,
    providerName: "Claude Code",
    connection: undefined,
    input: CLAUDE_INPUT,
    unavailable: false,
    durable: true,
    busy: false,
    onConnect,
    onRotate,
    onDisconnect,
    ...over,
  }

  return { onConnect, onRotate, onDisconnect, ...render(<ProviderConnectionCard {...props} />) }
}

describe("the unconnected state", () => {
  it("says whose credentials these are, in the product and not only in the docs", () => {
    renderCard()

    expect(
      screen.getByText(/Hubble does not provide a shared Claude account/i)
    ).toBeTruthy()
    expect(screen.getByText("Not connected")).toBeTruthy()
  })

  it("names the API rather than claiming a Claude account connection", () => {
    renderCard()

    // The distinction is a correctness question: Hubble holds an API
    // credential the user issued themselves, not a delegated grant.
    expect(screen.getByRole("button", { name: /connect anthropic api/i })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /connect claude account/i })).toBeNull()
    expect(screen.queryByText(/sign in with claude/i)).toBeNull()
  })

  it("sends the credential once and never renders it back", async () => {
    const user = userEvent.setup()
    const { onConnect } = renderCard()

    await user.click(screen.getByRole("button", { name: /connect anthropic api/i }))
    await user.type(screen.getByLabelText(/anthropic api key/i), KEY)
    await user.type(screen.getByLabelText(/name/i), "Personal key")
    await user.click(screen.getByRole("button", { name: /^connect$/i }))

    expect(onConnect).toHaveBeenCalledWith({
      provider: "claude-code",
      secret: KEY,
      displayName: "Personal key",
    })

    // The whole rendered document, after a successful submit. Not the field,
    // not a masked prefix, not a length — nothing.
    expect(document.body.textContent).not.toContain(KEY)
    expect(document.body.textContent).not.toContain("DO-NOT-DISPLAY")
  })

  it("uses a password field, so the credential is not shoulder-readable or auto-filled", async () => {
    const user = userEvent.setup()
    renderCard()

    await user.click(screen.getByRole("button", { name: /connect anthropic api/i }))
    const field = screen.getByLabelText(/anthropic api key/i)

    expect(field.getAttribute("type")).toBe("password")
    expect(field.getAttribute("autocomplete")).toBe("off")
  })

  it("shows the normalized failure and keeps the form open", async () => {
    const user = userEvent.setup()
    const { onConnect } = renderCard()
    onConnect.mockResolvedValue({
      ok: false,
      validation: { code: "invalid_credentials", message: "The provider did not accept those credentials." },
    } as never)

    await user.click(screen.getByRole("button", { name: /connect anthropic api/i }))
    await user.type(screen.getByLabelText(/anthropic api key/i), KEY)
    await user.click(screen.getByRole("button", { name: /^connect$/i }))

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByText(/did not accept those credentials/i)).toBeTruthy()
    // Still open, so the user can correct it rather than starting over.
    expect(screen.getByLabelText(/anthropic api key/i)).toBeTruthy()
  })
})

describe("the connected state", () => {
  it("reports the method, the name and when it was last validated", () => {
    renderCard({ connection: connection() })

    expect(screen.getByText("Connected")).toBeTruthy()
    expect(screen.getByText(/Anthropic API · Personal key/)).toBeTruthy()
    expect(screen.getByText(/Last validated/)).toBeTruthy()
  })

  it("offers rotate and disconnect, and no way to reveal the key", () => {
    renderCard({ connection: connection() })

    expect(screen.getByRole("button", { name: /rotate/i })).toBeTruthy()
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeTruthy()

    // Hubble cannot revoke a key from this screen, so showing any of one
    // would buy recognition at the cost of leaking it into every screenshot.
    expect(screen.queryByRole("button", { name: /show|reveal|copy/i })).toBeNull()
  })

  it("tells the user a failed rotation is safe, before they attempt one", async () => {
    const user = userEvent.setup()
    renderCard({ connection: connection() })

    await user.click(screen.getByRole("button", { name: /rotate/i }))

    // The person mid-rotation is exactly the one who needs to know that a
    // rejected replacement does not lock them out.
    expect(screen.getByText(/current credential keeps working/i)).toBeTruthy()
  })

  it("rotates through the connection id rather than re-connecting", async () => {
    const user = userEvent.setup()
    const { onRotate, onConnect } = renderCard({ connection: connection() })

    await user.click(screen.getByRole("button", { name: /rotate/i }))
    await user.type(screen.getByLabelText(/anthropic api key/i), KEY)
    await user.click(screen.getByRole("button", { name: /replace credential/i }))

    expect(onRotate).toHaveBeenCalledWith("pc-1", KEY)
    expect(onConnect).not.toHaveBeenCalled()
  })

  it("surfaces a rejected credential distinctly from a disconnected one", () => {
    renderCard({ connection: connection({ status: "invalid" }) })
    expect(screen.getByText("Credentials rejected")).toBeTruthy()
  })

  it("says when connections will not survive a restart", () => {
    renderCard({ connection: connection(), durable: false })

    // Honest about the memory store, rather than letting somebody discover it
    // after a restart.
    expect(screen.getByText(/this server process only/i)).toBeTruthy()
  })
})

describe("providers Hubble cannot hold credentials for", () => {
  it("says so instead of offering a button that would fail", () => {
    renderCard({ provider: "gemini", providerName: "Gemini", input: undefined })

    expect(screen.getByText("Not supported")).toBeTruthy()
    expect(screen.getByText(/cannot hold credentials for Gemini yet/i)).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("says so when the deployment itself cannot store credentials", () => {
    renderCard({ unavailable: true })

    expect(screen.getByText("Unavailable")).toBeTruthy()
    expect(screen.getByText(/not set up to store provider credentials/i)).toBeTruthy()
    // And never the name of the environment variable that would fix it.
    expect(document.body.textContent).not.toContain("TABDUMP_CREDENTIAL_KEY")
  })
})
