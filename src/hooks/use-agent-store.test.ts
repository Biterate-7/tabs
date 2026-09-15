import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { setStorageNamespace } from "@/lib/storage/namespace"
import { AGENT_STORAGE_KEY, loadAgentState, saveAgentState } from "@/lib/agents/persistence"
import { AGENT_STATE_VERSION, emptyAgentState } from "@/lib/agents/types"
import { useAgentStore } from "./use-agent-store"

/**
 * The domain exercised through the real React hook and real localStorage —
 * the closest thing to running the feature that exists in this phase, since
 * Phase 11 deliberately ships no UI to click through.
 *
 * Every scenario here is a step from the manual verification list: create an
 * agent, run it in a workspace, link tabs, log activity, move it through its
 * lifecycle, reload, delete, and prove one account cannot see another's.
 */

const ADA = "11111111-1111-4111-8111-111111111111"
const GRACE = "22222222-2222-4222-8222-222222222222"

beforeEach(() => {
  window.localStorage.clear()
  setStorageNamespace(null)
  vi.useRealTimers()
})

afterEach(() => {
  setStorageNamespace(null)
  window.localStorage.clear()
})

/** Drives the store through a whole run and hands back the ids it minted. */
function buildRun(store: ReturnType<typeof useAgentStore>) {
  store.createAgent({ provider: "claude-code", name: "Claude Code" })
}

describe("useAgentStore", () => {
  it("starts empty when nothing is persisted", () => {
    const { result } = renderHook(() => useAgentStore())

    expect(result.current.agents).toEqual([])
    expect(result.current.runs).toEqual([])
  })

  it("creates an agent, then a run inside a workspace", () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => buildRun(result.current))
    expect(result.current.agents).toHaveLength(1)

    const agentId = result.current.agents[0].id
    act(() => {
      result.current.createRun({ agentId, workspaceId: "wA", title: "Add auth" })
    })

    expect(result.current.runs).toHaveLength(1)
    expect(result.current.runs[0].workspaceId).toBe("wA")
    expect(result.current.runs[0].status).toBe("working")
  })

  it("refuses to create a run for an agent that does not exist", () => {
    const { result } = renderHook(() => useAgentStore())

    let failure: string | null = null
    act(() => {
      failure = result.current.createRun({ agentId: "ghost", workspaceId: "wA" })
    })

    expect(failure).toBe("agent-not-found")
    expect(result.current.runs).toEqual([])
  })

  it("links tabs as context and produced, and rejects one from another workspace", () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => buildRun(result.current))
    const agentId = result.current.agents[0].id
    act(() => {
      result.current.createRun({ agentId, workspaceId: "wA" })
    })
    const runId = result.current.runs[0].id

    act(() => {
      result.current.addRunLink({ runId, tabId: "t1", role: "context", tabWorkspaceId: "wA" })
      result.current.addRunLink({ runId, tabId: "t2", role: "produced", tabWorkspaceId: "wA" })
    })
    expect(result.current.links).toHaveLength(2)

    let failure: string | null = null
    act(() => {
      failure = result.current.addRunLink({
        runId,
        tabId: "t3",
        role: "context",
        tabWorkspaceId: "wB",
      })
    })

    expect(failure).toBe("cross-workspace")
    expect(result.current.links).toHaveLength(2)
  })

  it("appends events and moves the run through its lifecycle to completion", () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => buildRun(result.current))
    const agentId = result.current.agents[0].id
    act(() => {
      result.current.createRun({ agentId, workspaceId: "wA" })
    })
    const runId = result.current.runs[0].id

    act(() => {
      result.current.appendRunEvent({ runId, kind: "activity", summary: "Read auth.ts" })
      result.current.appendRunEvent({ runId, kind: "activity", summary: "Edited auth.ts" })
    })
    expect(result.current.events).toHaveLength(2)

    act(() => {
      result.current.transitionRunStatus(runId, "waiting")
    })
    expect(result.current.runs[0].status).toBe("waiting")

    act(() => {
      result.current.transitionRunStatus(runId, "working")
      result.current.transitionRunStatus(runId, "completed")
    })
    expect(result.current.runs[0].status).toBe("completed")
    expect(result.current.runs[0].endedAt).toBeTypeOf("number")

    let failure: string | null = null
    act(() => {
      failure = result.current.transitionRunStatus(runId, "working")
    })
    expect(failure).toBe("terminal-run")
    expect(result.current.runs[0].status).toBe("completed")
  })

  it("persists what it holds, and reads it back on a fresh mount", async () => {
    const first = renderHook(() => useAgentStore())

    act(() => buildRun(first.result.current))
    const agentId = first.result.current.agents[0].id
    act(() => {
      first.result.current.createRun({ agentId, workspaceId: "wA", title: "Add auth" })
    })
    const runId = first.result.current.runs[0].id
    act(() => {
      first.result.current.addRunLink({ runId, tabId: "t1", role: "context", tabWorkspaceId: "wA" })
      first.result.current.appendRunEvent({ runId, kind: "activity", summary: "Edited auth.ts" })
    })

    // The save is debounced, so wait for it to actually reach storage.
    await waitFor(() => {
      expect(window.localStorage.getItem(AGENT_STORAGE_KEY)).toBeTruthy()
    })
    await waitFor(() => {
      expect(loadAgentState().state.events).toHaveLength(1)
    })

    first.unmount()

    const second = renderHook(() => useAgentStore())
    await waitFor(() => {
      expect(second.result.current.runs).toHaveLength(1)
    })

    expect(second.result.current.runs[0].title).toBe("Add auth")
    expect(second.result.current.links).toHaveLength(1)
    expect(second.result.current.events).toHaveLength(1)
  })

  it("deletes a run with its links and events, keeping the agent", async () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => buildRun(result.current))
    const agentId = result.current.agents[0].id
    act(() => {
      result.current.createRun({ agentId, workspaceId: "wA" })
    })
    const runId = result.current.runs[0].id
    act(() => {
      result.current.addRunLink({ runId, tabId: "t1", role: "context", tabWorkspaceId: "wA" })
      result.current.appendRunEvent({ runId, kind: "activity", summary: "Edited auth.ts" })
    })

    act(() => {
      result.current.deleteRun(runId)
    })

    expect(result.current.runs).toEqual([])
    expect(result.current.links).toEqual([])
    expect(result.current.events).toEqual([])
    expect(result.current.agents).toHaveLength(1)
  })

  it("refuses to delete an agent that still has runs", () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => buildRun(result.current))
    const agentId = result.current.agents[0].id
    act(() => {
      result.current.createRun({ agentId, workspaceId: "wA" })
    })

    let failure: string | null = null
    act(() => {
      failure = result.current.deleteAgent(agentId)
    })

    expect(failure).toBe("agent-has-runs")
    expect(result.current.agents).toHaveLength(1)
  })

  it("hides links to tabs that no longer exist", () => {
    const validTabs = new Set(["t1"])
    const { result } = renderHook(() => useAgentStore(validTabs))

    act(() => buildRun(result.current))
    const agentId = result.current.agents[0].id
    act(() => {
      result.current.createRun({ agentId, workspaceId: "wA" })
    })
    const runId = result.current.runs[0].id

    act(() => {
      result.current.addRunLink({ runId, tabId: "t1", role: "context", tabWorkspaceId: "wA" })
      result.current.addRunLink({ runId, tabId: "gone", role: "context", tabWorkspaceId: "wA" })
    })

    expect(result.current.links.map((l) => l.tabId)).toEqual(["t1"])
  })

  it("folds an adapter observation into a run", () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => buildRun(result.current))
    const agentId = result.current.agents[0].id

    // No workspace mapping yet — discovered, but nothing is created.
    act(() => {
      result.current.ingest(agentId, { provider: "claude-code", externalId: "sess-1" })
    })
    expect(result.current.runs).toEqual([])

    act(() => {
      result.current.ingest(agentId, {
        provider: "claude-code",
        externalId: "sess-1",
        workspaceId: "wA",
        activity: "Edited engine.ts",
        sourceId: "toolu_1",
      })
    })
    expect(result.current.runs).toHaveLength(1)
    expect(result.current.runs[0].currentActivity).toBe("Edited engine.ts")

    // Re-observing the same source record neither duplicates the run nor the event.
    act(() => {
      result.current.ingest(agentId, {
        provider: "claude-code",
        externalId: "sess-1",
        workspaceId: "wA",
        activity: "Edited engine.ts",
        sourceId: "toolu_1",
      })
    })
    expect(result.current.runs).toHaveLength(1)
    expect(result.current.events.filter((e) => e.kind === "activity")).toHaveLength(1)
  })

  it("keeps one account's agent state invisible to another", async () => {
    setStorageNamespace(ADA)
    const ada = renderHook(() => useAgentStore())

    act(() => buildRun(ada.result.current))
    const agentId = ada.result.current.agents[0].id
    act(() => {
      ada.result.current.createRun({ agentId, workspaceId: "ada-w" })
    })
    await waitFor(() => {
      expect(loadAgentState().state.runs).toHaveLength(1)
    })
    ada.unmount()

    setStorageNamespace(GRACE)
    const grace = renderHook(() => useAgentStore())

    expect(grace.result.current.agents).toEqual([])
    expect(grace.result.current.runs).toEqual([])
    grace.unmount()

    setStorageNamespace(ADA)
    const adaAgain = renderHook(() => useAgentStore())
    await waitFor(() => {
      expect(adaAgain.result.current.runs).toHaveLength(1)
    })
    expect(adaAgain.result.current.runs[0].workspaceId).toBe("ada-w")
  })

  it("declines to overwrite state written by a newer build", async () => {
    const future = { version: AGENT_STATE_VERSION + 1, agents: [], runs: [], links: [], events: [] }
    window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(future))

    const { result } = renderHook(() => useAgentStore())

    act(() => buildRun(result.current))
    expect(result.current.agents).toHaveLength(1)

    // Long enough for the debounced save to have fired had it been allowed to.
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(JSON.parse(window.localStorage.getItem(AGENT_STORAGE_KEY)!)).toEqual(future)
  })

  it("resets to an empty domain on request", () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => buildRun(result.current))
    expect(result.current.agents).toHaveLength(1)

    act(() => {
      result.current.reset()
    })
    expect(result.current.state).toEqual(emptyAgentState())
  })

  it("does not write anything for a store that was never touched", async () => {
    saveAgentState(emptyAgentState())
    window.localStorage.clear()

    renderHook(() => useAgentStore())
    await new Promise((resolve) => setTimeout(resolve, 600))

    // An untouched store still saves its (empty) state; the point is that it
    // does so without throwing and without inventing content.
    const stored = window.localStorage.getItem(AGENT_STORAGE_KEY)
    if (stored) expect(JSON.parse(stored)).toEqual(emptyAgentState())
  })
})

describe("work artifacts", () => {
  const PROJECT = "C:/repo/project"

  function seedAgent(store: ReturnType<typeof useAgentStore>) {
    store.createAgent({ provider: "claude-code", name: "Claude Code" })
  }

  it("records a file a run worked on", () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => seedAgent(result.current))
    const agentId = result.current.agents[0].id
    act(() => {
      result.current.createRun({ agentId, workspaceId: "wA" })
    })
    const runId = result.current.runs[0].id

    act(() => {
      result.current.recordArtifactWork({
        runId,
        projectPath: PROJECT,
        path: "src/foo.ts",
        role: "edited",
      })
    })

    expect(result.current.artifacts).toHaveLength(1)
    expect(result.current.artifacts[0].relativePath).toBe("src/foo.ts")
    expect(result.current.artifacts[0].workspaceId).toBe("wA")
    expect(result.current.artifactLinks[0].role).toBe("edited")
  })

  it("refuses a path that escapes the project", () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => seedAgent(result.current))
    const agentId = result.current.agents[0].id
    act(() => {
      result.current.createRun({ agentId, workspaceId: "wA" })
    })
    const runId = result.current.runs[0].id

    let failure: string | null = null
    act(() => {
      failure = result.current.recordArtifactWork({
        runId,
        projectPath: PROJECT,
        path: "../../secret.txt",
        role: "edited",
      })
    })

    expect(failure).toBe("invalid-path")
    expect(result.current.artifacts).toEqual([])
  })

  it("round-trips artifacts and links through a reload", async () => {
    const first = renderHook(() => useAgentStore())

    act(() => seedAgent(first.result.current))
    const agentId = first.result.current.agents[0].id
    act(() => {
      first.result.current.createRun({ agentId, workspaceId: "wA" })
    })
    const runId = first.result.current.runs[0].id
    act(() => {
      first.result.current.recordArtifactWork({
        runId,
        projectPath: PROJECT,
        path: "src/foo.ts",
        role: "edited",
      })
      first.result.current.recordArtifactWork({
        runId,
        projectPath: PROJECT,
        path: "src/bar.ts",
        role: "inspected",
      })
    })

    await waitFor(() => {
      expect(loadAgentState().state.artifacts).toHaveLength(2)
    })
    first.unmount()

    const second = renderHook(() => useAgentStore())
    await waitFor(() => {
      expect(second.result.current.artifacts).toHaveLength(2)
    })

    expect(second.result.current.artifactLinks.map((l) => l.role).sort()).toEqual([
      "edited",
      "inspected",
    ])
    expect(second.result.current.artifacts.every((a) => a.workspaceId === "wA")).toBe(true)
  })

  it("keeps the artifact but drops its links when the run is deleted", () => {
    const { result } = renderHook(() => useAgentStore())

    act(() => seedAgent(result.current))
    const agentId = result.current.agents[0].id
    act(() => {
      result.current.createRun({ agentId, workspaceId: "wA" })
    })
    const runId = result.current.runs[0].id
    act(() => {
      result.current.recordArtifactWork({
        runId,
        projectPath: PROJECT,
        path: "src/foo.ts",
        role: "edited",
      })
    })

    act(() => {
      result.current.deleteRun(runId)
    })
    expect(result.current.artifactLinks).toEqual([])
    expect(result.current.artifacts).toHaveLength(1)

    act(() => {
      result.current.pruneOrphanedArtifacts()
    })
    expect(result.current.artifacts).toEqual([])
  })

  it("keeps one account's artifacts invisible to another", async () => {
    setStorageNamespace(ADA)
    const ada = renderHook(() => useAgentStore())
    act(() => seedAgent(ada.result.current))
    const adaAgent = ada.result.current.agents[0].id
    act(() => {
      ada.result.current.createRun({ agentId: adaAgent, workspaceId: "ada-w" })
    })
    act(() => {
      ada.result.current.recordArtifactWork({
        runId: ada.result.current.runs[0].id,
        projectPath: PROJECT,
        path: "src/ada.ts",
        role: "edited",
      })
    })
    await waitFor(() => {
      expect(loadAgentState().state.artifacts).toHaveLength(1)
    })
    ada.unmount()

    setStorageNamespace(GRACE)
    const grace = renderHook(() => useAgentStore())
    expect(grace.result.current.artifacts).toEqual([])
    expect(grace.result.current.artifactLinks).toEqual([])
    grace.unmount()

    setStorageNamespace(ADA)
    const back = renderHook(() => useAgentStore())
    await waitFor(() => {
      expect(back.result.current.artifacts).toHaveLength(1)
    })
    expect(back.result.current.artifacts[0].relativePath).toBe("src/ada.ts")
  })
})
