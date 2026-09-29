import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { resetConnectorManager } from "@/lib/agents/connectors/app-manager"
import { setStorageNamespace } from "@/lib/storage/namespace"
import { ProvidersSection } from "./system-sections"

/**
 * Settings → Providers when this user's credentials cannot be listed.
 *
 * Only a 503 is a claim about the deployment. A 401 comes after the route has
 * found its credential store, so a signed-out visitor is told to sign in to
 * Hubble — not that the deployment cannot store credentials.
 */

function respond(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: "x", message: "x" } }), { status }))
  )
}

beforeEach(() => {
  window.localStorage.clear()
  setStorageNamespace(null)
  resetConnectorManager()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetConnectorManager()
  window.localStorage.clear()
})

describe("Settings → Providers, when the list cannot be read", () => {
  it("tells a signed-out visitor (401) to sign in to Hubble", async () => {
    respond(401)
    render(<ProvidersSection />)

    expect(await screen.findByText("Sign in to Hubble to save your own provider credentials.")).toBeTruthy()
    expect(screen.queryByText(/cannot store provider credentials/i)).toBeNull()
    expect(screen.queryByText(/No provider on this deployment accepts a credential yet/i)).toBeNull()
  })

  it("still says the deployment cannot store credentials when it cannot (503)", async () => {
    respond(503)
    render(<ProvidersSection />)

    expect(await screen.findByText(/This deployment cannot store provider credentials/)).toBeTruthy()
    expect(screen.queryByText(/Sign in to Hubble/)).toBeNull()
  })
})
