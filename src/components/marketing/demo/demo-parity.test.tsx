import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildAgentActivityTimeline } from "@/lib/agents/activity/timeline"
import { reconstructHistorySession } from "@/lib/agents/activity/history"
import {
  CLAUDE_RELEASE_SESSION,
  CLAUDE_SESSION,
  DEMO_APPROVALS,
  DEMO_EVENTS,
  DEMO_HISTORY,
  DEMO_KNOWN_APPROVALS,
  DEMO_NOW,
  DEMO_SESSIONS,
  HISTORY_IDEAS_SESSION,
} from "./data"
import { DemoApp } from "./demo-app"
import { createDemoState } from "./demo-state"
import { RESEARCH_BRIEF } from "./data"
import { emptyContextWorld } from "@/lib/agents/context/world"
import { contextPackId } from "@/lib/agents/context-pack/pack"
import { sessionContextPack } from "@/lib/agents/context-pack/session"
import { DemoFrame } from "./demo-frame"
import { HubbleDemoProvider } from "./demo-provider"
import type { DemoInit } from "./demo-state"

/*
 * The landing page's live demonstration must be Hubble, not a picture of it.
 *
 * Two kinds of guard:
 *
 *   - **Structural.** The demo's Command Centre is built from the very
 *     components and the very hook CommandCentreView uses for an agent's
 *     activity, and nothing under marketing/ draws its own timeline,
 *     inspector or status vocabulary. A future change that forks the demo
 *     into look-alike UI fails here, not in a visitor's eyes.
 *   - **Behavioural.** Driven like a visitor, a demo window shows exactly the
 *     timeline the product's own builder derives from the demo's records, and
 *     walks the real workflow — context, approval, result, inspector, undo —
 *     with no network and no storage.
 */

const SRC = join(process.cwd(), "src")
const read = (path: string) => readFileSync(join(SRC, path), "utf8")

/** The `@/…` modules a source file imports, and the names it takes from each. */
function imports(source: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(@\/[^"]+)"/g)) {
    const names = match[1]!.split(",").map((name) => name.trim().replace(/^type\s+/, "")).filter(Boolean)
    const set = found.get(match[2]!) ?? new Set<string>()
    for (const name of names) set.add(name)
    found.set(match[2]!, set)
  }
  return found
}

/** Every component and hook an agent's session is drawn with — shared by the app and the demo, by construction. */
const SHARED_SESSION_UI: ReadonlyArray<[string, string]> = [
  ["@/components/agents/agent-activity", "AgentActivity"],
  ["@/components/command-centre/activity-popover", "ActivityPopover"],
  ["@/hooks/use-agent-activity", "useSessionActivity"],
  ["@/components/command-centre/session-header", "SessionHeader"],
  ["@/components/command-centre/event-stream", "EventStream"],
  ["@/components/command-centre/approval-prompt", "ApprovalPrompt"],
  ["@/components/command-centre/context-panel", "ContextPanel"],
  ["@/components/command-centre/composer", "Composer"],
  ["@/components/command-centre/session-list", "SessionList"],
  ["@/components/command-centre/agent-roster", "AgentRoster"],
  // Agent history (Hubble 1.3): the same list, the same past-session pane, the same hook.
  ["@/components/command-centre/agent-history-list", "AgentHistoryList"],
  ["@/components/command-centre/history-session-view", "HistorySessionView"],
  ["@/hooks/use-agent-activity", "useHistorySessionActivity"],
  // Context Intelligence (Hubble 1.5): the same pack, built by the same recipe, attached the same way.
  ["@/hooks/use-session-context-pack", "useSessionContextPack"],
  ["@/lib/agents/context-pack/session", "sessionContextPack"],
  ["@/lib/agents/context-pack/attach", "contextPackAttachedContext"],
  ["@/lib/agents/context-pack/handoff", "handoffContextPack"],
  ["@/lib/agents/context-pack/provenance", "contextProvenanceOf"],
]

/** CommandCentreView imports its siblings relatively; normalise those to the same `@/` paths. */
function appImports(): Map<string, Set<string>> {
  const source = read("components/command-centre/command-centre-view.tsx").replace(/from "\.\/([^"]+)"/g, 'from "@/components/command-centre/$1"')
  return imports(source)
}

function marketingSources(): Array<{ path: string; source: string }> {
  const walk = (dir: string): string[] =>
    readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : []
    )
  return walk("components/marketing").map((path) => ({ path, source: read(path) }))
}

describe("the demo is built from the app's own session UI", () => {
  it("imports every shared session component and hook the Command Centre itself uses", () => {
    const demo = imports(read("components/marketing/demo/demo-command-centre.tsx"))
    const app = appImports()
    for (const [module, name] of SHARED_SESSION_UI) {
      expect(app.get(module)?.has(name), `CommandCentreView should use ${name}`).toBe(true)
      expect(demo.get(module)?.has(name), `the demo Command Centre should use ${name} from ${module}`).toBe(true)
    }
  })

  it("never draws an agent's activity itself: no timeline, inspector or status words of its own", () => {
    for (const { path, source } of marketingSources()) {
      // The parts are reached only through AgentActivity, the composite the app renders.
      expect(source, path).not.toMatch(/@\/components\/agents\/(agent-activity-timeline|action-inspector)"/)
      expect(source, path).not.toMatch(/buildAgentActivityTimeline|inspectActivityEntry/)
      // The timeline's and inspector's words come from the product's builders, never restated.
      for (const words of ["Waiting for approval", "Asked for approval", "Approval expired", "Workspace context loaded", "Requested by", "Undid creation", "Couldn't undo"]) {
        expect(source, `${path} restates "${words}"`).not.toContain(words)
      }
    }
  })

  it("never builds or words a Context Pack itself", () => {
    for (const { path, source } of marketingSources()) {
      expect(source, path).not.toMatch(/buildContextPack|contextPackRows|contextPackLine|resolveContext\(/)
      expect(source, path).not.toMatch(/@\/components\/agents\/context-pack-inspector"/)
      for (const words of ["What the agent receives", "read on request", "Changed since", "Context used"]) {
        expect(source, `${path} restates "${words}"`).not.toContain(words)
      }
    }
  })

  it("never draws agent history itself: no list, pane, status reading or reconstruction of its own", () => {
    for (const { path, source } of marketingSources()) {
      // History reaches the page only as the app's components and hook, fed the demo's records.
      expect(source, path).not.toMatch(/reconstructHistorySession|readHistoryDetail/)
      for (const words of ["Agent history unavailable", "No agent activity yet.", "Show older sessions", "Yesterday", "Worked in"]) {
        expect(source, `${path} restates "${words}"`).not.toContain(words)
      }
    }
    // And the demo's history is the product's persisted shape, made by the product's own reducers.
    expect(read("components/marketing/demo/data.ts")).toMatch(/historyEventOf[\s\S]*historyApprovalOf[\s\S]*historyChangeOf/)
  })
})

/* ------------------------------------------------------------------ *
 * Driven like a visitor
 * ------------------------------------------------------------------ */

let fetchSpy: ReturnType<typeof vi.fn>
const isFaviconLookup = (input: unknown) => String(input).includes("/api/favicon?")

beforeEach(() => {
  window.localStorage.clear()
  fetchSpy = vi.fn(() => Promise.reject(new Error("the demo must not fetch")))
  vi.stubGlobal("fetch", fetchSpy)
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})

afterEach(() => {
  // No credentials, no network, no storage: the demo works for anyone, every time.
  expect(window.localStorage.length).toBe(0)
  expect(fetchSpy.mock.calls.filter(([input]) => !isFaviconLookup(input))).toEqual([])
  vi.unstubAllGlobals()
})

function renderWindow(init: DemoInit) {
  const user = userEvent.setup()
  render(
    <HubbleDemoProvider init={init}>
      <DemoFrame palette label="Hubble demo">
        <DemoApp />
      </DemoFrame>
    </HubbleDemoProvider>
  )
  const frame = () => within(screen.getByRole("region", { name: "Hubble demo" }))
  const activity = () => within(within(frame().getByRole("complementary", { name: "Session context" })).getByRole("region", { name: "Activity" }))
  const titles = () =>
    activity()
      .getAllByRole("listitem")
      .map((row) => row.querySelector("[data-activity-title]")?.textContent)
      .filter(Boolean)
  return { user, frame, activity, titles }
}

describe("the demo shows what the product derives", () => {
  it("draws exactly the timeline Hubble's own builder makes from the demo's records", () => {
    const { titles, activity } = renderWindow({ view: "command-centre", selectedSessionId: CLAUDE_SESSION, contextPanelOpen: true })
    const session = DEMO_SESSIONS.find((entry) => entry.view.sessionId === CLAUDE_SESSION)!.view
    const expected = buildAgentActivityTimeline({
      session,
      events: DEMO_EVENTS[CLAUDE_SESSION]!,
      approvals: DEMO_APPROVALS[CLAUDE_SESSION]!,
      knownApprovals: DEMO_KNOWN_APPROVALS,
      agentName: "Claude Code",
      workspaceName: "Research",
      now: DEMO_NOW,
    })
    expect(titles()).toEqual([...expected].reverse().map((entry) => entry.title))
    // The workflow's opening, as the app tells it — with counts from the demo's own workspace.
    expect(titles()).toEqual([
      "Waiting for approval",
      "Replied",
      "Checked existing collections",
      "Found 3 relevant tabs",
      "Read workspace",
      "You sent a message",
      "Workspace context loaded",
      "Claude Code connected",
    ])
    // The same agent identity and status as the app's header.
    expect(activity().getByText("Claude Code")).toBeTruthy()
    expect(activity().getByText("Waiting for approval", { selector: ".text-meta" })).toBeTruthy()
  })

  it("walks the whole workflow: approve, the action runs, its result opens in the inspector, and Undo is recorded", async () => {
    const { user, frame, activity, titles } = renderWindow({ view: "command-centre", selectedSessionId: CLAUDE_SESSION, contextPanelOpen: true })

    await user.click(within(frame().getByRole("group", { name: "Approval required" })).getByRole("button", { name: /Allow/ }))
    // Approved is not done: the session runs, then the change is applied.
    const rows = () => activity().getAllByRole("listitem")
    expect(rows()[0]!.getAttribute("data-activity-status")).toBe("active")
    expect(titles()).toContain("Approved")
    expect(titles()).not.toContain("Created collection “SWE-bench”")
    await waitFor(() => expect(titles()).toContain("Created collection “SWE-bench”"), { timeout: 3_000 })
    // The run ends after the change is applied; until then its live "now" row stays on top, as in the app.
    await waitFor(() => expect(titles()[0]).toBe("Finished"), { timeout: 3_000 })

    await user.click(activity().getByRole("button", { name: /Created collection “SWE-bench”/ }))
    const article = activity().getByRole("article")
    const inspector = within(article)
    expect(article.getAttribute("data-action-status")).toBe("completed")
    expect(inspector.getByText("Requested by Claude Code")).toBeTruthy()
    expect(inspector.getByText("Create collection")).toBeTruthy()
    expect(inspector.getByText("Created “SWE-bench” in Research.")).toBeTruthy()
    expect(inspector.getByText("Collection “SWE-bench” · 3 tabs")).toBeTruthy()

    await user.click(inspector.getByRole("button", { name: "Undo" }))
    await user.click(inspector.getByRole("button", { name: "Undo change" }))
    await waitFor(() => expect(article.getAttribute("data-action-status")).toBe("undone"))

    await user.click(inspector.getByRole("button", { name: "All activity" }))
    expect(titles()[0]).toBe("Undid creation of “SWE-bench”")
    expect(titles()).toContain("Created collection “SWE-bench”")

    // And the demo's workspace really is back as it was.
    await user.click(frame().getByRole("button", { name: "Workspace" }))
    expect(frame().queryByText("SWE-bench")).toBeNull()
  })

  it("inspects a finished file edit with its approval, and offers no undo it cannot do", async () => {
    const { user, activity } = renderWindow({ view: "command-centre", selectedSessionId: CLAUDE_RELEASE_SESSION, contextPanelOpen: true })
    await user.click(activity().getByRole("button", { name: /Edited CHANGELOG.md/ }))
    const inspector = within(activity().getByRole("article"))
    expect(inspector.getByText("Requested by Claude Code")).toBeTruthy()
    expect(inspector.getByText("Edit file")).toBeTruthy()
    expect(inspector.getByText("Add a 0.9 section with the three changes from the Release checklist.")).toBeTruthy()
    expect(inspector.queryByRole("button", { name: /Undo/ })).toBeNull()
    expect(inspector.getByText(/^Undo isn't available for this change\./)).toBeTruthy()
  })
})

describe("the demo's agent history is the product's", () => {
  function historyPane(frame: () => ReturnType<typeof within>) {
    return within(frame().getByRole("region", { name: "Past agent session" }))
  }
  const paneTitles = (pane: ReturnType<typeof within>) =>
    pane
      .getAllByRole("listitem")
      .map((row: HTMLElement) => row.querySelector("[data-activity-title]")?.textContent)
      .filter(Boolean)

  it("lists the workspace's past sessions, with how each ended read for now, and none of another workspace's", () => {
    const { frame } = renderWindow({ view: "command-centre", selectedSessionId: null, contextPanelOpen: true })
    const history = within(frame().getByRole("region", { name: "Agent history" }))
    expect(history.getByRole("button", { name: /Group the product ideas/ }).textContent).toContain("Completed")
    expect(history.getByRole("button", { name: /Find themes in School/ }).textContent).toContain("Failed")
    // Recorded as running; its runtime is gone, so it is disconnected — never "Running".
    expect(history.getByRole("button", { name: /Summarise the course pages/ }).textContent).toContain("Disconnected")
    expect(history.queryByText(/Check the release links/)).toBeNull()
  })

  it("opens a past session into exactly the timeline Hubble's builder makes from the kept records", async () => {
    const { user, frame } = renderWindow({ view: "command-centre", selectedSessionId: null, contextPanelOpen: true })
    await user.click(within(frame().getByRole("region", { name: "Agent history" })).getByRole("button", { name: /Group the product ideas/ }))
    const pane = historyPane(frame)

    const reconstructed = reconstructHistorySession(DEMO_HISTORY.find((entry) => entry.session.sessionId === HISTORY_IDEAS_SESSION)!)
    const expected = buildAgentActivityTimeline({
      session: reconstructed.session,
      events: reconstructed.events,
      approvals: [],
      knownApprovals: reconstructed.knownApprovals,
      changes: reconstructed.changes,
      planOutcomes: reconstructed.planOutcomes,
      agentName: "Claude Code",
      workspaceName: "Research",
      now: DEMO_NOW,
    })
    expect(paneTitles(pane)).toEqual([...expected].reverse().map((entry) => entry.title))
    expect(paneTitles(pane)).toContain("Created collection “Product Ideas”")
    expect(paneTitles(pane)).toContain("Approved")
  })

  it("inspects the past action by reference and undoes it exactly, as a new entry after it", async () => {
    const { user, frame } = renderWindow({ view: "command-centre", selectedSessionId: null, contextPanelOpen: true })
    await user.click(within(frame().getByRole("region", { name: "Agent history" })).getByRole("button", { name: /Group the product ideas/ }))
    const pane = historyPane(frame)
    await user.click(pane.getByRole("button", { name: /Created collection “Product Ideas”/ }))
    const article = pane.getByRole("article")
    const inspector = within(article)
    expect(article.getAttribute("data-action-status")).toBe("completed")
    expect(inspector.getByText("Requested by Claude Code")).toBeTruthy()
    expect(inspector.getByText("Created “Product Ideas” in Research.")).toBeTruthy()

    await user.click(inspector.getByRole("button", { name: "Undo" }))
    await user.click(inspector.getByRole("button", { name: "Undo change" }))
    await waitFor(() => expect(article.getAttribute("data-action-status")).toBe("undone"))
    await user.click(inspector.getByRole("button", { name: "All activity" }))
    expect(paneTitles(pane)).toContain("Undid creation of “Product Ideas”")
    expect(paneTitles(pane)).toContain("Created collection “Product Ideas”")
  })

  it("refuses the past undo once the workspace has moved on — the same rule as the app", async () => {
    const { user, frame } = renderWindow({ view: "command-centre", selectedSessionId: CLAUDE_SESSION, contextPanelOpen: true })
    // Approve the live demo change: Research gains a collection, so the past change's snapshot no longer matches.
    await user.click(within(frame().getByRole("group", { name: "Approval required" })).getByRole("button", { name: /Allow/ }))
    await waitFor(() => expect(frame().getAllByText(/Created collection “SWE-bench”/).length).toBeGreaterThan(0), { timeout: 3_000 })

    await user.click(within(frame().getByRole("region", { name: "Agent history" })).getByRole("button", { name: /Group the product ideas/ }))
    const pane = historyPane(frame)
    await user.click(pane.getByRole("button", { name: /Created collection “Product Ideas”/ }))
    const inspector = within(pane.getByRole("article"))
    expect(inspector.queryByRole("button", { name: "Undo" })).toBeNull()
    expect(inspector.getByText(/the workspace has changed since/)).toBeTruthy()
  })
})

/* ------------------------------------------------------------------ *
 * Context Intelligence (Hubble 1.5)
 * ------------------------------------------------------------------ */

describe("the demo's context is the product's Context Pack", () => {
  it("starts each fixture session with the pack the product's recipe builds — a deterministic adapter, not a picture", () => {
    const state = createDemoState()
    const world = { ...emptyContextWorld(null), workspaces: state.store.workspaces, collections: state.collections, dependencies: state.dependencies }
    const claude = state.sessions.find((entry) => entry.view.sessionId === CLAUDE_SESSION)!.view
    const built = sessionContextPack({ world, workspaceId: claude.workspaceId!, sessionId: CLAUDE_SESSION, changes: [] })
    expect(built.ok).toBe(true)
    expect(claude.contextSnapshotId).toBe(built.ok ? contextPackId(built.pack) : "")
    expect(claude.contextDelivered).toBe(true)
    // Its first message records what it delivered, as the runtime's does.
    const first = state.events[CLAUDE_SESSION]!.find((event) => event.kind === "message_sent")!
    expect(first.delivery).toMatchObject({ workspaceId: claude.workspaceId, workspace: true })
    // Deterministic: two visits, one pack.
    expect(createDemoState().sessions.map((entry) => entry.view.contextSnapshotId)).toEqual(state.sessions.map((entry) => entry.view.contextSnapshotId))
  })

  it("shows the workspace brief and what the agent receives, with the app's own panel, and lets the visitor edit the brief", async () => {
    const { user, frame } = renderWindow({ view: "command-centre", selectedSessionId: CLAUDE_SESSION, contextPanelOpen: true })
    const panel = within(frame().getByRole("complementary", { name: "Session context" }))
    expect(panel.getByText(RESEARCH_BRIEF.description)).toBeTruthy()
    expect(panel.getByText(RESEARCH_BRIEF.focus)).toBeTruthy()
    const receives = within(panel.getByRole("region", { name: "What the agent receives" }))
    expect(receives.getByText("Claude Code has this")).toBeTruthy()

    await user.click(panel.getByRole("button", { name: "Edit brief for Research" }))
    const focus = panel.getByLabelText("Current focus")
    await user.clear(focus)
    await user.type(focus, "Picking a benchmark{Enter}")
    expect(panel.getByText("Picking a benchmark")).toBeTruthy()
    // The brief changed after the session was sent its pack: the app's own words say so.
    expect(receives.getByText("Changed since Claude Code received it")).toBeTruthy()
  })

  it("names the context an action ran with, from the delivery its session recorded", async () => {
    const { user, activity } = renderWindow({ view: "command-centre", selectedSessionId: CLAUDE_SESSION, contextPanelOpen: true })
    await user.click(activity().getByRole("button", { name: /Waiting for approval/ }))
    const used = screen.getByRole("list", { name: "Context used" })
    expect(within(used).getByText("Research workspace · Workspace brief")).toBeTruthy()
  })
})

/* ------------------------------------------------------------------ *
 * Project execution (Hubble 1.6)
 * ------------------------------------------------------------------ */

describe("the demo's project work is the product's", () => {
  it("is drawn with the app's own project section, change model and check vocabulary", () => {
    const demo = imports(read("components/marketing/demo/demo-command-centre.tsx"))
    const app = appImports()
    for (const [module, name] of [
      ["@/components/command-centre/workspace-project", "WorkspaceProjectSection"],
      ["@/hooks/use-session-context-pack", "measuredProjectFiles"],
    ] as const) {
      expect(app.get(module)?.has(name), `CommandCentreView should use ${name}`).toBe(true)
      expect(demo.get(module)?.has(name), `the demo should use ${name}`).toBe(true)
    }
    // The deterministic adapter measures with the product's diff and describes with its describer.
    const adapter = imports(read("components/marketing/demo/demo-project.ts"))
    expect(adapter.get("@/lib/agents/project/diff")?.has("lineDiff")).toBe(true)
    expect(adapter.get("@/lib/agents/project/describe")?.has("describeProject")).toBe(true)
    for (const { path, source } of marketingSources()) {
      // Every sentence about a project comes from lib/agents/project — never restated here.
      for (const words of ["Ready for agent work", "Project changes ·", "can't be undone because", "Hubble confirmed", "Typecheck passed", "Tests passed\"", "Agent may"]) {
        expect(source, `${path} restates "${words}"`).not.toContain(words)
      }
    }
  })

  it("starts Codex's session with the project in its Context Pack — the product's recipe and describer", async () => {
    const { DEVELOPMENT_ID, CODEX_AUTH_SESSION } = await import("./data")
    const { demoProjectDescriptor } = await import("./demo-project")
    const state = createDemoState()
    const codex = state.sessions.find((entry) => entry.view.sessionId === CODEX_AUTH_SESSION)!.view
    const built = sessionContextPack({
      world: { ...emptyContextWorld(null), workspaces: state.store.workspaces, collections: state.collections, dependencies: state.dependencies },
      workspaceId: DEVELOPMENT_ID,
      selection: { workspaceId: DEVELOPMENT_ID, tabIds: codex.focus!.tabIds, collectionIds: codex.focus!.collectionIds },
      sessionId: codex.sessionId,
      changes: [],
      project: demoProjectDescriptor(),
    })
    expect(built.ok && contextPackId(built.pack)).toBe(codex.contextSnapshotId)
    expect(built.ok && built.pack.project).toMatchObject({ name: "hubble", type: "nextjs", repository: { branch: "main" } })
  })

  it("walks the loop: project → approval → measured change → tests → inspector → review → undo", async () => {
    const { CODEX_AUTH_SESSION } = await import("./data")
    const { AUTH_FIX_EDIT } = await import("./demo-project")
    const { lineDiff } = await import("@/lib/agents/project/diff")
    const { user, frame, activity, titles } = renderWindow({ view: "command-centre", selectedSessionId: CODEX_AUTH_SESSION, contextPanelOpen: true })
    const panel = within(frame().getByRole("complementary", { name: "Session context" }))

    // The workspace's project, as the app shows it.
    const project = within(panel.getByRole("region", { name: "Project" }))
    expect(project.getByText("Connected")).toBeTruthy()
    expect(project.getByText("Next.js · Git main")).toBeTruthy()
    // What the agent receives names the project.
    const receives = within(panel.getByRole("region", { name: "What the agent receives" }))
    expect(receives.getByText("hubble")).toBeTruthy()

    // The approval card: two files, in the project, no invented line counts.
    const card = within(frame().getByRole("group", { name: "Approval required" }))
    expect(card.getByText(/Codex wants to modify 2 files/)).toBeTruthy()
    expect(card.queryByText(/\+\d+ −\d+/)).toBeNull()
    await user.click(card.getByRole("button", { name: "Approve changes" }))

    // Hubble's measurement, from the product's diff over the adapter's two versions.
    const totals = AUTH_FIX_EDIT.files.map((file) => lineDiff(file.before, file.after)).reduce((sum, diff) => ({ added: sum.added + diff.added, removed: sum.removed + diff.removed }), { added: 0, removed: 0 })
    await waitFor(() => expect(titles()).toContain("Changed 2 files"), { timeout: 3_000 })
    await waitFor(() => expect(titles()).toContain("Tests passed"), { timeout: 3_000 })
    await user.click(activity().getByRole("button", { name: /Changed 2 files/ }))
    const article = activity().getByRole("article")
    const inspector = within(article)
    expect(inspector.getByText("Applied — Hubble confirmed 2 files changed in hubble.")).toBeTruthy()
    const lines = AUTH_FIX_EDIT.files.map((file) => `${file.path} · +${lineDiff(file.before, file.after).added} −${lineDiff(file.before, file.after).removed}`)
    for (const line of lines) expect(inspector.getByText(line)).toBeTruthy()
    expect(totals.added).toBeGreaterThan(0)
    expect(within(inspector.getByRole("list", { name: "Verification" })).getByText("Tests passed")).toBeTruthy()

    await user.click(inspector.getByRole("button", { name: "Review changes" }))
    expect(await inspector.findByText(/The bug: verifyPassword is async/)).toBeTruthy()

    await user.click(inspector.getByRole("button", { name: "Undo" }))
    await user.click(inspector.getByRole("button", { name: "Undo change" }))
    await waitFor(() => expect(article.getAttribute("data-action-status")).toBe("undone"))
  })

  it("keeps a past project session read-only in history — measured, verified, and no undo", async () => {
    const { DEVELOPMENT_ID, HISTORY_EXPIRY_SESSION } = await import("./data")
    const state = createDemoState({ view: "command-centre", currentId: DEVELOPMENT_ID, selectedHistoryId: HISTORY_EXPIRY_SESSION })
    const detail = state.history.find((entry) => entry.session.sessionId === HISTORY_EXPIRY_SESSION)!
    expect(detail.records.events.find((event) => event.kind === "project_changed")?.projectChange?.files[0]).toMatchObject({ path: "src/lib/session.test.ts", change: "created" })

    const { user } = renderWindow({ view: "command-centre", currentId: DEVELOPMENT_ID, selectedHistoryId: HISTORY_EXPIRY_SESSION })
    await user.click(await screen.findByRole("button", { name: /Created src\/lib\/session.test.ts/ }))
    const inspector = within(screen.getByRole("article"))
    expect(within(inspector.getByRole("list", { name: "Verification" })).getByText("Tests passed")).toBeTruthy()
    expect(inspector.queryByRole("button", { name: "Undo" })).toBeNull()
    expect(inspector.queryByRole("button", { name: "Review changes" })).toBeNull()
    expect(inspector.getByText("Project changes can be undone only from the live session, while Hubble still holds the earlier version.")).toBeTruthy()
  })
})
