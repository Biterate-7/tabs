import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { CommandCentreView } from "./command-centre-view"
import { ApprovalPrompt } from "./approval-prompt"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import { createScriptedRuntime, scriptedApproval, scriptedEvent, scriptedSession, scriptedStatus } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { resetWorkspaceChanges } from "@/lib/agents/command-centre/workspace-activity"
import { saveCollectionState } from "@/lib/collections/persistence"
import { saveControlProjects } from "@/lib/agents/control/persistence"
import { createProject } from "@/lib/agents/control/projects"
import { createGrant } from "@/lib/agents/control/permissions"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { RuntimeCommand } from "@/lib/agents/runtime/protocol"
import type { Workspace } from "@/lib/workspace/types"
import type { ProjectInspection } from "@/lib/agents/project/inspection"

/**
 * Project execution (Hubble 1.6) through the real Command Centre, against the
 * scripted runtime: the workspace's project, attaching one, the Context Pack
 * it gives the agent, the approval card for project changes, and the Action
 * Inspector's measured change, checks, review and undo.
 */

const T0 = 1_700_000_000_000

function workspace(id: string, name: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    tabs: [{ id: `${id}-t`, url: "https://nextjs.org/docs", normalizedUrl: "https://nextjs.org/docs", domain: "nextjs.org", title: "Next.js docs" }],
    ...over,
  }
}

function world(attached = true) {
  return buildContextWorld({
    ownerId: "owner-1",
    workspaces: [
      workspace("w-dev", "Development", {
        brief: { focus: "authentication", updatedAt: 1 },
        ...(attached ? { project: { projectId: "p1", attachedAt: 1 } } : {}),
      }),
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
  checks: [
    { id: "typecheck", command: "npm run typecheck — tsc --noEmit" },
    { id: "test", command: "npm run test — vitest run" },
  ],
  files: [],
}

function seedProject() {
  const made = createProject(
    {
      id: "p1",
      name: "hubble",
      path: "C:/Projects/hubble",
      providers: ["claude-code"],
      permissions: createGrant(["read_workspace", "read_project", "write_project", "run_commands"], T0, "p1")!,
    },
    T0
  )
  if (!made.ok) throw new Error(made.reason)
  saveControlProjects({ version: 1, projects: [made.project] })
}

function runtimeWith(over: { projects?: boolean; inspection?: Omit<ProjectInspection, "projectId" | "inspectedAt"> | null; sessions?: ReturnType<typeof scriptedSession>[] } = {}) {
  const runtime = createScriptedRuntime({
    status: scriptedStatus(over.projects === false ? {} : { projects: true }),
    ...(over.sessions ? { sessions: over.sessions } : {}),
  })
  if (over.inspection !== null) runtime.setInspection("p1", over.inspection ?? READY)
  return runtime
}

function renderCentre(runtime: ScriptedRuntime, props: Partial<ComponentProps<typeof CommandCentreView>> = {}, attached = true) {
  return render(<CommandCentreView world={world(attached)} onClose={vi.fn()} client={runtime.client} poll={false} activeWorkspaceId="w-dev" {...props} />)
}

const commandsNamed = <N extends RuntimeCommand["name"]>(runtime: ScriptedRuntime, name: N) =>
  runtime.commands.filter((command): command is Extract<RuntimeCommand, { name: N }> => command.name === name)

const panel = async () => within(await screen.findByRole("complementary", { name: "Session context" }))
const projectSection = async () => within((await panel()).getByRole("region", { name: "Folder" }))

beforeEach(() => {
  window.localStorage.clear()
  saveCollectionState({ version: 1, collections: [] })
  resetWorkspaceChanges()
  seedConnectedAgent()
  seedProject()
})

describe("the workspace's project", () => {
  it("is connected, described, and says exactly what agents may do there", async () => {
    renderCentre(runtimeWith())
    const section = await projectSection()
    await waitFor(() => expect(section.getByText("Connected")).toBeTruthy())
    expect(section.getByText("hubble")).toBeTruthy()
    expect(section.getByText("Next.js · Git main")).toBeTruthy()
    expect(section.getByText("Ready for agent work")).toBeTruthy()
    expect(section.getByRole("list", { name: "What the agent may do in this project" }).textContent).toBe(
      "Read filesModify files · asks firstRun commands · asks firstInspect repositoryRun checks"
    )
    // The path never reaches the screen.
    expect(document.body.textContent).not.toContain("C:/Projects")
  })

  it("is unsupported where no runtime can reach local files — and says where it is", async () => {
    renderCentre(runtimeWith({ projects: false }))
    const section = await projectSection()
    await waitFor(() => expect(section.getByText("Unsupported")).toBeTruthy())
    expect(section.getByText("Project work is available in the Hubble desktop app.")).toBeTruthy()
    expect(section.queryByRole("button", { name: "Connect folder" })).toBeNull()
  })

  it("says when the project moved since it was attached, and can check again", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith({ inspection: { ...READY, state: "missing", checks: [] } })
    renderCentre(runtime, { onAttachWorkspaceProject: vi.fn() })
    const section = await projectSection()
    await waitFor(() => expect(section.getByText("Moved or deleted")).toBeTruthy())
    expect(section.getByText("Project changed. This project has moved or been deleted since it was connected.")).toBeTruthy()
    runtime.setInspection("p1", READY)
    await user.click(section.getByRole("button", { name: "Check again" }))
    await waitFor(() => expect(section.getByText("Connected")).toBeTruthy())
  })

  it("is attached by choosing a project, seeing what Hubble found, and confirming", async () => {
    const user = userEvent.setup()
    const onAttachWorkspaceProject = vi.fn()
    renderCentre(runtimeWith(), { onAttachWorkspaceProject }, false)
    const section = await projectSection()
    await waitFor(() => expect(section.getByText("No folder connected")).toBeTruthy())
    expect(section.getByText("Connect a folder so agents can work on its files.")).toBeTruthy()
    await user.click(section.getByRole("button", { name: "Connect folder" }))

    const dialog = within(await screen.findByRole("dialog", { name: "Connect a folder" }))
    const attach = dialog.getByRole("button", { name: "Connect folder" })
    expect((attach as HTMLButtonElement).disabled).toBe(true)
    await user.click(dialog.getByRole("button", { name: /hubble/ }))
    await waitFor(() => expect(dialog.getByText("Next.js · Git main · 2 checks")).toBeTruthy())
    expect(dialog.getByText("Read files · Modify files · asks first · Run commands · asks first · Inspect repository · Run checks")).toBeTruthy()
    await user.click(attach)
    expect(onAttachWorkspaceProject).toHaveBeenCalledWith("w-dev", "p1")
  })

  it("is detached without revoking anything", async () => {
    const user = userEvent.setup()
    const onAttachWorkspaceProject = vi.fn()
    renderCentre(runtimeWith(), { onAttachWorkspaceProject })
    const section = await projectSection()
    await user.click(await section.findByRole("button", { name: "Disconnect hubble from this workspace" }))
    expect(onAttachWorkspaceProject).toHaveBeenCalledWith("w-dev", null)
  })

  it("is the project of the workspace on screen — a request brought from another workspace never shows the active one's", async () => {
    const user = userEvent.setup()
    const onAttachWorkspaceProject = vi.fn()
    const twoWorkspaces = buildContextWorld({
      ownerId: "owner-1",
      workspaces: [
        workspace("w-dev", "Development", { brief: { focus: "authentication", updatedAt: 1 }, project: { projectId: "p1", attachedAt: 1 } }),
        workspace("w-res", "Research", { brief: { focus: "pricing", updatedAt: 1 } }),
      ],
      collections: [],
      dependencies: [],
      manualConnections: [],
      projects: [],
      agents: [],
      runs: [],
    })
    render(
      <CommandCentreView
        world={twoWorkspaces}
        onClose={vi.fn()}
        client={runtimeWith().client}
        poll={false}
        activeWorkspaceId="w-dev"
        onAttachWorkspaceProject={onAttachWorkspaceProject}
        handoff={{ id: "h-res", context: { workspaceId: "w-res", tabIds: ["w-res-t"], collectionIds: [] }, mode: "ask", intent: "summarize" }}
      />
    )

    expect(await screen.findByRole("heading", { name: "Work on Research" })).toBeTruthy()
    const section = await projectSection()
    // Research has no project: Development's must not be shown as this context's.
    await waitFor(() => expect(section.getByText("No folder connected")).toBeTruthy())
    expect(section.queryByText("hubble")).toBeNull()
    await user.click(section.getByRole("button", { name: "Connect folder" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Connect a folder" }))
    await user.click(dialog.getByRole("button", { name: /hubble/ }))
    const attach = dialog.getByRole("button", { name: "Connect folder" })
    await waitFor(() => expect((attach as HTMLButtonElement).disabled).toBe(false))
    await user.click(attach)
    expect(onAttachWorkspaceProject).toHaveBeenCalledWith("w-res", "p1")
  })

  it("is told to the runtime as bound to its workspace", async () => {
    const runtime = runtimeWith()
    renderCentre(runtime)
    await waitFor(() => expect(commandsNamed(runtime, "authorize_projects").length).toBeGreaterThan(0))
    expect(commandsNamed(runtime, "authorize_projects").at(-1)!.projects).toEqual([expect.objectContaining({ id: "p1", workspaceIds: ["w-dev"] })])
  })
})

describe("starting work in the project", () => {
  it("starts a new session in the workspace's project, with the project in its Context Pack", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith()
    renderCentre(runtime)
    await waitFor(async () => expect((await projectSection()).getByText("Connected")).toBeTruthy())
    await user.click(within(await screen.findByRole("region", { name: "Agents for this workspace" })).getByRole("button", { name: /^Start with / }))
    const dialog = within(await screen.findByRole("dialog", { name: "New agent session" }))
    expect(dialog.getByText("hubble · Ready for agent work")).toBeTruthy()
    await user.click(dialog.getByRole("button", { name: /start session/i }))

    await waitFor(() => expect(commandsNamed(runtime, "create_session")).toHaveLength(1))
    const created = commandsNamed(runtime, "create_session")[0]!
    expect(created.projectId).toBe("p1")
    const project = created.context!.attachments.find((attachment) => attachment.kind === "project")
    expect(project).toMatchObject({ id: "p1", label: "hubble" })
    expect(project!.detail).toContain("Next.js project · Git branch main")
    expect(JSON.stringify(created)).not.toContain("C:/Projects")
  })

  it("will not start in a project that cannot be reached", async () => {
    const user = userEvent.setup()
    renderCentre(runtimeWith({ inspection: { ...READY, state: "permission_denied", checks: [] } }))
    await waitFor(async () => expect((await projectSection()).getByText("Permission denied")).toBeTruthy())
    await user.click(within(await screen.findByRole("region", { name: "Agents for this workspace" })).getByRole("button", { name: /^Start with / }))
    const dialog = within(await screen.findByRole("dialog", { name: "New agent session" }))
    expect(dialog.getByText("hubble · Permission denied. Hubble doesn't have permission to access this project.")).toBeTruthy()
    expect((dialog.getByRole("button", { name: /start session/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("the approval card for project changes", () => {
  it("lists the files, flags secrets and outside edits, and invents no diff", async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    render(
      <ul>
        <ApprovalPrompt
          approval={scriptedApproval({
            provider: "openai-codex",
            action: "modify_files",
            scope: "write_project",
            projectId: "p1",
            targets: ["src/app/api/auth.ts", "src/lib/session.ts", ".env.local"],
            projectFiles: [{ path: "src/app/api/auth.ts", changedOutside: true }, { path: "src/lib/session.ts" }, { path: ".env.local", sensitive: true }],
          })}
          projectName="hubble"
          pending={false}
          now={T0}
          onRespond={respond}
        />
      </ul>
    )
    const card = within(screen.getByRole("group", { name: "Approval required" }))
    expect(card.getByText(/Codex wants to modify 3 files/)).toBeTruthy()
    expect(card.getByText("Project changes · 3 files")).toBeTruthy()
    expect(card.getByText("May hold secrets — Hubble won't read or copy it, so this can't be undone.")).toBeTruthy()
    expect(card.getByText("Changed since this session last saw it — by you or another tool.")).toBeTruthy()
    expect(card.queryByText(/\+\d+ −\d+/)).toBeNull()
    await user.click(card.getByRole("button", { name: "Review · 2 to check" }))
    expect(card.getByText(/then measures exactly what changed/)).toBeTruthy()
    await user.click(card.getByRole("button", { name: "Approve changes" }))
    expect(respond).toHaveBeenCalledWith(expect.any(String), "granted")
  })
})

describe("a measured change in the Action Inspector", () => {
  function changedSession(runtime: ScriptedRuntime) {
    runtime.pushEvents([
      scriptedEvent({ sessionId: "s1", kind: "approval_requested", approvalId: "ap1", summary: "Editing files" }),
      scriptedEvent({ sessionId: "s1", kind: "approval_granted", approvalId: "ap1" }),
      scriptedEvent({
        sessionId: "s1",
        kind: "project_changed",
        summary: "Changed 2 files · +34 −12",
        projectChange: {
          changeId: "ap1",
          projectId: "p1",
          outcome: "applied",
          files: [
            { path: "src/app/api/auth.ts", change: "modified", added: 30, removed: 10 },
            { path: "src/lib/session.ts", change: "modified", added: 4, removed: 2 },
          ],
          undo: "available",
        },
      }),
      scriptedEvent({ sessionId: "s1", kind: "verification_finished", summary: "Typecheck passed", verification: { checkId: "c1", projectId: "p1", check: "typecheck", outcome: "passed", exitCode: 0, durationMs: 4000, changeId: "ap1" } }),
    ])
  }

  async function openChange(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    const side = await panel()
    await user.click(await side.findByRole("button", { name: /Changed 2 files/ }))
    return within(await screen.findByRole("article"))
  }

  const session = () => scriptedSession({ sessionId: "s1", workspaceId: "w-dev", projectId: "p1", status: "ready" })

  it("tells what Hubble measured, separately from whether it was verified", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith({ sessions: [session()] })
    changedSession(runtime)
    renderCentre(runtime)
    const inspector = await openChange(user)
    expect(inspector.getByText("Applied — Hubble confirmed 2 files changed in hubble.")).toBeTruthy()
    expect(inspector.getByText("src/app/api/auth.ts · +30 −10")).toBeTruthy()
    expect(within(inspector.getByRole("list", { name: "Verification" })).getByText("Typecheck passed")).toBeTruthy()
  })

  it("reviews the real changed lines, and runs a named check", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith({ sessions: [session()] })
    changedSession(runtime)
    runtime.setReview({
      changeId: "ap1",
      files: [{ path: "src/lib/session.ts", change: "modified", added: 1, removed: 1, hunks: [{ oldStart: 1, newStart: 1, lines: [{ sign: "-", text: "return null" }, { sign: "+", text: "return session" }] }] }],
    })
    renderCentre(runtime)
    const inspector = await openChange(user)
    await user.click(inspector.getByRole("button", { name: "Review changes" }))
    expect(await inspector.findByText("return session")).toBeTruthy()
    await user.click(inspector.getByRole("button", { name: "Run tests: npm run test — vitest run" }))
    await waitFor(() => expect(commandsNamed(runtime, "run_project_check")).toEqual([{ name: "run_project_check", sessionId: "s1", check: "test" }]))
  })

  it("undoes through the runtime, and says why when it refuses", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith({ sessions: [session()] })
    changedSession(runtime)
    runtime.setUndoResult({ outcome: "refused", reason: "changed", files: 0 })
    renderCentre(runtime)
    const inspector = await openChange(user)
    await user.click(inspector.getByRole("button", { name: "Undo" }))
    expect(inspector.getByText(/only if nothing else has changed them since/)).toBeTruthy()
    await user.click(inspector.getByRole("button", { name: "Undo change" }))
    expect(await inspector.findByText(/This change can't be undone because the project has changed since it was made/)).toBeTruthy()
    expect(commandsNamed(runtime, "undo_project_change")).toEqual([{ name: "undo_project_change", sessionId: "s1", changeId: "ap1" }])
    // No forcing it.
    expect(inspector.queryByRole("button", { name: "Try again" })).toBeNull()
  })
})
