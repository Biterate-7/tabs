import { afterEach, describe, expect, it } from "vitest"
import { forgetProjectActivity, parseProjectActivity, projectActivitySnapshot, projectEventsIn, recordProjectEvent, recordProjectTask, MAX_EVENTS_PER_PROJECT } from "./activity"
import { contextSummary, projectState } from "./state"
import { setStorageNamespace } from "@/lib/storage/namespace"
import type { LastTask } from "@/lib/agents/command-centre/last-task"
import type { Tab } from "@/lib/tabs/types"

afterEach(() => {
  localStorage.clear()
  setStorageNamespace(null)
})

const task = (over: Partial<LastTask> = {}): LastTask => ({
  workspaceId: "w",
  sessionId: "s1",
  provider: "claude-code",
  state: "working",
  headline: "Reading sources",
  task: "Find the strongest arguments.",
  facts: [],
  attention: false,
  at: 1_000,
  ...over,
})

describe("project activity", () => {
  it("records what happened, per project, newest first — counts and ids, never titles or addresses", () => {
    recordProjectEvent({ workspaceId: "w", kind: "project_created", at: 1 })
    recordProjectEvent({ workspaceId: "w", kind: "sources_added", count: 3, origin: "chrome", at: 2 })
    recordProjectEvent({ workspaceId: "other", kind: "sources_added", count: 9, origin: "extension", at: 3 })
    const events = projectEventsIn(projectActivitySnapshot(), "w")
    expect(events.map((event) => event.kind)).toEqual(["sources_added", "project_created"])
    expect(JSON.stringify(events)).not.toMatch(/https?:/)
  })

  it("keeps one entry per task, updated as it moves, never moving back in time", () => {
    recordProjectTask(task())
    recordProjectTask(task({ state: "done", headline: "Analyzed 8 sources", at: 2_000 }), "8 sources · project brief")
    recordProjectTask(task({ state: "working", at: 1_500 }))
    const tasks = projectEventsIn(projectActivitySnapshot(), "w").filter((event) => event.kind === "task")
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ state: "done", headline: "Analyzed 8 sources", context: "8 sources · project brief" })
  })

  it("is bounded per project, so one busy project never pushes another's history out", () => {
    for (let index = 0; index < MAX_EVENTS_PER_PROJECT + 20; index++) recordProjectEvent({ workspaceId: "busy", kind: "source_ready", tabId: `t${index}`, at: index + 10 })
    recordProjectEvent({ workspaceId: "quiet", kind: "project_created", at: 1 })
    expect(projectEventsIn(projectActivitySnapshot(), "busy")).toHaveLength(MAX_EVENTS_PER_PROJECT)
    expect(projectEventsIn(projectActivitySnapshot(), "quiet")).toHaveLength(1)
  })

  it("is partitioned by account and forgotten with its project", () => {
    recordProjectEvent({ workspaceId: "w", kind: "project_created", at: 1 })
    setStorageNamespace("someone-else")
    expect(projectEventsIn(projectActivitySnapshot(), "w")).toEqual([])
    setStorageNamespace(null)
    forgetProjectActivity("w")
    expect(projectEventsIn(projectActivitySnapshot(), "w")).toEqual([])
  })

  it("reads stored garbage as nothing", () => {
    expect(parseProjectActivity("{nope")).toEqual([])
    expect(parseProjectActivity(JSON.stringify({ version: 1, events: [{ id: "x", workspaceId: "w", kind: "explode", at: 1 }] }))).toEqual([])
  })
})

describe("project state", () => {
  const source = (status: "ready" | "failed" | "pending"): Tab => ({
    id: status,
    url: `https://a.example/${status}`,
    normalizedUrl: `https://a.example/${status}`,
    domain: "a.example",
    resource: { kind: "webpage", origin: "chrome", status, addedAt: 1, updatedAt: 1, ...(status === "ready" ? { content: { chars: 1, extractedAt: 1 } } : {}) },
  })

  it("suggests only what follows from the state", () => {
    expect(projectState({ workspace: { tabs: [] }, events: [] }).next?.kind).toBe("add_sources")
    expect(projectState({ workspace: { tabs: [source("ready"), source("failed")] }, events: [] }).next).toMatchObject({ kind: "fix_sources", count: 1 })
    // A site that keeps its content private (ChatGPT, Drive) is saved fine — there is nothing to fix.
    const unavailable: Tab = { ...source("pending"), id: "blocked", resource: { ...source("pending").resource!, status: "partial", error: { code: "blocked", message: "Content unavailable — this site doesn't allow automated reading.", retryable: false } } }
    expect(projectState({ workspace: { tabs: [source("ready"), unavailable] }, events: [] }).next?.kind).toBe("first_task")
    expect(projectState({ workspace: { tabs: [source("ready")] }, events: [] }).next?.kind).toBe("first_task")
    expect(projectState({ workspace: { tabs: [source("ready")] }, lastTask: task({ state: "needs_you" }), events: [] }).next?.kind).toBe("answer_agent")
    expect(projectState({ workspace: { tabs: [source("ready")] }, lastTask: task({ state: "done" }), events: [] }).next?.kind).toBe("continue_with_another")
    expect(projectState({ workspace: { tabs: [source("ready")] }, lastTask: task({ state: "failed" }), events: [] }).next?.kind).toBe("retry_task")
  })

  it("says what a task was given, counted", () => {
    expect(contextSummary({ sources: 8, files: 2, brief: true, previousResult: true })).toBe("8 sources · 2 files · project brief · previous result")
    expect(contextSummary({ sources: 1, brief: false, previousResult: false })).toBe("1 source")
  })
})
