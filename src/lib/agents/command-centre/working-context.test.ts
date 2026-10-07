import { describe, expect, it } from "vitest"
import {
  WORKING_CONTEXT_LIMITS,
  addToContext,
  changeAccessLabel,
  collectionContext,
  contextOfSession,
  describeWorkingContext,
  handoffTarget,
  intentPrompt,
  removeFromContext,
  sameContext,
  scopeOf,
  summarizeWorkingContext,
  tabsContext,
  toContextSelection,
  withinWorkspace,
  workspaceContext,
  workspaceIdOf,
  workspaceLinkOf,
} from "./working-context"
import { scriptedSession } from "./__fixtures__/runtime-client"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { RuntimeSessionView } from "@/lib/agents/runtime/protocol"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The working context: ids inside one workspace, named from live data, and
 * never more than its bounds. Provider-neutral — nothing here depends on
 * which agent reads it (the last block holds every agent to the same answers).
 */

function workspace(id: string, name: string, titles: string[]): Workspace {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    tabs: titles.map((title, index) => ({
      id: `${id}-t${index}`,
      url: `https://${id}.example/${index}`,
      normalizedUrl: `https://${id}.example/${index}`,
      domain: `${id}.example`,
      title,
    })),
  }
}

const WORLD = {
  workspaces: [workspace("w1", "Research", ["paper.pdf", "relativity-notes", "CERN article"]), workspace("w2", "Personal", ["Bank"])],
  collections: [
    { id: "c1", workspaceId: "w1", name: "Physics", tabIds: ["w1-t0", "w1-t1"], createdAt: 0, updatedAt: 0 },
    { id: "c2", workspaceId: "w2", name: "Money", tabIds: ["w2-t0"], createdAt: 0, updatedAt: 0 },
  ],
  dependencies: [
    { id: "d1", parentTabId: "w1-t0", childTabId: "w1-t1", createdAt: 0 },
    { id: "d2", parentTabId: "w1-t0", childTabId: "w2-t0", createdAt: 0 },
  ],
}

describe("scope, read off the shape", () => {
  it("names every scope the brief asks for, and nothing the ids do not say", () => {
    expect(scopeOf(workspaceContext("w1"))).toBe("workspace")
    expect(scopeOf(tabsContext("w1", ["w1-t0"]))).toBe("resource")
    expect(scopeOf(tabsContext("w1", ["w1-t0", "w1-t1"]))).toBe("selection")
    expect(scopeOf(collectionContext("w1", "c1"))).toBe("collection")
    expect(scopeOf({ workspaceId: "w1", tabIds: ["w1-t2"], collectionIds: ["c1"] })).toBe("custom")
  })

  it("holds duplicates once and never more than its bounds", () => {
    const many = tabsContext("w1", [...Array.from({ length: 80 }, (_, index) => `x${index}`), "x0"])
    expect(many.tabIds).toHaveLength(WORKING_CONTEXT_LIMITS.tabs)
    expect(new Set(many.tabIds).size).toBe(many.tabIds.length)
  })
})

describe("changing it", () => {
  it("adds within one workspace, and refuses to mix two", () => {
    const merged = addToContext(tabsContext("w1", ["w1-t0"]), collectionContext("w1", "c1"))!
    expect(merged).toEqual({ workspaceId: "w1", tabIds: ["w1-t0"], collectionIds: ["c1"] })
    expect(addToContext(tabsContext("w1", ["w1-t0"]), tabsContext("w2", ["w2-t0"]))).toBeUndefined()
  })

  it("removes one entry, and an empty context is the whole workspace", () => {
    const one = removeFromContext({ workspaceId: "w1", tabIds: ["w1-t0"], collectionIds: ["c1"] }, { collectionId: "c1" })
    expect(one).toEqual(tabsContext("w1", ["w1-t0"]))
    expect(scopeOf(removeFromContext(one, { tabId: "w1-t0" }))).toBe("workspace")
  })

  it("compares by content, not order", () => {
    expect(sameContext(tabsContext("w1", ["a", "b"]), tabsContext("w1", ["b", "a"]))).toBe(true)
    expect(sameContext(tabsContext("w1", ["a"]), tabsContext("w2", ["a"]))).toBe(false)
  })

  it("drops what is not in its workspace — another workspace's tab or collection, or something deleted", () => {
    const { context, dropped } = withinWorkspace(
      { workspaceId: "w1", tabIds: ["w1-t0", "w2-t0", "gone"], collectionIds: ["c1", "c2"] },
      WORLD
    )
    expect(context).toEqual({ workspaceId: "w1", tabIds: ["w1-t0"], collectionIds: ["c1"] })
    expect(dropped).toBe(3)
    // A deleted workspace keeps nothing.
    expect(withinWorkspace(tabsContext("w-gone", ["x"]), WORLD).context.tabIds).toEqual([])
  })
})

describe("describing it from live data", () => {
  it("names tabs and collections, counts members, and shows the relationships among the tabs named", () => {
    const view = describeWorkingContext({ workspaceId: "w1", tabIds: ["w1-t0", "w1-t1"], collectionIds: ["c1"] }, WORLD)
    expect(view.workspace).toEqual({ id: "w1", name: "Research" })
    expect(view.tabs.map((tab) => tab.title)).toEqual(["paper.pdf", "relativity-notes"])
    expect(view.collections).toEqual([{ id: "c1", name: "Physics", tabCount: 2 }])
    // d2 reaches into another workspace and is not one of these tabs' relationships here.
    expect(view.relationships).toEqual([{ id: "d1", from: "paper.pdf", to: "relativity-notes" }])
    expect(view.missing).toBe(0)
  })

  it("never names another workspace's things, and counts what no longer resolves", () => {
    const view = describeWorkingContext({ workspaceId: "w1", tabIds: ["w2-t0", "gone"], collectionIds: ["c2"] }, WORLD)
    expect(view.tabs).toEqual([])
    expect(view.collections).toEqual([])
    expect(view.missing).toBe(3)
    expect(JSON.stringify(view)).not.toContain("Bank")
  })

  it("says what the chip says: a collection by name, one tab by title, otherwise counts", () => {
    expect(summarizeWorkingContext(describeWorkingContext(workspaceContext("w1"), WORLD))).toBe("Whole project")
    expect(summarizeWorkingContext(describeWorkingContext(tabsContext("w1", ["w1-t2"]), WORLD))).toBe("CERN article")
    expect(summarizeWorkingContext(describeWorkingContext(tabsContext("w1", ["w1-t0", "w1-t2"]), WORLD))).toBe("2 tabs")
    expect(
      summarizeWorkingContext(describeWorkingContext({ workspaceId: "w1", tabIds: ["w1-t2"], collectionIds: ["c1"] }, WORLD))
    ).toBe("Physics collection · 1 tab")
  })
})

describe("into the Phase E bridge", () => {
  it("attaches nothing for the whole workspace — the session reads it on request", () => {
    expect(toContextSelection(workspaceContext("w1"))).toBeNull()
  })

  it("asks for the tabs, the collections, and the relationships between two or more tabs", () => {
    expect(toContextSelection({ workspaceId: "w1", tabIds: ["a", "b"], collectionIds: ["c1"] })).toMatchObject({
      tabIds: ["a", "b"],
      collectionIds: ["c1"],
      relationships: true,
      includeNotes: false,
    })
    expect(toContextSelection(tabsContext("w1", ["a"]))?.relationships).toBe(false)
  })
})

describe("the words a request starts with", () => {
  it("fit what was asked about, and a plain ask starts empty", () => {
    const tab = describeWorkingContext(tabsContext("w1", ["w1-t0"]), WORLD)
    const tabs = describeWorkingContext(tabsContext("w1", ["w1-t0", "w1-t1"]), WORLD)
    const collection = describeWorkingContext(collectionContext("w1", "c1"), WORLD)
    expect(intentPrompt("ask", tabs)).toBeUndefined()
    expect(intentPrompt("explain", tab)).toBe("Explain this page.")
    expect(intentPrompt("summarize", tabs)).toBe("Summarize these tabs.")
    expect(intentPrompt("compare", tabs)).toBe("Compare these sources.")
    expect(intentPrompt("summarize", collection)).toBe("Summarize the Physics collection.")
    expect(intentPrompt("organize", collection)).toBe("Suggest how to organize the Physics collection.")
  })
})

describe("which session a request goes to", () => {
  const research = (over: Partial<RuntimeSessionView> = {}) => ({ view: scriptedSession({ workspaceId: "w1", ...over }) })

  it("is the session on screen when it works in the same workspace", () => {
    const sessions = [research({ sessionId: "a", updatedAt: 1 }), research({ sessionId: "b", updatedAt: 9 })]
    expect(handoffTarget(sessions, { context: workspaceContext("w1") }, "a")).toBe("a")
  })

  it("is otherwise the most recent live one there — never a session in another workspace, never an ended one", () => {
    const sessions = [
      research({ sessionId: "old", updatedAt: 1 }),
      research({ sessionId: "ended", updatedAt: 50, status: "completed" }),
      { view: scriptedSession({ sessionId: "elsewhere", workspaceId: "w2", updatedAt: 99 }) },
      research({ sessionId: "recent", updatedAt: 10 }),
    ]
    expect(handoffTarget(sessions, { context: workspaceContext("w1") }, "elsewhere")).toBe("recent")
    expect(handoffTarget(sessions, { context: workspaceContext("w3") }, null)).toBeNull()
  })

  it("respects the agent asked for", () => {
    const sessions = [research({ sessionId: "claude", provider: "claude-code", updatedAt: 9 }), research({ sessionId: "gemini", provider: "gemini", updatedAt: 1 })]
    expect(handoffTarget(sessions, { context: workspaceContext("w1"), provider: "gemini" }, null)).toBe("gemini")
  })
})

describe("a session's workspace and context, as the runtime reports them", () => {
  it("is the workspace it started in — its bound context's, when it has one", () => {
    expect(workspaceIdOf(scriptedSession({ workspaceId: "w1" }))).toBe("w1")
    expect(contextOfSession(scriptedSession())).toBeNull()
    expect(contextOfSession(scriptedSession({ workspaceId: "w1", focus: { tabIds: ["w1-t0"], collectionIds: [], delivered: true } }))).toEqual(
      tabsContext("w1", ["w1-t0"])
    )
  })

  it("tells apart every way a session can relate to its workspace", () => {
    const workspaces = WORLD.workspaces
    const context = { workspaceId: "w1", workspaceName: "Research", version: 1, syncedAt: 0, fingerprint: "f", pendingActions: [] }
    expect(workspaceLinkOf(scriptedSession(), workspaces)).toEqual({ kind: "none" })
    expect(workspaceLinkOf(scriptedSession({ workspaceId: "gone" }), workspaces)).toEqual({ kind: "workspace-missing" })
    expect(workspaceLinkOf(scriptedSession({ workspaceId: "w1", contextUnavailable: "provider" }), workspaces)).toEqual({ kind: "agent-cannot-read" })
    expect(workspaceLinkOf(scriptedSession({ workspaceId: "w1" }), workspaces)).toEqual({ kind: "no-live-access" })
    const readOnly = workspaceLinkOf(scriptedSession({ workspaceId: "w1", context: { ...context, capabilities: ["workspace.read"] } }), workspaces)
    expect(readOnly).toEqual({ kind: "live", canChange: false })
    expect(changeAccessLabel(readOnly).allowed).toBe(false)
    const writable = workspaceLinkOf(scriptedSession({ workspaceId: "w1", context: { ...context, capabilities: ["collections.write"] } }), workspaces)
    expect(changeAccessLabel(writable)).toEqual({ allowed: true, text: "Can change collections — you approve each change" })
  })

  it("is the same abstraction for every agent: nothing here depends on which one", () => {
    const providers: AgentProviderId[] = ["claude-code", "openai-codex", "gemini", "grok", "custom:research-bot" as AgentProviderId]
    const answers = providers.map((provider) => {
      const view = scriptedSession({ provider, workspaceId: "w1", focus: { tabIds: ["w1-t0"], collectionIds: ["c1"], delivered: false } })
      const own = contextOfSession(view)!
      return JSON.stringify([
        own,
        describeWorkingContext(own, WORLD),
        workspaceLinkOf(view, WORLD.workspaces),
        handoffTarget([{ view }], { context: workspaceContext("w1") }, null),
      ])
    })
    expect(new Set(answers).size).toBe(1)
  })
})
