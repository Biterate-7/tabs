import { beforeEach, describe, expect, it } from "vitest"
import { createDefaultWorkspace } from "@/lib/workspace/migration"
import { greeting, isPristineDefault, loadSubjectsStarted, markSubjectsStarted, recentResources, subjectName, visibleSubjects } from "./subjects"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

function store(workspaces: Workspace[]): WorkspaceStore {
  return { version: 1, currentId: workspaces[0]!.id, workspaces }
}

const tab = (id: string, addedAt: number) => ({
  id,
  url: `https://example.com/${id}`,
  normalizedUrl: `https://example.com/${id}`,
  domain: "example.com",
  createdAt: addedAt,
})

beforeEach(() => window.localStorage.clear())

describe("subjects", () => {
  it("names an unnamed workspace without saying 'workspace' or 'project'", () => {
    expect(subjectName({ name: "  " })).toBe("Untitled subject")
    expect(subjectName({ name: " History HL " })).toBe("History HL")
  })

  it("treats only the untouched default as 'no subjects yet'", () => {
    const pristine = createDefaultWorkspace()
    expect(isPristineDefault(pristine)).toBe(true)
    expect(visibleSubjects(store([pristine]))).toEqual([])
    // Anything the student did to it makes it theirs.
    expect(isPristineDefault({ ...pristine, tabs: [tab("a", 1)] })).toBe(false)
    expect(isPristineDefault({ ...pristine, name: "History HL" })).toBe(false)
    expect(isPristineDefault({ ...pristine, brief: { description: "WW1", updatedAt: 1 } })).toBe(false)
    // And with more than one workspace, every one is shown.
    const other = { ...createDefaultWorkspace(), id: "other", name: "Math" }
    expect(visibleSubjects(store([pristine, other]))).toHaveLength(2)
  })

  it("shows a first subject the student called General, once subjects have started", () => {
    const general = createDefaultWorkspace()
    expect(visibleSubjects(store([general]), true)).toEqual([general])
  })

  it("remembers that subjects have started", () => {
    expect(loadSubjectsStarted()).toBe(false)
    markSubjectsStarted()
    expect(loadSubjectsStarted()).toBe(true)
  })

  it("greets by the local hour", () => {
    expect(greeting(8)).toBe("Good morning")
    expect(greeting(14)).toBe("Good afternoon")
    expect(greeting(21)).toBe("Good evening")
    expect(greeting(2)).toBe("Good evening")
  })

  it("lists the newest resources across subjects, newest first", () => {
    const a: Workspace = { ...createDefaultWorkspace(), id: "a", name: "History", tabs: [tab("old", 1), tab("new", 30)] }
    const b: Workspace = { ...createDefaultWorkspace(), id: "b", name: "Math", tabs: [tab("mid", 20)] }
    expect(recentResources([a, b], 2).map((entry) => `${entry.workspace.name}:${entry.tab.id}`)).toEqual(["History:new", "Math:mid"])
  })
})
