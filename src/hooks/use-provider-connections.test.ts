import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { PROVIDER_CONNECTIONS_ENDPOINT, useProviderConnections } from "./use-provider-connections"
import { agentRequestFailureOf } from "@/lib/agents/request-failure"

/**
 * Why a list of provider connections could not be read, kept apart.
 *
 * The route checks for a credential store before it checks who is asking, so
 * a 503 is a deployment that cannot store credentials and a 401 is a visitor
 * not signed in to one that can. Reporting the 401 as the 503 told signed-out
 * visitors on production that the deployment was misconfigured.
 */

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("agentRequestFailureOf", () => {
  it("maps each status to what it proves, and nothing else to more than 'failed'", () => {
    expect(agentRequestFailureOf(401)).toBe("sign_in_required")
    expect(agentRequestFailureOf(403)).toBe("not_permitted")
    expect(agentRequestFailureOf(503)).toBe("unavailable")
    for (const status of [400, 404, 429, 500, 502, undefined]) expect(agentRequestFailureOf(status)).toBe("failed")
  })
})

describe("useProviderConnections — a list that could not be read", () => {
  it("reports a signed-out visitor (401) as sign-in required, not as a deployment without a credential store", async () => {
    respond(401, { ok: false, error: { code: "sign-in-required", message: "Sign in to connect an agent." } })
    const { result } = renderHook(() => useProviderConnections())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.failure).toBe("sign_in_required")
    expect(result.current.unavailable).toBe(false)
    expect(result.current.connections).toEqual([])
  })

  it("still reports a deployment that cannot store credentials (503) as unavailable", async () => {
    respond(503, { ok: false, error: { code: "credentials-unavailable", message: "x" } })
    const { result } = renderHook(() => useProviderConnections())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.failure).toBe("unavailable")
    expect(result.current.unavailable).toBe(true)
  })

  it("reports a refusal (403) and any other error as what they are", async () => {
    respond(403, { ok: false, error: { code: "invalid-request", message: "x" } })
    const refused = renderHook(() => useProviderConnections())
    await waitFor(() => expect(refused.result.current.loading).toBe(false))
    expect(refused.result.current.failure).toBe("not_permitted")
    expect(refused.result.current.unavailable).toBe(false)
    refused.unmount()

    respond(500, { ok: false })
    const broken = renderHook(() => useProviderConnections())
    await waitFor(() => expect(broken.result.current.loading).toBe(false))
    expect(broken.result.current.failure).toBe("failed")
    expect(broken.result.current.unavailable).toBe(false)
  })

  it("treats a request that never got a response as failed — it proves nothing about the deployment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network")
      })
    )
    const { result } = renderHook(() => useProviderConnections())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.failure).toBe("failed")
    expect(result.current.unavailable).toBe(false)
  })

  it("clears the failure once the list is read", async () => {
    respond(200, { ok: true, value: { connections: [], connectable: [], durable: true } })
    const { result } = renderHook(() => useProviderConnections())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.failure).toBeNull()
    expect(result.current.unavailable).toBe(false)
    expect(result.current.durable).toBe(true)
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(PROVIDER_CONNECTIONS_ENDPOINT, expect.objectContaining({ method: "GET" }))
  })
})
