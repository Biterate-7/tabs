import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { CommandCentreView } from "./command-centre-view"
import { WorkspaceWorkStrip } from "@/components/workspace/workspace-work-strip"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import { createScriptedRuntime, scriptedApproval, scriptedEvent, scriptedSession, scriptedStatus } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { resetWorkspaceChanges } from "@/lib/agents/command-centre/workspace-activity"
import { lastTaskFor } from "@/lib/agents/command-centre/last-task"
import { saveCollectionState } from "@/lib/collections/persistence"
import { saveControlProjects } from "@/lib/agents/control/persistence"
import { createProject } from "@/lib/agents/control/projects"
import { createGrant } from "@/lib/agents/control/permissions"
import { runtimeFailure } from "@/lib/agents/runtime/protocol"
import { loopSummary, readLoopLog } from "@/lib/product/loop-log"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { RuntimeCommand } from "@/lib/agents/runtime/protocol"
import type { Workspace } from "@/lib/workspace/types"
import type { ProjectInspection } from "@/lib/agents/project/inspection"

/**
 * The developer loop (Stage 3), end to end through the real Command Centre on
 * the scripted runtime: open a project's workspace, see what an agent would
 * work on and with, give it a task, approve its change knowing what it serves,
 * get closure on the result, and come back to it.
 */

const T0 = 1_700_000_000_000

function workspace(id: string, name: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    tabs: [{ id: `${id}-t`, url: "https://owasp.org/sessions", normalizedUrl: "https://owasp.org/sessions", domain: "owasp.org", title: "Session Management Cheat Sheet" }],
    ...over,
  }
}

function world(options: { project?: boolean } = {}) {
  return buildContextWorld({
    ownerId: "owner-1",
    workspaces: [
      workspace("w-dev", "Development", {
        brief: { focus: "Password check bypass in the auth route", updatedAt: 1 },
        ...(options.project === false ? {} : { project: { projectId: "p1", attachedAt: 1 } }),
      }),
      workspace("w-research", "Research", { brief: { focus: "Pricing models", updatedAt: 1 } }),
    ],
    collections: [],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

const READY: Omit<ProjectInspection, "projectId" | "inspectedAt"> = {
  state: "ready",
  type: "nextjs",
  repository: { kind: "git", branch: "main", head: "0123456789ab" },
  checks: [{ id: "test", command: "npm run test — vitest run" }],
  files: [],
}

function seedProject() {
  const made = createProject(
    {
      id: "p1",
      name: "hubble-app",
      path: "C:/Projects/hubble-app",
      providers: ["claude-code"],
      permissions: createGrant(["read_workspace", "read_project", "write_project", "run_commands"], T0, "p1")!,
    },
    T0
  )
  if (!made.ok) throw new Error(made.reason)
  saveControlProjects({ version: 1, projects: [made.project] })
}

function runtimeWith(sessions: ReturnType<typeof scriptedSession>[] = []) {
  const runtime = createScriptedRuntime({ status: scriptedStatus({ projects: true }), sessions })
  runtime.setInspection("p1", READY)
  return runtime
}

function renderCentre(runtime: ScriptedRuntime, props: Partial<ComponentProps<typeof CommandCentreView>> = {}, options: { project?: boolean } = {}) {
  return render(
    <CommandCentreView world={world(options)} onClose={vi.fn()} client={runtime.client} poll={false} activeWorkspaceId="w-dev" onAttachWorkspaceProject={vi.fn()} {...props} />
  )
}

const commandsNamed = <N extends RuntimeCommand["name"]>(runtime: ScriptedRuntime, name: N) =>
  runtime.commands.filter((command): command is Extract<RuntimeCommand, { name: N }> => command.name === name)

const taskStatus = async () => within(await screen.findByRole("region", { name: "Task status" }))

/** The session after a finished task on the project: a fix, approved, measured. */
function finishedFix(runtime: ScriptedRuntime, options: { tests?: "passed" | "failed" } = {}) {
  runtime.pushEvents([
    scriptedEvent({ sessionId: "s1", kind: "message_sent", summary: "Message sent.", text: "Fix the authentication bug." }),
    scriptedEvent({ sessionId: "s1", kind: "approval_requested", approvalId: "ap1", summary: "Editing files" }),
    scriptedEvent({ sessionId: "s1", kind: "approval_granted", approvalId: "ap1" }),
    scriptedEvent({ sessionId: "s1", kind: "message_received", summary: "Reply.", text: "Fixed: the route awaits verifyPassword." }),
    scriptedEvent({ sessionId: "s1", kind: "run_completed", summary: "Finished." }),
    scriptedEvent({
      sessionId: "s1",
      kind: "project_changed",
      summary: "Changed 2 files · +17 −6",
      projectChange: {
        changeId: "ap1",
        projectId: "p1",
        outcome: "applied",
        files: [
          { path: "src/app/api/auth/route.ts", change: "modified", added: 12, removed: 4 },
          { path: "src/lib/session.ts", change: "modified", added: 5, removed: 2 },
        ],
        undo: "available",
      },
    }),
    ...(options.tests
      ? [scriptedEvent({ sessionId: "s1", kind: "verification_finished", summary: "Tests", verification: { checkId: "c1", projectId: "p1", check: "test", outcome: options.tests, exitCode: options.tests === "passed" ? 0 : 1, changeId: "ap1" } })]
      : []),
  ])
}

const fixSession = (over: Partial<ReturnType<typeof scriptedSession>> = {}) =>
  scriptedSession({ sessionId: "s1", workspaceId: "w-dev", projectId: "p1", status: "ready", ...over })

beforeEach(() => {
  window.localStorage.clear()
  saveCollectionState({ version: 1, collections: [] })
  resetWorkspaceChanges()
  seedConnectedAgent()
  seedProject()
})

describe("Scenario 1 — a developer opens a project's workspace", () => {
  it("says what the work is on: the project first, the workspace, and how to start", async () => {
    renderCentre(runtimeWith())
    expect(await screen.findByRole("heading", { name: "Work on hubble-app" })).toBeTruthy()
    expect(await screen.findByText(/Next\.js · Git main · in Development/)).toBeTruthy()
    expect(screen.getByText(/asks you before it changes a file/)).toBeTruthy()
    // The header names the project beside the workspace.
    expect(document.querySelector("[data-header-project]")?.textContent).toBe("hubble-app")
    // And how to start: an agent that can take a task.
    expect(within(screen.getByRole("region", { name: "Agents for this workspace" })).getByRole("button", { name: /^Start with / })).toBeTruthy()
    // The context panel leads with the project, right under where.
    const panel = within(await screen.findByRole("complementary", { name: "Session context" }))
    const headings = panel.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)
    expect(headings.slice(0, 2)).toEqual(["Working in", "Folder"])
    // The debugging sections are gone.
    expect(headings).not.toContain("Session")
    expect(headings).not.toContain("Agents")
  })

  it("offers to connect a project when the workspace has none, and keeps the tab-only path", async () => {
    const onAttach = vi.fn()
    renderCentre(runtimeWith(), { onAttachWorkspaceProject: onAttach }, { project: false })
    expect(await screen.findByRole("heading", { name: "Work on Development" })).toBeTruthy()
    expect(screen.getByText(/sees no other project/)).toBeTruthy()
    const connect = await screen.findAllByRole("button", { name: "Connect folder" })
    expect(connect.length).toBeGreaterThan(0)
  })

  it("never leaves the project 'Checking' when its inspection raced the project sync", async () => {
    const runtime = runtimeWith()
    // The runtime knows the project only once it has been told it — and the
    // sync is held until a look has already been refused as "not known".
    let told = false
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const client: RuntimeClient = {
      ...runtime.client,
      send: (async (command: RuntimeCommand) => {
        if (command.name === "authorize_projects") {
          await held
          const result = await runtime.client.send(command)
          told = true
          return result
        }
        if (command.name === "inspect_project" && !told) {
          setTimeout(release, 0)
          return runtimeFailure("project_scope_violation")
        }
        return runtime.client.send(command)
      }) as RuntimeClient["send"],
    }
    renderCentre(runtime, { client })
    const project = within(within(await screen.findByRole("complementary", { name: "Session context" })).getByRole("region", { name: "Folder" }))
    await waitFor(() => expect(project.getByText("Connected")).toBeTruthy())
    expect(screen.queryByText(/Checking the project/)).toBeNull()
  })
})

describe("Scenario 2 — a task that needs project files and research", () => {
  it("starts the agent with the project and the workspace's research in what it receives", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith()
    renderCentre(runtime)
    await screen.findByRole("heading", { name: "Work on hubble-app" })
    await user.type(await screen.findByLabelText("Ask an agent"), "Fix the authentication bug{Enter}")
    const dialog = within(await screen.findByRole("dialog", { name: "New agent session" }))
    await waitFor(() => expect((dialog.getByRole("button", { name: "Start session" }) as HTMLButtonElement).disabled).toBe(false))
    await user.click(dialog.getByRole("button", { name: "Start session" }))
    await waitFor(() => expect(commandsNamed(runtime, "create_session")).toHaveLength(1))
    const [create] = commandsNamed(runtime, "create_session")
    expect(create!.projectId).toBe("p1")
    expect(create!.workspaceId).toBe("w-dev")
    // The workspace's research (its tab) and the project both travel with it.
    expect(create!.contextSnapshot?.workspace.tabs.map((tab) => tab.title)).toEqual(["Session Management Cheat Sheet"])
    expect(create!.context?.snapshotId).toMatch(/^pack-/)
    // Nothing from another workspace.
    expect(JSON.stringify(create)).not.toContain("Pricing models")
    expect(JSON.stringify(create)).not.toContain("C:/Projects")
  })
})

describe("Scenario 3 — an approval the developer can answer confidently", () => {
  it("says which task it serves, what changes, where, and what each answer does", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith([fixSession({ status: "waiting_for_approval", awaitingApproval: true })])
    runtime.pushEvents([scriptedEvent({ sessionId: "s1", kind: "message_sent", summary: "Message sent.", text: "Fix the authentication bug." })])
    runtime.setApprovals([
      scriptedApproval({ sessionId: "s1", approvalId: "ap1", action: "modify_files", scope: "write_project", projectId: "p1", targets: ["src/app/api/auth/route.ts", "src/lib/session.ts"] }),
    ])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /Waiting for approval/ }))
    const card = within(await screen.findByRole("group", { name: "Approval required" }))
    expect(card.getByText("“Fix the authentication bug.”")).toBeTruthy()
    expect(card.getByText(/wants to modify 2 files/)).toBeTruthy()
    expect(card.getByText("hubble-app")).toBeTruthy()
    expect(card.getByText(/Hubble keeps a copy of the files first, so you can undo the change\. Deny: nothing changes\./)).toBeTruthy()
    // The task status says the agent needs the developer, and takes them to the card.
    const status = await taskStatus()
    expect(status.getByText("Needs you")).toBeTruthy()
    await user.click(status.getByRole("button", { name: "Show approval" }))
    expect(document.activeElement?.textContent).toBe("Deny")
    await user.click(card.getByRole("button", { name: "Approve changes" }))
    await waitFor(() => expect(commandsNamed(runtime, "respond_to_approval")).toEqual([{ name: "respond_to_approval", approvalId: "ap1", decision: "granted" }]))
    expect(readLoopLog().filter((record) => record.kind === "approval_answered")).toEqual([expect.objectContaining({ approved: true })])
  })

  it("never promises an undo for a file that may hold secrets", () => {
    // Covered where it is decided: the card's consequence line.
    return import("./approval-prompt").then(({ ApprovalPrompt }) => {
      render(
        <ul>
          <ApprovalPrompt
            approval={scriptedApproval({ action: "modify_files", scope: "write_project", projectId: "p1", targets: [".env.local"], projectFiles: [{ path: ".env.local", sensitive: true }] })}
            projectName="hubble-app"
            pending={false}
            now={T0}
            onRespond={vi.fn()}
          />
        </ul>
      )
      const line = document.querySelector("[data-approval-consequence]")!.textContent!
      expect(line).toMatch(/can't be fully undone/)
      expect(line).not.toMatch(/so you can undo/)
    })
  })
})

describe("Scenario 4 — closure on the result", () => {
  it("says what happened, what changed, whether tests passed, and offers review and tests", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith([fixSession()])
    finishedFix(runtime)
    runtime.setReview({
      changeId: "ap1",
      files: [{ path: "src/lib/session.ts", change: "modified", added: 1, removed: 1, hunks: [{ oldStart: 1, newStart: 1, lines: [{ sign: "-", text: "const valid = verifyPassword(p)" }, { sign: "+", text: "const valid = await verifyPassword(p)" }] }] }],
    })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    const status = await taskStatus()
    expect(status.getByText("Done")).toBeTruthy()
    expect(status.getByText("Changed 2 files in hubble-app")).toBeTruthy()
    expect(screen.getByRole("region", { name: "Task status" }).textContent).toContain("“Fix the authentication bug.” · +17 −6 · Checks not run")

    await user.click(status.getByRole("button", { name: "Review changes" }))
    expect(await status.findByText("const valid = await verifyPassword(p)")).toBeTruthy()
    await user.click(status.getByRole("button", { name: "Run tests: npm run test — vitest run" }))
    await waitFor(() => expect(commandsNamed(runtime, "run_project_check")).toEqual([{ name: "run_project_check", sessionId: "s1", check: "test" }]))
    expect(loopSummary().tasksReviewed).toBe(0) // reviewed results are counted against submitted tasks only
    expect(loopSummary().counts.result_reviewed).toBe(1)
    expect(loopSummary().counts.check_run).toBe(1)
  })

  it("flags failed tests as the thing to look at", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith([fixSession()])
    finishedFix(runtime, { tests: "failed" })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    expect((await taskStatus()).getByText(/Tests failed/)).toBeTruthy()
  })
})

describe("Scenario 5 — coming back", () => {
  it("remembers where the work was left, for the workspace and the start screen", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith([fixSession()])
    finishedFix(runtime, { tests: "passed" })
    const first = renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    await waitFor(() => expect(lastTaskFor("w-dev")).toMatchObject({ sessionId: "s1", state: "done", headline: "Changed 2 files in hubble-app", task: "Fix the authentication bug." }))
    expect(lastTaskFor("w-dev")!.facts).toEqual(["+17 −6", "Tests passed"])
    // Nothing of another workspace's.
    expect(lastTaskFor("w-research")).toBeUndefined()
    first.unmount()

    // The workspace, opened later.
    const onOpenTask = vi.fn()
    const strip = render(
      <WorkspaceWorkStrip workspace={world().workspaces[0]!} onOpenTask={onOpenTask} />
    )
    const work = within(screen.getByRole("region", { name: "Work in this workspace" }))
    expect(work.getByText("hubble-app")).toBeTruthy()
    expect(work.getByText(/Password check bypass/)).toBeTruthy()
    expect(work.getByText(/Changed 2 files in hubble-app/)).toBeTruthy()
    await user.click(work.getByRole("button", { name: /last task/ }))
    expect(onOpenTask).toHaveBeenCalledWith("s1")
    strip.unmount()

    // "Open" lands on the session; the start screen says where it was left.
    renderCentre(runtime, { openSessionId: "s1", onOpenSessionConsumed: vi.fn() })
    expect(await screen.findByRole("region", { name: "Task status" })).toBeTruthy()
  })

  it("shows where the work was left on the Command Centre's start screen", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith([fixSession()])
    finishedFix(runtime, { tests: "passed" })
    const first = renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    await waitFor(() => expect(lastTaskFor("w-dev")).toBeTruthy())
    first.unmount()

    renderCentre(runtime)
    const leftOff = within(await screen.findByRole("region", { name: "Where you left off" }))
    expect(leftOff.getByText(/Changed 2 files in hubble-app/)).toBeTruthy()
    expect(leftOff.getByText(/Tests passed/)).toBeTruthy()
    await user.click(await leftOff.findByRole("button", { name: "Open" }))
    expect(await screen.findByRole("region", { name: "Task status" })).toBeTruthy()
  })
})

describe("Scenario 6 — moving the work to another agent", () => {
  it("offers Continue with… from the finished task, and the handoff says what goes", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith([fixSession()])
    finishedFix(runtime)
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    await user.click((await taskStatus()).getByRole("button", { name: "Continue with…" }))
    const dialog = within(await screen.findByRole("dialog"))
    // From whom, in which workspace — and never the conversation itself.
    expect(dialog.getAllByText(/Claude Code/).length).toBeGreaterThan(0)
    expect(dialog.getAllByText(/Development/).length).toBeGreaterThan(0)
  })
})

describe("Agent state, said once", () => {
  it("never calls an agent that can start a session 'Not checked yet' in the list", async () => {
    renderCentre(runtimeWith())
    const roster = within(await screen.findByRole("region", { name: "Connected agents" }))
    await screen.findByRole("heading", { name: "Work on hubble-app" })
    expect(roster.queryByText(/Not checked yet/)).toBeNull()
  })
})

describe("the loop log", () => {
  it("counts the loop's milestones once each, with no content", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith([fixSession()])
    finishedFix(runtime)
    const first = renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    await waitFor(() => expect(loopSummary().counts.task_completed).toBe(1))
    first.unmount()
    // Reopened: the same task is not counted again.
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    await screen.findByRole("region", { name: "Task status" })
    expect(loopSummary().counts.task_completed).toBe(1)
    const stored = JSON.stringify(readLoopLog())
    for (const content of ["Fix the authentication", "hubble-app", "src/", "w-dev", "s1", "C:/"]) expect(stored).not.toContain(content)
  })
})
