import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useRemoteProjects } from "./use-remote-projects"

/**
 * The remote project list, when it cannot be read: a signed-out visitor
 * (401) is told to sign in, not that Hubble failed to load anything. The
 * list is unreadable either way, so `unavailable` stays true for both.
 */

function transport(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  ) as unknown as typeof fetch
}

describe("useRemoteProjects — a list that could not be read", () => {
  it("reports a signed-out visitor (401) as sign-in required", async () => {
    const { result } = renderHook(() =>
      useRemoteProjects({
        enabled: true,
        fetch: transport(401, { ok: false, error: { code: "sign-in-required", message: "x" } }),
      })
    )

    await waitFor(() => expect(result.current.failure).toBe("sign_in_required"))
    expect(result.current.unavailable).toBe(true)
    expect(result.current.projects).toEqual([])
  })

  it("keeps a service the deployment does not have (503) apart from a signed-out visitor", async () => {
    const { result } = renderHook(() =>
      useRemoteProjects({
        enabled: true,
        fetch: transport(503, { ok: false, error: { code: "remote-unavailable", message: "x" } }),
      })
    )

    await waitFor(() => expect(result.current.failure).toBe("unavailable"))
    expect(result.current.unavailable).toBe(true)
  })

  it("clears the failure once the list is read", async () => {
    const { result } = renderHook(() =>
      useRemoteProjects({ enabled: true, fetch: transport(200, { ok: true, value: { projects: [] } }) })
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.failure).toBeNull()
    expect(result.current.unavailable).toBe(false)
  })
})
