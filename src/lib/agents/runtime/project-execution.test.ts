import { beforeEach, describe, expect, it } from "vitest";
import { createRuntimeHost } from "./host";
import { createScriptedAdapter } from "./__fixtures__/adapter";
import { createMemoryProjectHost } from "@/lib/agents/project/__fixtures__/memory-project-host";
import { historyEventOf, reviveHistoryEvent } from "@/lib/agents/activity/history";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type { AuthorizedProjectInput, RuntimeApprovalView, SequencedControlEvent } from "./protocol";
import type { ScriptedAdapter } from "./__fixtures__/adapter";
import type { MemoryProjectHost } from "@/lib/agents/project/__fixtures__/memory-project-host";

/**
 * Project execution through the real host (Hubble 1.6): an approved write is
 * snapshotted before the agent is unblocked, measured after it writes,
 * recorded as Hubble's own event, undoable only while exact, checkable, and
 * bounded by ownership and workspace.
 */

const T0 = 1_700_000_000_000;
const ROOT = "C:/work/hubble";
const ALICE: RuntimeActor = { id: "account:alice" };
const BOB: RuntimeActor = { id: "account:bob" };
const LOCAL: ExecutionGateResult = { allowed: true, environment: "local", kind: "local", decision: { allowed: true, kind: "local-server" } };

const AUTH_BEFORE = "export function login() {\n  return false\n}\n";
const AUTH_AFTER = "export function login(user: string) {\n  if (!user) return false\n  return true\n}\n";

function project(over: Partial<AuthorizedProjectInput> = {}): AuthorizedProjectInput {
  return {
    id: "p1",
    name: "Hubble",
    path: ROOT,
    providers: ["claude-code"],
    additionalDirectories: [],
    permissions: { scopes: ["read_workspace", "read_project", "write_project", "run_commands"], projectId: "p1", grantedAt: T0 },
    workspaceIds: ["w-dev"],
    ...over,
  };
}

let adapter: ScriptedAdapter;
let files: MemoryProjectHost;

function build(options: { projects?: MemoryProjectHost | null } = {}) {
  let counter = 0;
  return createRuntimeHost({
    gate: LOCAL,
    resolveAdapter: () => adapter,
    providers: ["claude-code"],
    now: () => T0,
    createId: () => `id${++counter}`,
    runtimeId: "runtime-1",
    ...(options.projects === null ? {} : { projects: options.projects ?? files }),
  });
}

type Host = ReturnType<typeof build>;

async function start(host: Host, actor: RuntimeActor = ALICE, workspaceId = "w-dev") {
  const authorized = await host.execute(actor, { name: "authorize_projects", projects: [project()] });
  expect(authorized.ok).toBe(true);
  const started = await host.execute(actor, { name: "create_session", provider: "claude-code", projectId: "p1", workspaceId });
  if (!started.ok) throw new Error(started.error.code);
  return started.value.sessionId;
}

async function events(host: Host, sessionId: string, actor: RuntimeActor = ALICE): Promise<SequencedControlEvent[]> {
  const result = await host.execute(actor, { name: "get_events", sessionId });
  return result.ok ? [...result.value.events] : [];
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

const eventOf = (host: Host, sessionId: string, kind: SequencedControlEvent["kind"]) =>
  until(async () => (await events(host, sessionId)).filter((event) => event.kind === kind).pop());

/** The agent asks to edit, the person approves, the agent writes and reports it. */
async function approvedEdit(host: Host, sessionId: string, approvalId = "ap1", write: () => void = () => files.write(ROOT, "src/auth.ts", AUTH_AFTER)) {
  adapter.stageApproval(approvalId, { sessionId, action: "modify_files", scope: "write_project", projectId: "p1", targets: ["src/auth.ts"] });
  adapter.emit({ sessionId, kind: "approval_requested", approvalId });
  const answered = await host.execute(ALICE, { name: "respond_to_approval", approvalId, decision: "granted" });
  expect(answered.ok).toBe(true);
  write();
  adapter.emit({ sessionId, kind: "file_modified", file: { relativePath: "src/auth.ts", projectId: "p1" } });
  return eventOf(host, sessionId, "project_changed");
}

beforeEach(() => {
  adapter = createScriptedAdapter({ now: () => T0 });
  files = createMemoryProjectHost({
    [ROOT]: {
      files: { "src/auth.ts": AUTH_BEFORE, ".env": "SECRET=1" },
      manifest: { dependencies: { next: "16" }, scripts: { typecheck: "tsc --noEmit", test: "vitest run" } },
      git: { branch: "main", head: "0123456789ab" },
    },
  });
});

describe("project inspection and readiness", () => {
  it("inspects an authorized project and says what it is — never its path", async () => {
    const host = build();
    await host.execute(ALICE, { name: "authorize_projects", projects: [project()] });
    const inspected = await host.execute(ALICE, { name: "inspect_project", projectId: "p1", workspaceId: "w-dev", files: ["src/auth.ts", ".env"] });
    expect(inspected.ok && inspected.value).toMatchObject({
      projectId: "p1",
      state: "ready",
      type: "nextjs",
      repository: { kind: "git", branch: "main", head: "0123456789ab" },
      checks: [{ id: "typecheck" }, { id: "test" }, { id: "git_status" }],
      files: [{ path: "src/auth.ts", state: "present" }, { path: ".env", state: "sensitive" }],
    });
    expect(JSON.stringify(inspected)).not.toContain(ROOT);
  });

  it("reports a runtime that can work on projects, and one that cannot", async () => {
    const withProjects = await build().execute(ALICE, { name: "get_status" });
    expect(withProjects.ok && withProjects.value.projects).toBe(true);
    const without = await build({ projects: null }).execute(ALICE, { name: "get_status" });
    expect(without.ok && without.value.projects).toBeUndefined();
    const host = build({ projects: null });
    await host.execute(ALICE, { name: "authorize_projects", projects: [project()] });
    expect(await host.execute(ALICE, { name: "inspect_project", projectId: "p1" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("refuses to start an agent in a project that is not there", async () => {
    files.projects.get(ROOT)!.state = "missing";
    const host = build();
    await host.execute(ALICE, { name: "authorize_projects", projects: [project()] });
    const started = await host.execute(ALICE, { name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-dev" });
    expect(started).toMatchObject({ ok: false, error: { code: "project_unavailable", message: "Hubble can't access this project." } });
    expect(adapter.calls).not.toContain("createSession");
  });

  it("keeps a project to the workspaces it is attached to", async () => {
    const host = build();
    await host.execute(ALICE, { name: "authorize_projects", projects: [project()] });
    const elsewhere = await host.execute(ALICE, { name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-other" });
    expect(elsewhere).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });
    expect(await host.execute(ALICE, { name: "inspect_project", projectId: "p1", workspaceId: "w-other" })).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });
  });

  it("never lets one account reach another's project", async () => {
    const host = build();
    await host.execute(ALICE, { name: "authorize_projects", projects: [project()] });
    expect(await host.execute(BOB, { name: "inspect_project", projectId: "p1" })).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });
  });
});

describe("an approved project change", () => {
  it("is copied before the agent is told, then measured after it writes", async () => {
    const host = build();
    const sessionId = await start(host);
    // The agent writes *before* it should have been able to: the copy must still be the original.
    let snapshotTakenBeforeAnswer = false;
    const originalRespond = adapter.respondToApproval.bind(adapter);
    adapter.respondToApproval = async (id, decision) => {
      snapshotTakenBeforeAnswer = files.projects.get(ROOT)!.files.get("src/auth.ts") === AUTH_BEFORE;
      return originalRespond(id, decision);
    };
    const changed = await approvedEdit(host, sessionId);
    expect(snapshotTakenBeforeAnswer).toBe(true);
    expect(changed.projectChange).toEqual({
      changeId: "ap1",
      projectId: "p1",
      outcome: "applied",
      files: [{ path: "src/auth.ts", change: "modified", added: 3, removed: 2, hash: expect.stringMatching(/^[0-9a-f]{12}$/) }],
      undo: "available",
    });
    expect(changed.summary).toBe("Changed src/auth.ts · +3 −2");
  });

  it("is not claimed when the agent wrote nothing", async () => {
    const host = build();
    const sessionId = await start(host);
    adapter.stageApproval("ap1", { sessionId, action: "modify_files", scope: "write_project", projectId: "p1", targets: ["src/auth.ts"] });
    adapter.emit({ sessionId, kind: "approval_requested", approvalId: "ap1" });
    await host.execute(ALICE, { name: "respond_to_approval", approvalId: "ap1", decision: "granted" });
    adapter.emit({ sessionId, kind: "run_completed" });
    const changed = await eventOf(host, sessionId, "project_changed");
    expect(changed.projectChange).toMatchObject({ outcome: "not_applied", files: [{ path: "src/auth.ts", change: "unchanged" }] });
    expect(changed.summary).toBe("No files were changed · The approved change wasn't made");
  });

  it("is not recorded at all for a rejection", async () => {
    const host = build();
    const sessionId = await start(host);
    adapter.stageApproval("ap1", { sessionId, action: "modify_files", scope: "write_project", projectId: "p1", targets: ["src/auth.ts"] });
    adapter.emit({ sessionId, kind: "approval_requested", approvalId: "ap1" });
    await host.execute(ALICE, { name: "respond_to_approval", approvalId: "ap1", decision: "denied" });
    adapter.emit({ sessionId, kind: "run_completed" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await events(host, sessionId)).some((event) => event.kind === "project_changed")).toBe(false);
    expect(adapter.answered("ap1")).toBe("denied");
  });

  it("never reads a secret-like file, and so cannot undo it", async () => {
    const host = build();
    const sessionId = await start(host);
    adapter.stageApproval("ap1", { sessionId, action: "modify_files", scope: "write_project", projectId: "p1", targets: [".env"] });
    adapter.emit({ sessionId, kind: "approval_requested", approvalId: "ap1" });
    const pending = await host.execute(ALICE, { name: "get_session", sessionId });
    expect(pending.ok && pending.value.approvals[0]!.projectFiles).toEqual([{ path: ".env", sensitive: true }]);
    await host.execute(ALICE, { name: "respond_to_approval", approvalId: "ap1", decision: "granted" });
    files.write(ROOT, ".env", "SECRET=2");
    adapter.emit({ sessionId, kind: "file_modified", file: { relativePath: ".env", projectId: "p1" } });
    const changed = await eventOf(host, sessionId, "project_changed");
    expect(changed.projectChange).toMatchObject({ undo: "sensitive", files: [{ path: ".env", change: "modified", sensitive: true }] });
    expect(JSON.stringify(changed)).not.toContain("SECRET");
    const review = await host.execute(ALICE, { name: "review_project_change", sessionId, changeId: "ap1" });
    expect(review.ok && review.value.files[0]).toEqual({ path: ".env", change: "modified", note: "sensitive" });
  });

  it("flags a file that changed outside the session since the agent last wrote it", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    files.write(ROOT, "src/auth.ts", "edited by a person\n");
    adapter.stageApproval("ap2", { sessionId, action: "modify_files", scope: "write_project", projectId: "p1", targets: ["src/auth.ts"] });
    adapter.emit({ sessionId, kind: "approval_requested", approvalId: "ap2" });
    const approval = await until(async () => {
      const read = await host.execute(ALICE, { name: "get_session", sessionId });
      const view: RuntimeApprovalView | undefined = read.ok ? read.value.approvals[0] : undefined;
      return view?.projectFiles?.[0]?.changedOutside ? view : undefined;
    });
    expect(approval.projectFiles).toEqual([{ path: "src/auth.ts", changedOutside: true }]);
  });

  it("can be reviewed line by line while the runtime holds it", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    const review = await host.execute(ALICE, { name: "review_project_change", sessionId, changeId: "ap1" });
    expect(review.ok && review.value.files[0]).toMatchObject({ path: "src/auth.ts", added: 3, removed: 2 });
    const lines = review.ok ? review.value.files[0]!.hunks!.flatMap((hunk) => hunk.lines) : [];
    expect(lines).toContainEqual({ sign: "+", text: "  if (!user) return false" });
    expect(await host.execute(BOB, { name: "review_project_change", sessionId, changeId: "ap1" })).toMatchObject({ ok: false });
  });
});

describe("undo", () => {
  it("puts the file back exactly, once", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    const undone = await host.execute(ALICE, { name: "undo_project_change", sessionId, changeId: "ap1" });
    expect(undone).toEqual({ ok: true, value: { outcome: "undone", files: 1 } });
    expect(files.projects.get(ROOT)!.files.get("src/auth.ts")).toBe(AUTH_BEFORE);
    const event = await eventOf(host, sessionId, "project_change_undone");
    expect(event.projectUndo).toEqual({ changeId: "ap1", projectId: "p1", outcome: "undone", files: 1 });
    expect(await host.execute(ALICE, { name: "undo_project_change", sessionId, changeId: "ap1" })).toMatchObject({ ok: true, value: { outcome: "refused" } });
  });

  it("refuses when the project changed after the agent's change, and writes nothing", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    files.write(ROOT, "src/auth.ts", "a person's own edit\n");
    const refused = await host.execute(ALICE, { name: "undo_project_change", sessionId, changeId: "ap1" });
    expect(refused).toEqual({ ok: true, value: { outcome: "refused", reason: "changed", files: 0 } });
    expect(files.projects.get(ROOT)!.files.get("src/auth.ts")).toBe("a person's own edit\n");
    const event = await eventOf(host, sessionId, "project_change_undone");
    expect(event.summary).toBe("Undo refused");
  });

  it("removes a file the agent created, only if it is still what the agent wrote", async () => {
    const host = build();
    const sessionId = await start(host);
    adapter.stageApproval("ap1", { sessionId, action: "create_files", scope: "write_project", projectId: "p1", targets: ["src/session.ts"] });
    adapter.emit({ sessionId, kind: "approval_requested", approvalId: "ap1" });
    await host.execute(ALICE, { name: "respond_to_approval", approvalId: "ap1", decision: "granted" });
    files.write(ROOT, "src/session.ts", "export const session = 1\n");
    adapter.emit({ sessionId, kind: "file_created", file: { relativePath: "src/session.ts", projectId: "p1" } });
    const changed = await eventOf(host, sessionId, "project_changed");
    expect(changed.projectChange!.files).toEqual([{ path: "src/session.ts", change: "created", added: 1, removed: 0, hash: expect.stringMatching(/^[0-9a-f]{12}$/) }]);
    await host.execute(ALICE, { name: "undo_project_change", sessionId, changeId: "ap1" });
    expect(files.projects.get(ROOT)!.files.has("src/session.ts")).toBe(false);
  });

  it("is not available to another account, or after the session is disposed", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    expect(await host.execute(BOB, { name: "undo_project_change", sessionId, changeId: "ap1" })).toMatchObject({ ok: false });
    await host.execute(ALICE, { name: "dispose_session", sessionId });
    expect(files.projects.get(ROOT)!.files.get("src/auth.ts")).toBe(AUTH_AFTER);
  });
});

describe("checks", () => {
  it("runs a named check and reports start and end separately from the change", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    files.holdChecks = true;
    const started = await host.execute(ALICE, { name: "run_project_check", sessionId, check: "typecheck" });
    expect(started.ok && started.value.checkId).toMatch(/^check-/);
    const running = await eventOf(host, sessionId, "verification_started");
    expect(running.verification).toMatchObject({ check: "typecheck", outcome: "running", changeId: "ap1" });
    expect(await host.execute(ALICE, { name: "run_project_check", sessionId, check: "test" })).toMatchObject({ ok: false, error: { code: "invalid_session_state" } });
    files.checkResults.typecheck = { outcome: "failed", exitCode: 2, durationMs: 4000 };
    files.releaseChecks();
    const finished = await eventOf(host, sessionId, "verification_finished");
    expect(finished.verification).toMatchObject({ check: "typecheck", outcome: "failed", exitCode: 2, durationMs: 4000, changeId: "ap1" });
    expect(finished.summary).toBe("Typecheck failed");
    expect(files.checkRuns).toEqual([{ root: ROOT, check: "typecheck" }]);
  });

  it("carries Git status as counts only", async () => {
    const host = build();
    const sessionId = await start(host);
    files.checkResults.git_status = { outcome: "passed", exitCode: 0, durationMs: 50, git: { modified: 3, added: 0, deleted: 0, untracked: 1, renamed: 0 } };
    await host.execute(ALICE, { name: "run_project_check", sessionId, check: "git_status" });
    const finished = await eventOf(host, sessionId, "verification_finished");
    expect(finished.verification!.git).toEqual({ modified: 3, added: 0, deleted: 0, untracked: 1, renamed: 0 });
  });

  it("needs the project's run_commands grant", async () => {
    const host = build();
    await host.execute(ALICE, {
      name: "authorize_projects",
      projects: [project({ permissions: { scopes: ["read_project", "write_project"], projectId: "p1", grantedAt: T0 } })],
    });
    const started = await host.execute(ALICE, { name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-dev" });
    const sessionId = started.ok ? started.value.sessionId : "";
    expect(await host.execute(ALICE, { name: "run_project_check", sessionId, check: "test" })).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(files.checkRuns).toEqual([]);
  });

  it("is refused on a runtime without project access", async () => {
    const host = build({ projects: null });
    const sessionId = await start(host);
    expect(await host.execute(ALICE, { name: "run_project_check", sessionId, check: "test" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
});

describe("Hubble's own record", () => {
  it("cannot be raised by an agent", async () => {
    const host = build();
    const sessionId = await start(host);
    adapter.emit({
      sessionId,
      kind: "project_changed",
      projectChange: { changeId: "fake", projectId: "p1", outcome: "applied", files: [{ path: "src/x.ts", change: "modified", added: 1, removed: 0 }], undo: "available" },
    });
    adapter.emit({ sessionId, kind: "verification_finished", verification: { checkId: "c", projectId: "p1", check: "test", outcome: "passed" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const kinds = (await events(host, sessionId)).map((event) => event.kind);
    expect(kinds).not.toContain("project_changed");
    expect(kinds).not.toContain("verification_finished");
  });

  it("survives into history as counts and outcomes, never contents", async () => {
    const host = build();
    const sessionId = await start(host);
    const changed = await approvedEdit(host, sessionId);
    const kept = historyEventOf(changed)!;
    expect(kept.projectChange).toEqual(changed.projectChange);
    expect(reviveHistoryEvent(JSON.parse(JSON.stringify(kept)), sessionId)).toEqual(kept);
    expect(JSON.stringify(kept)).not.toContain("return true");
  });
});

describe("what the person sees: timeline and Action Inspector", () => {
  async function inspect(host: Host, sessionId: string, live: boolean) {
    const { buildAgentActivityTimeline } = await import("@/lib/agents/activity/timeline");
    const { inspectActivityEntry } = await import("@/lib/agents/activity/inspector");
    const read = await host.execute(ALICE, { name: "get_session", sessionId });
    if (!read.ok) throw new Error("no session");
    const all = await events(host, sessionId);
    const entries = buildAgentActivityTimeline({ session: read.value.session, events: all, agentName: "Claude Code", now: T0 + 1000 });
    const entry = entries.find((candidate) => candidate.kind === "project_changed")!;
    return {
      entries,
      inspection: inspectActivityEntry(entry.id, { entries, session: read.value.session, events: all, agentName: "Claude Code", projectName: "Hubble", projectLive: live }),
    };
  }

  it("tells the whole chain: requested, approved, applied as measured, verified — with undo", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    await host.execute(ALICE, { name: "run_project_check", sessionId, check: "typecheck" });
    await eventOf(host, sessionId, "verification_finished");

    const { entries, inspection } = await inspect(host, sessionId, true);
    // Hubble's measurement replaces the agent's own "Edited auth.ts".
    expect(entries.filter((entry) => entry.refs?.file)).toEqual([]);
    expect(entries.find((entry) => entry.kind === "project_changed")).toMatchObject({ title: "Changed src/auth.ts", description: "+3 −2", status: "completed" });
    expect(entries.find((entry) => entry.kind === "verification")).toMatchObject({ title: "Typecheck passed", status: "completed" });

    expect(inspection).toMatchObject({
      status: "completed",
      result: { tone: "success", text: "Applied — Hubble confirmed 1 file changed in Hubble." },
      changes: { planned: false, lines: [{ sign: "change", text: "src/auth.ts · +3 −2" }] },
      verification: [{ title: "Typecheck passed", tone: "success" }],
      undo: { kind: "available", changeId: "ap1", target: "project", label: "Undo" },
      project: { changeId: "ap1", reviewable: true, verifiable: true },
    });
    expect(inspection!.chain.map((step) => step.label)).toEqual(["Requested by Claude Code", "Approved", "Completed", "Typecheck passed"]);
  });

  it("keeps a failed check apart from a change that applied", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    files.checkResults.test = { outcome: "failed", exitCode: 1, durationMs: 3000 };
    await host.execute(ALICE, { name: "run_project_check", sessionId, check: "test" });
    await eventOf(host, sessionId, "verification_finished");
    const { inspection } = await inspect(host, sessionId, true);
    expect(inspection!.status).toBe("completed");
    expect(inspection!.result!.tone).toBe("success");
    expect(inspection!.verification).toEqual([{ checkId: expect.any(String), title: "Tests failed", detail: "Exit code 1 · 3s", tone: "failure" }]);
  });

  it("explains a refused undo, and offers none from a past session", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    expect((await inspect(host, sessionId, false)).inspection!.undo).toEqual({
      kind: "unavailable",
      reason: "Project changes can be undone only from the live session, while Hubble still holds the earlier version.",
    });
    files.write(ROOT, "src/auth.ts", "changed by hand\n");
    await host.execute(ALICE, { name: "undo_project_change", sessionId, changeId: "ap1" });
    await eventOf(host, sessionId, "project_change_undone");
    const { inspection, entries } = await inspect(host, sessionId, true);
    expect(inspection!.undo).toEqual({ kind: "unavailable", reason: "This change can't be undone because the project has changed since it was made." });
    expect(entries.find((entry) => entry.title === "Undo refused")).toMatchObject({ status: "failed" });
  });

  it("says Undone after an exact undo", async () => {
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    await host.execute(ALICE, { name: "undo_project_change", sessionId, changeId: "ap1" });
    await eventOf(host, sessionId, "project_change_undone");
    const { inspection } = await inspect(host, sessionId, true);
    expect(inspection).toMatchObject({ status: "undone", undo: { kind: "done" } });
    expect(inspection!.chain.at(-1)!.label).toBe("Undone");
  });
});

describe("a project that changed under the agent", () => {
  it("is told to the agent as files changed outside the session — and only those", async () => {
    const { measuredProjectFiles, filesChangedOutside } = await import("@/hooks/use-session-context-pack");
    const { describeProject } = await import("@/lib/agents/project/describe");
    const { readProjectInspection } = await import("@/lib/agents/project/inspection");
    const host = build();
    const sessionId = await start(host);
    await approvedEdit(host, sessionId);
    const measured = measuredProjectFiles(await events(host, sessionId), sessionId);
    expect(measured).toEqual([{ path: "src/auth.ts", change: "updated", hash: expect.stringMatching(/^[0-9a-f]{12}$/) }]);

    const look = async () => {
      const inspected = await host.execute(ALICE, { name: "inspect_project", projectId: "p1", files: measured.map((file) => file.path) });
      const inspection = inspected.ok ? readProjectInspection(inspected.value) : null;
      const project = { id: "p1", name: "Hubble", source: "local" as const, permissions: project_().permissions as never };
      return describeProject({ project, inspection, local: true });
    };
    // As the agent left it: nothing to say.
    expect(filesChangedOutside(measured, await look())).toEqual([]);
    // A person edits it: the agent is told, as a file changed outside the session.
    files.write(ROOT, "src/auth.ts", "edited by hand\n");
    expect(filesChangedOutside(measured, await look())).toEqual([{ path: "src/auth.ts", change: "updated", outside: true }]);
  });
});

function project_() {
  return project();
}
