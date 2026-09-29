import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useSessionContext } from "./use-session-context"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { createScriptedRuntime, scriptedSession } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { CommandCentreSession } from "./use-agent-sessions"
import type { CollectionBatchResult } from "@/lib/collections/batch"
import type { RuntimeSessionView } from "@/lib/agents/runtime/protocol"

/**
 * No duplicate workspace mutation after a retry (Agent Authentication &
 * Runtime).
 *
 * Every runtime command is now bounded, so `complete_context_action` can come
 * back as `timeout` — and the runtime, not having heard, lists the same
 * approved change again on the next read. The Command Centre must not apply
 * it a second time: the person approved one change, not one per attempt.
 */

const world = buildContextWorld({
  ownerId: "owner-1",
  workspaces: [
    {
      id: "w1",
      name: "Research",
      createdAt: 0,
      updatedAt: 0,
      tabs: [{ id: "t1", url: "https://example.com/", title: "Example", domain: "example.com", category: "research", addedAt: 0 } as never],
    },
  ],
  collections: [],
  dependencies: [],
  manualConnections: [],
  projects: [],
  agents: [],
  runs: [],
})

function withPending(): CommandCentreSession {
  const view: RuntimeSessionView = scriptedSession({
    provider: "gemini",
    workspaceId: "w1",
    context: {
      workspaceId: "w1",
      workspaceName: "Research",
      capabilities: ["workspace.read", "collections.write"],
      version: 1,
      syncedAt: 0,
      fingerprint: "f1",
      pendingActions: [{ actionId: "a1", kind: "create_collection", name: "Reading", tabIds: ["t1"] }],
    },
  })
  return { view, origin: "controlled" }
}

describe("an approved change is applied once, however many times it is listed", () => {
  it("does not apply it again when completing it timed out and the runtime lists it again", () => {
    const runtime = createScriptedRuntime()
    runtime.failCommand("complete_context_action", "timeout")
    const applyCollectionBatch = vi.fn(
      (): CollectionBatchResult => ({ ok: true, created: ["c1"], collections: [], touched: [] })
    )
    const onApplied = vi.fn()

    const { rerender } = renderHook(
      ({ sessions }) =>
        useSessionContext({
          client: runtime.client,
          sessions,
          world,
          collections: [],
          applyCollectionBatch,
          onApplied,
        }),
      { initialProps: { sessions: [withPending()] } }
    )
    expect(applyCollectionBatch).toHaveBeenCalledTimes(1)

    // The next poll: the runtime never heard, so the change is still pending.
    rerender({ sessions: [withPending()] })
    rerender({ sessions: [withPending()] })

    expect(applyCollectionBatch).toHaveBeenCalledTimes(1)
    expect(onApplied).toHaveBeenCalledTimes(1)
  })
})
