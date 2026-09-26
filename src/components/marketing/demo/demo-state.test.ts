import { describe, expect, it } from "vitest"
import { PLATFORM_PROVIDERS } from "@/lib/agents/platform/catalog"
import {
  BUILD_ID,
  CLAUDE_SESSION,
  DEMO_AGENTS,
  DEMO_COLLECTIONS,
  DEMO_EVENTS,
  DEMO_SESSION_PROVIDERS,
  DEMO_WORKSPACES,
  GEMINI_SESSION,
  GROK_SESSION,
  RESEARCH_ID,
  SWE_APPROVAL,
  SWE_TAB_IDS,
} from "./data"
import { DEMO_REPLY, createDemoState, currentWorkspace, demoReducer, type DemoAction, type DemoState } from "./demo-state"

function run(state: DemoState, ...actions: DemoAction[]): DemoState {
  return actions.reduce(demoReducer, state)
}

describe("demo state initialization", () => {
  it("starts on the Research workspace with the Claude Code session open", () => {
    const state = createDemoState()
    expect(state.view).toBe("workspace")
    expect(currentWorkspace(state).name).toBe("Research")
    expect(state.store.workspaces.map((w) => w.name)).toEqual(["Research", "Hubble Build", "Semester"])
    expect(state.selectedSessionId).toBe(CLAUDE_SESSION)
    expect(state.paletteOpen).toBe(false)
    expect(state.contextPanelOpen).toBe(true)
  })

  it("is deterministic: two states built from the same init are equal", () => {
    expect(createDemoState({ view: "graph" })).toEqual(createDemoState({ view: "graph" }))
  })

  it("never shares arrays with the fixture, so one window's changes cannot reach another", () => {
    const a = createDemoState()
    const b = run(createDemoState(), { type: "create-collection", name: "Mine", tabIds: ["t-cursor"] })
    expect(a.collections).toHaveLength(DEMO_COLLECTIONS.length)
    expect(b.collections).toHaveLength(DEMO_COLLECTIONS.length + 1)
    expect(DEMO_COLLECTIONS).toHaveLength(a.collections.length)
  })

  it("honours an init for the view, the session and the rail", () => {
    const state = createDemoState({ view: "command-centre", selectedSessionId: GEMINI_SESSION, sidebarCollapsed: true, contextPanelOpen: false })
    expect(state.view).toBe("command-centre")
    expect(state.selectedSessionId).toBe(GEMINI_SESSION)
    expect(state.sidebarCollapsed).toBe(true)
    expect(state.contextPanelOpen).toBe(false)
  })

  it("reports each session's latest event sequence, as the runtime would", () => {
    const state = createDemoState()
    for (const session of state.sessions) {
      const events = DEMO_EVENTS[session.view.sessionId] ?? []
      expect(session.view.latestSequence).toBe(events.length)
    }
  })

  it("names the collection's tabs in the approval card exactly as the workspace holds them", () => {
    const research = DEMO_WORKSPACES.find((w) => w.id === RESEARCH_ID)!
    const titles = SWE_TAB_IDS.map((id) => research.tabs.find((t) => t.id === id)?.title)
    expect(SWE_APPROVAL.change?.details).toEqual(titles)
    expect(SWE_APPROVAL.change?.tabCount).toBe(SWE_TAB_IDS.length)
  })

  it("claims sessions only for the agents Hubble actually starts sessions with", () => {
    const sessionProviders = new Set(PLATFORM_PROVIDERS.filter((p) => p.sessions.available).map((p) => p.provider))
    expect([...DEMO_SESSION_PROVIDERS].sort()).toEqual([...sessionProviders].sort())
    for (const session of createDemoState().sessions) {
      expect(sessionProviders.has(session.view.provider)).toBe(true)
    }
    // Codex is connected in the roster but has no session, because Hubble does not start one.
    expect(DEMO_AGENTS.some((agent) => agent.provider === "openai-codex")).toBe(true)
  })

  it("keeps every collection's tabs inside its own workspace", () => {
    // The collection store prunes a tab that lives in another workspace; a
    // fixture that broke this would render smaller collections without failing.
    const misplaced = DEMO_COLLECTIONS.flatMap((c) => {
      const workspace = DEMO_WORKSPACES.find((w) => w.id === c.workspaceId)
      return c.tabIds.filter((id) => !workspace?.tabs.some((t) => t.id === id)).map((id) => `${c.name}: ${id}`)
    })
    expect(misplaced).toEqual([])
  })
})

describe("workspaces", () => {
  it("switches the workspace on screen", () => {
    const state = run(createDemoState(), { type: "switch-workspace", id: BUILD_ID })
    expect(currentWorkspace(state).name).toBe("Hubble Build")
  })

  it("ignores a switch to a workspace that does not exist", () => {
    const state = run(createDemoState(), { type: "switch-workspace", id: "nope" })
    expect(currentWorkspace(state).id).toBe(RESEARCH_ID)
  })

  it("creates, renames and deletes a workspace, but never deletes the last one", () => {
    let state = run(createDemoState(), { type: "create-workspace", name: "Trips" })
    expect(currentWorkspace(state).name).toBe("Trips")
    state = run(state, { type: "rename-workspace", id: state.store.currentId, name: "Travel" })
    expect(currentWorkspace(state).name).toBe("Travel")
    for (const w of [...state.store.workspaces]) state = run(state, { type: "delete-workspace", id: w.id })
    expect(state.store.workspaces).toHaveLength(1)
  })

  it("drops a deleted workspace's collections with it", () => {
    const state = run(createDemoState(), { type: "delete-workspace", id: BUILD_ID })
    expect(state.collections.some((c) => c.workspaceId === BUILD_ID)).toBe(false)
  })

  it("removing a tab also removes it from its collection", () => {
    const start = createDemoState()
    const research = currentWorkspace(start)
    const state = run(start, { type: "set-tabs", workspaceId: RESEARCH_ID, tabs: research.tabs.filter((t) => t.id !== "t-attention") })
    const aiResearch = state.collections.find((c) => c.id === "c-ai-research")!
    expect(aiResearch.tabIds).not.toContain("t-attention")
  })

  it("creates, renames and deletes a section through the product's section helpers", () => {
    let state = run(createDemoState(), { type: "create-section", parentId: null, name: "Reading list" })
    const section = currentWorkspace(state).sections!.find((s) => s.name === "Reading list")!
    expect(section).toBeTruthy()
    state = run(state, { type: "rename-section", id: section.id, name: "Later" })
    expect(currentWorkspace(state).sections!.some((s) => s.name === "Later")).toBe(true)
    state = run(state, { type: "delete-section", id: section.id })
    expect(currentWorkspace(state).sections!.some((s) => s.id === section.id)).toBe(false)
  })
})

describe("collections", () => {
  it("gathers selected tabs into a new collection with a stable id", () => {
    const state = run(createDemoState(), { type: "create-collection", name: "Agents", tabIds: ["t-cursor", "t-claude"] })
    const created = state.collections.find((c) => c.name === "Agents")!
    expect(created.id).toBe("c-created-1")
    expect(created.workspaceId).toBe(RESEARCH_ID)
    expect(created.tabIds).toEqual(["t-cursor", "t-claude"])
  })

  it("moves a tab between collections — a tab belongs to one collection at a time", () => {
    const state = run(createDemoState(), { type: "move-to-collection", tabId: "t-attention", id: "c-hubble" })
    expect(state.collections.find((c) => c.id === "c-hubble")!.tabIds).toContain("t-attention")
    expect(state.collections.find((c) => c.id === "c-ai-research")!.tabIds).not.toContain("t-attention")
  })

  it("renames and deletes a collection", () => {
    let state = run(createDemoState(), { type: "rename-collection", id: "c-school", name: "Courses" })
    expect(state.collections.find((c) => c.id === "c-school")!.name).toBe("Courses")
    state = run(state, { type: "delete-collection", id: "c-school" })
    expect(state.collections.some((c) => c.id === "c-school")).toBe(false)
  })
})

describe("the Command Centre", () => {
  it("allowing the approval creates the collection it named, and the session waits for the next message", () => {
    const state = run(createDemoState(), { type: "respond", approvalId: SWE_APPROVAL.approvalId, decision: "granted" })
    const created = state.collections.find((c) => c.name === "SWE-bench")!
    expect(created.workspaceId).toBe(RESEARCH_ID)
    expect(created.tabIds).toEqual([...SWE_TAB_IDS])
    expect(state.approvals[CLAUDE_SESSION]).toEqual([])
    const session = state.sessions.find((s) => s.view.sessionId === CLAUDE_SESSION)!
    expect(session.view.status).toBe("ready")
    expect(session.view.awaitingApproval).toBe(false)
    const kinds = state.events[CLAUDE_SESSION].map((e) => e.kind)
    expect(kinds.slice(-4)).toEqual(["approval_granted", "tool_finished", "message_received", "run_completed"])
    expect(session.view.latestSequence).toBe(state.events[CLAUDE_SESSION].length)
  })

  it("denying the approval changes nothing in the workspace", () => {
    const start = createDemoState()
    const state = run(start, { type: "respond", approvalId: SWE_APPROVAL.approvalId, decision: "denied" })
    expect(state.collections).toEqual(start.collections)
    expect(state.events[CLAUDE_SESSION].some((e) => e.kind === "approval_denied")).toBe(true)
    expect(state.sessions.find((s) => s.view.sessionId === CLAUDE_SESSION)!.view.status).toBe("ready")
  })

  it("answers an approval only once", () => {
    const once = run(createDemoState(), { type: "respond", approvalId: SWE_APPROVAL.approvalId, decision: "granted" })
    const twice = run(once, { type: "respond", approvalId: SWE_APPROVAL.approvalId, decision: "granted" })
    expect(twice).toBe(once)
  })

  it("sends a message, then replies saying plainly that no agent is connected", () => {
    let state = run(createDemoState(), { type: "respond", approvalId: SWE_APPROVAL.approvalId, decision: "denied" })
    state = run(state, { type: "send", sessionId: CLAUDE_SESSION, text: "  What else is here?  " })
    let events = state.events[CLAUDE_SESSION]
    expect(events[events.length - 1]).toMatchObject({ kind: "message_sent", text: "What else is here?" })
    expect(state.sessions.find((s) => s.view.sessionId === CLAUDE_SESSION)!.view.status).toBe("running")
    state = run(state, { type: "reply", sessionId: CLAUDE_SESSION })
    events = state.events[CLAUDE_SESSION]
    expect(events[events.length - 1]).toMatchObject({ kind: "message_received", text: DEMO_REPLY })
    expect(DEMO_REPLY).toMatch(/no agent is connected/)
  })

  it("ignores an empty message and a reply to a session that is not running", () => {
    const start = createDemoState()
    expect(run(start, { type: "send", sessionId: GROK_SESSION, text: "   " })).toBe(start)
    expect(run(start, { type: "reply", sessionId: GROK_SESSION })).toBe(start)
  })

  it("cancels a running session, and cannot cancel one that has ended", () => {
    const start = createDemoState()
    const cancelled = run(start, { type: "cancel", sessionId: GEMINI_SESSION })
    expect(cancelled.sessions.find((s) => s.view.sessionId === GEMINI_SESSION)!.view.status).toBe("cancelled")
    expect(cancelled.events[GEMINI_SESSION].at(-1)?.kind).toBe("run_cancelled")
    expect(run(start, { type: "cancel", sessionId: GROK_SESSION })).toBe(start)
  })

  it("ends a session and clears the selection when it was the open one", () => {
    const state = run(createDemoState(), { type: "dispose", sessionId: CLAUDE_SESSION })
    expect(state.sessions.some((s) => s.view.sessionId === CLAUDE_SESSION)).toBe(false)
    expect(state.selectedSessionId).toBeNull()
  })

  it("switches between sessions", () => {
    const state = run(createDemoState(), { type: "select-session", id: GEMINI_SESSION })
    expect(state.selectedSessionId).toBe(GEMINI_SESSION)
  })
})

describe("shell state", () => {
  it("navigating closes the palette and the phone drawer", () => {
    const state = run(createDemoState(), { type: "palette", open: true }, { type: "mobile-sidebar", open: true }, { type: "navigate", view: "graph" })
    expect(state.view).toBe("graph")
    expect(state.paletteOpen).toBe(false)
    expect(state.mobileSidebarOpen).toBe(false)
  })

  it("sets the rail explicitly, so running it twice is the same as once", () => {
    const once = run(createDemoState(), { type: "set-sidebar-collapsed", collapsed: true })
    expect(run(once, { type: "set-sidebar-collapsed", collapsed: true })).toBe(once)
    expect(once.sidebarCollapsed).toBe(true)
  })

  it("opens a settings section as a destination", () => {
    const state = run(createDemoState(), { type: "settings-section", section: "agents" })
    expect(state.view).toBe("settings")
    expect(state.settingsSection).toBe("agents")
  })

  it("adds, retypes and removes a dependency", () => {
    let state = run(createDemoState(), { type: "add-dependency", parentTabId: "t-react", childTabId: "t-attention", dependencyType: "research" })
    const dep = state.dependencies.find((d) => d.parentTabId === "t-react")!
    expect(dep.type).toBe("research")
    state = run(state, { type: "set-dependency-type", id: dep.id, dependencyType: "reference" })
    expect(state.dependencies.find((d) => d.id === dep.id)!.type).toBe("reference")
    state = run(state, { type: "remove-dependency", id: dep.id })
    expect(state.dependencies.some((d) => d.id === dep.id)).toBe(false)
  })

  it("resets to the fixture", () => {
    const changed = run(createDemoState(), { type: "delete-collection", id: "c-school" }, { type: "switch-workspace", id: BUILD_ID })
    expect(run(changed, { type: "reset" })).toEqual(createDemoState())
  })
})
