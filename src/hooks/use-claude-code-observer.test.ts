import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { setStorageNamespace } from "@/lib/storage/namespace"
import { CLAUDE_CODE_PROVIDER } from "@/lib/agents/claude-code/types"
import { normalizeUrl } from "@/lib/tabs/normalize"
import { useAgentStore } from "./use-agent-store"
import { useClaudeCodeObserver } from "./use-claude-code-observer"
import type { ClaudeObservationResponse } from "@/lib/agents/claude-code/contract"

/**
 * The observer wired to the real agent store, with the network faked at the
 * adapter's injection point. Everything below that — mapping, ingestion,
 * identity, linking — is the real code.
 */

const SESSION = "b70abc10-f01a-48de-8d41-8ac936e8eff8"
const PROJECT = "C:\\Users\\someone\\project"
const ADA = "11111111-1111-4111-8111-111111111111"
const GRACE = "22222222-2222-4222-8222-222222222222"

function response(over: Partial<ClaudeObservationResponse> = {}): ClaudeObservationResponse {
  return { available: true, sessions: [], observations: [], cursor: "c1", ...over }
}

function baseObservation(over: Record<string, unknown> = {}) {
  return {
    provider: CLAUDE_CODE_PROVIDER,
    externalId: SESSION,
    projectKey: PROJECT,
    status: "working" as const,
    title: "project-c4",
    ...over,
  }
}

/** Renders the observer on top of a real store, sharing one render pass. */
function renderObserver(
  fetchObservations: (cursor: string) => Promise<ClaudeObservationResponse>,
  tabIndexes?: { workspaceId: string; tabsByNormalizedUrl: Map<string, string> }[]
) {
  return renderHook(() => {
    const store = useAgentStore()
    const observer = useClaudeCodeObserver({
      store,
      enabled: true,
      tabIndexes,
      adapterOptions: {
        fetchObservations,
        // A scheduler that never fires: every poll in these tests is explicit.
        scheduler: {
          setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
          clearInterval: () => {},
        },
      },
    })
    return { store, observer }
  })
}

beforeEach(() => {
  window.localStorage.clear()
  setStorageNamespace(null)
})

afterEach(() => {
  setStorageNamespace(null)
  window.localStorage.clear()
})

describe("workspace mapping", () => {
  it("creates no run while the project is unmapped", async () => {
    const { result } = renderObserver(async () => response({ observations: [baseObservation()] }))

    await waitFor(() => expect(result.current.store.agents).toHaveLength(1))

    expect(result.current.store.runs).toEqual([])
    expect(result.current.store.agents[0].provider).toBe(CLAUDE_CODE_PROVIDER)
  })

  it("attaches a previously discovered session once its project is mapped", async () => {
    const { result } = renderObserver(async () => response({ observations: [baseObservation()] }))

    await waitFor(() => expect(result.current.store.agents).toHaveLength(1))
    expect(result.current.store.runs).toEqual([])

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })
    await act(async () => {
      await result.current.observer.refresh()
    })

    await waitFor(() => expect(result.current.store.runs).toHaveLength(1))
    expect(result.current.store.runs[0].workspaceId).toBe("wA")
    expect(result.current.store.runs[0].externalId).toBe(SESSION)
    expect(result.current.store.runs[0].title).toBe("project-c4")
  })

  it("never assigns a session to a workspace that was not explicitly mapped", async () => {
    const { result } = renderObserver(async () =>
      response({ observations: [baseObservation({ projectKey: "C:\\some\\other\\project" })] })
    )

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })
    await act(async () => {
      await result.current.observer.refresh()
    })

    expect(result.current.store.runs).toEqual([])
  })

  it("lists sessions that have no mapping yet", async () => {
    const sessions = [{ externalId: SESSION, projectPath: PROJECT, lastObservedAt: 1 }]
    const { result } = renderObserver(async () => response({ sessions }))

    await act(async () => {
      await result.current.observer.refresh()
    })
    await waitFor(() => expect(result.current.observer.sessions).toHaveLength(1))

    expect(result.current.observer.unmappedSessions).toHaveLength(1)

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })
    expect(result.current.observer.unmappedSessions).toEqual([])
  })

  it("persists mappings across a remount", async () => {
    const first = renderObserver(async () => response())
    act(() => {
      first.result.current.observer.mapProject(PROJECT, "wA")
    })
    await waitFor(() => expect(first.result.current.observer.mappings).toHaveLength(1))
    first.unmount()

    const second = renderObserver(async () => response())
    expect(second.result.current.observer.mappings[0].workspaceId).toBe("wA")
  })

  it("unmaps a project", async () => {
    const { result } = renderObserver(async () => response())

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })
    expect(result.current.observer.mappings).toHaveLength(1)

    act(() => {
      result.current.observer.unmapProject(PROJECT)
    })
    expect(result.current.observer.mappings).toEqual([])
  })
})

describe("identity across polls", () => {
  it("keeps one agent and one run no matter how often it polls", async () => {
    const { result } = renderObserver(async () => response({ observations: [baseObservation()] }))

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })

    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await result.current.observer.refresh()
      })
    }

    await waitFor(() => expect(result.current.store.runs).toHaveLength(1))
    expect(result.current.store.agents).toHaveLength(1)
  })

  it("does not duplicate events when the same source record is re-observed", async () => {
    const observations = [
      baseObservation(),
      {
        provider: CLAUDE_CODE_PROVIDER,
        externalId: SESSION,
        projectKey: PROJECT,
        activity: "Edited a.ts",
        sourceId: "toolu_1",
      },
    ]
    const { result } = renderObserver(async () => response({ observations }))

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await result.current.observer.refresh()
      })
    }

    await waitFor(() => expect(result.current.store.runs).toHaveLength(1))
    const activity = result.current.store.events.filter((event) => event.kind === "activity")
    expect(activity).toHaveLength(1)
    expect(activity[0].summary).toBe("Edited a.ts")
  })

  it("tracks a status change", async () => {
    let status: "working" | "waiting" = "working"
    const { result } = renderObserver(async () =>
      response({ observations: [baseObservation({ status })] })
    )

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })
    await act(async () => {
      await result.current.observer.refresh()
    })
    await waitFor(() => expect(result.current.store.runs).toHaveLength(1))
    expect(result.current.store.runs[0].status).toBe("working")

    status = "waiting"
    await act(async () => {
      await result.current.observer.refresh()
    })
    await waitFor(() => expect(result.current.store.runs[0].status).toBe("waiting"))
  })
})

describe("url context linking", () => {
  const tabIndexes = [
    {
      workspaceId: "wA",
      tabsByNormalizedUrl: new Map([
        [normalizeUrl(new URL("https://example.com/docs")), "tab-docs"],
      ]),
    },
  ]

  it("links an exactly matching saved tab as context", async () => {
    const observations = [
      baseObservation(),
      {
        provider: CLAUDE_CODE_PROVIDER,
        externalId: SESSION,
        projectKey: PROJECT,
        activity: "Opened a page",
        sourceId: "toolu_url",
        url: "https://example.com/docs?utm_source=newsletter",
      },
    ]
    const { result } = renderObserver(async () => response({ observations }), tabIndexes)

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })
    await act(async () => {
      await result.current.observer.refresh()
    })

    await waitFor(() => expect(result.current.store.links).toHaveLength(1))
    expect(result.current.store.links[0].tabId).toBe("tab-docs")
    expect(result.current.store.links[0].role).toBe("context")
  })

  it("links nothing when no saved tab matches exactly", async () => {
    const observations = [
      baseObservation(),
      {
        provider: CLAUDE_CODE_PROVIDER,
        externalId: SESSION,
        projectKey: PROJECT,
        activity: "Opened a page",
        sourceId: "toolu_url",
        url: "https://example.com/something-else",
      },
    ]
    const { result } = renderObserver(async () => response({ observations }), tabIndexes)

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })
    await act(async () => {
      await result.current.observer.refresh()
    })
    await waitFor(() => expect(result.current.store.runs).toHaveLength(1))

    expect(result.current.store.links).toEqual([])
  })

  it("links nothing when the matching tab lives in another workspace", async () => {
    const observations = [
      baseObservation(),
      {
        provider: CLAUDE_CODE_PROVIDER,
        externalId: SESSION,
        projectKey: PROJECT,
        activity: "Opened a page",
        sourceId: "toolu_url",
        url: "https://example.com/docs",
      },
    ]
    // The tab index belongs to wB; the run will be in wA.
    const elsewhere = [{ ...tabIndexes[0], workspaceId: "wB" }]
    const { result } = renderObserver(async () => response({ observations }), elsewhere)

    act(() => {
      result.current.observer.mapProject(PROJECT, "wA")
    })
    await act(async () => {
      await result.current.observer.refresh()
    })
    await waitFor(() => expect(result.current.store.runs).toHaveLength(1))

    expect(result.current.store.links).toEqual([])
  })
})

describe("availability", () => {
  it("reports unavailable when there is no local installation", async () => {
    const { result } = renderObserver(async () =>
      response({ available: false, sessions: [], observations: [], cursor: "" })
    )

    await act(async () => {
      await result.current.observer.refresh()
    })

    expect(result.current.observer.available).toBe(false)
    expect(result.current.store.runs).toEqual([])
  })

  it("creates nothing when a poll fails", async () => {
    const { result } = renderObserver(async () => {
      throw new Error("offline")
    })

    await act(async () => {
      await result.current.observer.refresh()
    })

    expect(result.current.store.runs).toEqual([])
    expect(result.current.observer.available).toBe(false)
  })
})

describe("account isolation", () => {
  it("keeps one account's project mappings invisible to another", async () => {
    setStorageNamespace(ADA)
    const ada = renderObserver(async () => response())
    act(() => {
      ada.result.current.observer.mapProject(PROJECT, "ada-w")
    })
    await waitFor(() => expect(ada.result.current.observer.mappings).toHaveLength(1))
    ada.unmount()

    setStorageNamespace(GRACE)
    const grace = renderObserver(async () => response())
    expect(grace.result.current.observer.mappings).toEqual([])
    grace.unmount()

    setStorageNamespace(ADA)
    const adaAgain = renderObserver(async () => response())
    expect(adaAgain.result.current.observer.mappings[0].workspaceId).toBe("ada-w")
  })
})

describe("polling hygiene", () => {
  it("stops polling when it unmounts", async () => {
    const cleared: unknown[] = []
    const fetchObservations = vi.fn(async () => response())

    const view = renderHook(() => {
      const store = useAgentStore()
      return useClaudeCodeObserver({
        store,
        enabled: true,
        adapterOptions: {
          fetchObservations,
          scheduler: {
            setInterval: () => 7 as unknown as ReturnType<typeof setInterval>,
            clearInterval: (handle) => cleared.push(handle),
          },
        },
      })
    })

    view.unmount()
    expect(cleared).toContain(7)
  })

  it("does not poll at all when disabled", async () => {
    const fetchObservations = vi.fn(async () => response())

    renderHook(() => {
      const store = useAgentStore()
      return useClaudeCodeObserver({ store, enabled: false, adapterOptions: { fetchObservations } })
    })

    expect(fetchObservations).not.toHaveBeenCalled()
  })
})
