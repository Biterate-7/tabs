import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_CAPABILITIES,
  capabilitySet,
  isLocalEffectCapability,
  LOCAL_EFFECT_CAPABILITIES,
  listCapabilities,
  NO_CAPABILITIES,
  CAPABILITY_LABELS,
} from "./capabilities";
import {
  AGENT_PERMISSION_SCOPES,
  createGrant,
  isCapabilityPermitted,
  isGranted,
  isValidGrant,
  PERMISSION_LABELS,
  requiredScopeFor,
  requiresApproval,
} from "./permissions";
import {
  containsPath,
  createProject,
  isProviderAuthorized,
  isSameProjectPath,
  PROJECT_PATH_REJECTION_MESSAGES,
  validateProjectPath,
} from "./projects";
import {
  APPROVAL_ACTIONS,
  createApprovalBroker,
  describeApproval,
  MAX_APPROVAL_TARGETS,
} from "./approvals";
import { createAttachment, isWellFormedContext, isWellFormedMessage } from "./context";
import {
  CONTROL_PROJECTS_KEY,
  CONTROL_SESSIONS_KEY,
  loadControlProjects,
  loadControlSessions,
  saveControlSessions,
} from "./persistence";
import { createSession } from "./session";
import { setStorageNamespace } from "@/lib/storage/namespace";

const T0 = 1_700_000_000_000;

/* ---------------------------------- capabilities ---------------------------------- */

describe("capabilities", () => {
  it("claims nothing by default", () => {
    expect([...NO_CAPABILITIES]).toEqual([]);
  });

  it("labels every capability", () => {
    // A missing label renders as an empty row in a list a user reads before
    // authorizing a project.
    for (const capability of AGENT_CAPABILITIES) {
      expect(CAPABILITY_LABELS[capability]).toBeTruthy();
    }
  });

  it("lists in canonical order rather than insertion order", () => {
    const set = capabilitySet("write_files", "observe", "message");
    expect(listCapabilities(set)).toEqual(["observe", "message", "write_files"]);
  });

  it("classifies every local-effect capability as a real capability", () => {
    for (const capability of LOCAL_EFFECT_CAPABILITIES) {
      expect(AGENT_CAPABILITIES).toContain(capability);
      expect(isLocalEffectCapability(capability)).toBe(true);
    }
  });

  it("treats exactly the machine-touching capabilities as local effects", () => {
    // A capability added without being classified would silently skip the
    // project requirement in `isCapabilityPermitted`.
    const local = AGENT_CAPABILITIES.filter(isLocalEffectCapability);
    expect(local.sort()).toEqual(["read_files", "run_commands", "write_files"]);
  });

  it("has no field that could advertise an unimplemented capability", () => {
    // The whole module is a union plus sets. There is nowhere to put a
    // roadmap, which is the point.
    const set = capabilitySet("message");
    expect(Object.keys(set)).toEqual([]);
  });
});

/* ---------------------------------- permissions ---------------------------------- */

describe("permissions", () => {
  it("maps every capability to a scope or to none, exhaustively", () => {
    for (const capability of AGENT_CAPABILITIES) {
      const scope = requiredScopeFor(capability);
      if (scope !== null) expect(AGENT_PERMISSION_SCOPES).toContain(scope);
    }
  });

  it("labels every scope", () => {
    for (const scope of AGENT_PERMISSION_SCOPES) {
      expect(PERMISSION_LABELS[scope]).toBeTruthy();
    }
  });

  it("denies everything on an empty grant", () => {
    const grant = createGrant([], T0)!;
    for (const scope of AGENT_PERMISSION_SCOPES) {
      expect(isGranted(grant, scope, "p1"), scope).toBe(false);
    }
  });

  it("rejects a grant with a duplicate or unknown scope", () => {
    expect(isValidGrant({ scopes: ["read_project", "read_project"], projectId: "p1", grantedAt: T0 })).toBe(
      false
    );
    expect(
      isValidGrant({ scopes: ["read_project", "sudo" as never], projectId: "p1", grantedAt: T0 })
    ).toBe(false);
  });

  it("rejects a grant with a nonsense timestamp", () => {
    expect(isValidGrant({ scopes: ["read_workspace"], grantedAt: Number.NaN })).toBe(false);
  });

  it("requires an approval for exactly the three scopes that change something", () => {
    const needing = AGENT_PERMISSION_SCOPES.filter(requiresApproval);
    // write_workspace (Phase J.3): every workspace change asks, like every file write.
    expect(needing.sort()).toEqual(["run_commands", "write_project", "write_workspace"]);
  });

  it("allows a non-local capability with no grant at all", () => {
    // Starting a session touches nothing on the machine.
    const none = createGrant([], T0)!;
    expect(isCapabilityPermitted("create_session", none)).toBe(true);
    expect(isCapabilityPermitted("cancel_run", none)).toBe(true);
    expect(isCapabilityPermitted("stream_events", none)).toBe(true);
  });

  it("permits a local capability only with both the scope and the project", () => {
    const grant = createGrant(["write_project"], T0, "p1")!;

    expect(isCapabilityPermitted("write_files", grant, "p1")).toBe(true);
    expect(isCapabilityPermitted("write_files", grant, "p2")).toBe(false);
    expect(isCapabilityPermitted("write_files", grant, undefined)).toBe(false);
    // The scope for reading was never granted.
    expect(isCapabilityPermitted("read_files", grant, "p1")).toBe(false);
  });

  it("denies when handed a scope that is not one", () => {
    const grant = createGrant(["read_workspace"], T0)!;
    expect(isGranted(grant, "everything" as never)).toBe(false);
  });
});

/* ---------------------------------- projects ---------------------------------- */

describe("project paths", () => {
  it("accepts an ordinary project directory", () => {
    expect(validateProjectPath("C:/work/research")).toEqual({ ok: true, path: "C:/work/research" });
    expect(validateProjectPath("/home/alice/code/app")).toEqual({
      ok: true,
      path: "/home/alice/code/app",
    });
  });

  it("normalizes separators and trailing slashes without changing case", () => {
    expect(validateProjectPath("C:\\work\\Research\\")).toEqual({
      ok: true,
      path: "C:/work/Research",
    });
  });

  it("gives every rejection a message", () => {
    for (const reason of Object.keys(PROJECT_PATH_REJECTION_MESSAGES)) {
      expect(PROJECT_PATH_REJECTION_MESSAGES[reason as never]).toBeTruthy();
    }
  });

  it("refuses a relative path", () => {
    expect(validateProjectPath("work/research")).toMatchObject({ reason: "not-absolute" });
  });

  it("refuses a null byte", () => {
    expect(validateProjectPath("C:/work/\0evil")).toMatchObject({ reason: "unsupported-form" });
  });

  it("refuses a home directory whose leaf is a username", () => {
    // Regression. A home directory's last segment is the account name, which
    // cannot be enumerated, so a leaf-name check alone let `C:/Users/alice`
    // through as an ordinary two-segment folder — authorizing everything the
    // user owns, including every other project.
    for (const home of [
      "C:/Users/alice",
      "c:\\Users\\Bob",
      "/home/alice",
      "/Users/alice",
      "C:/Users",
    ]) {
      expect(validateProjectPath(home), home).toMatchObject({ ok: false });
    }

    // A project *inside* a home directory is still fine.
    expect(validateProjectPath("C:/Users/alice/code/app").ok).toBe(true);
  });

  it("keeps a UNC prefix instead of collapsing it into an ordinary path", () => {
    // Regression. Collapsing every run of separators turned `\\server\share`
    // into `/server/share`, which looks absolute, is not the directory anyone
    // named, and sailed past the filesystem-root check.
    expect(validateProjectPath("//server")).toMatchObject({ reason: "filesystem-root" });
    expect(validateProjectPath("\\\\server")).toMatchObject({ reason: "filesystem-root" });
    expect(validateProjectPath("\\\\server\\share\\project")).toEqual({
      ok: true,
      path: "//server/share/project",
    });
  });

  it("compares two spellings of one directory as the same", () => {
    expect(isSameProjectPath("C:\\Work\\Research", "c:/work/research/")).toBe(true);
    expect(isSameProjectPath("C:/work/research", "C:/work/research-2")).toBe(false);
  });
});

describe("projects", () => {
  it("starts with no permissions and no providers", () => {
    // Connecting a folder and authorizing an agent in it are two decisions.
    const made = createProject({ id: "p1", name: "Research", path: "C:/work/research" }, T0);

    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.project.permissions.scopes).toEqual([]);
    expect(made.project.providers).toEqual([]);
  });

  it("refuses a nameless project", () => {
    expect(createProject({ id: "p1", name: "   ", path: "C:/work/research" }, T0)).toMatchObject({
      ok: false,
      reason: "invalid-name",
    });
  });

  it("refuses a grant scoped to a different project", () => {
    const grant = createGrant(["write_project"], T0, "other")!;
    expect(
      createProject({ id: "p1", name: "Research", path: "C:/work/research", permissions: grant }, T0)
    ).toMatchObject({ ok: false, reason: "invalid-permissions" });
  });

  it("authorizes only listed providers", () => {
    const made = createProject(
      { id: "p1", name: "Research", path: "C:/work/research", providers: ["claude-code"] },
      T0
    );
    if (!made.ok) throw new Error("fixture");

    expect(isProviderAuthorized(made.project, "claude-code")).toBe(true);
    expect(isProviderAuthorized(made.project, "openai-codex")).toBe(false);
  });

  it("resolves a contained path and refuses everything else", () => {
    const made = createProject({ id: "p1", name: "R", path: "C:/work/research" }, T0);
    if (!made.ok) throw new Error("fixture");

    expect(containsPath(made.project, "C:/work/research/src/a.ts")).toEqual({
      ok: true,
      relativePath: "src/a.ts",
    });
    expect(containsPath(made.project, "C:/work/other/a.ts").ok).toBe(false);
    expect(containsPath(made.project, "../a.ts").ok).toBe(false);
  });
});

/* ---------------------------------- approvals ---------------------------------- */

describe("the approval broker", () => {
  it("mints a pending request", () => {
    const broker = createApprovalBroker();
    const made = broker.request(
      {
        id: "a1",
        sessionId: "s1",
        provider: "claude-code",
        action: "modify_files",
        scope: "write_project",
        projectId: "p1",
        targets: ["notes.md", "refs.bib"],
        reason: "Updating the literature review",
      },
      T0
    );

    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.approval.status).toBe("requested");
    expect(made.approval.targets).toEqual(["notes.md", "refs.bib"]);
  });

  it("refuses a duplicate id", () => {
    const broker = createApprovalBroker();
    const input = {
      id: "a1",
      sessionId: "s1",
      provider: "claude-code" as const,
      action: "modify_files" as const,
      scope: "write_project" as const,
      projectId: "p1",
      targets: ["a.md"],
    };

    expect(broker.request(input, T0).ok).toBe(true);
    expect(broker.request(input, T0)).toMatchObject({ ok: false, reason: "duplicate-id" });
  });

  it("refuses a scope that needs no approval", () => {
    // Minting one would train a user to click through dialogs that never
    // mattered, which is how a real one gets waved through too.
    const broker = createApprovalBroker();

    expect(
      broker.request(
        {
          id: "a1",
          sessionId: "s1",
          provider: "claude-code",
          action: "modify_files",
          scope: "read_project",
          projectId: "p1",
          targets: ["a.md"],
        },
        T0
      )
    ).toMatchObject({ ok: false, reason: "scope-needs-no-approval" });
  });

  it("refuses more targets than a dialog can be evaluated with", () => {
    const broker = createApprovalBroker();
    const result = broker.request(
      {
        id: "a1",
        sessionId: "s1",
        provider: "claude-code",
        action: "modify_files",
        scope: "write_project",
        projectId: "p1",
        targets: Array.from({ length: MAX_APPROVAL_TARGETS + 1 }, (_, i) => `f${i}.md`),
      },
      T0
    );

    expect(result).toMatchObject({ ok: false, reason: "too-many-targets" });
  });

  it("filters invalid targets but keeps the valid ones", () => {
    const broker = createApprovalBroker();
    const made = broker.request(
      {
        id: "a1",
        sessionId: "s1",
        provider: "claude-code",
        action: "modify_files",
        scope: "write_project",
        projectId: "p1",
        targets: ["notes.md", "../escape.md", "/etc/passwd"],
      },
      T0
    );

    expect(made.ok).toBe(true);
    if (made.ok) expect(made.approval.targets).toEqual(["notes.md"]);
  });

  it("lists pending oldest first", () => {
    const broker = createApprovalBroker();
    for (const [index, id] of ["a1", "a2", "a3"].entries()) {
      broker.request(
        {
          id,
          sessionId: "s1",
          provider: "claude-code",
          action: "modify_files",
          scope: "write_project",
          projectId: "p1",
          targets: ["x.md"],
        },
        T0 + index * 1000
      );
    }

    expect(broker.pending(T0 + 5000).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("notifies watchers on every status change", () => {
    const broker = createApprovalBroker();
    const seen: string[] = [];
    broker.watch((approval) => seen.push(approval.status));

    broker.request(
      {
        id: "a1",
        sessionId: "s1",
        provider: "claude-code",
        action: "run_command",
        scope: "run_commands",
        projectId: "p1",
        targets: ["test"],
      },
      T0
    );
    broker.resolve("a1", "granted", T0 + 10);

    expect(seen).toEqual(["requested", "granted"]);
  });

  it("sweeps overdue requests to expired", () => {
    const broker = createApprovalBroker();
    broker.request(
      {
        id: "a1",
        sessionId: "s1",
        provider: "claude-code",
        action: "modify_files",
        scope: "write_project",
        projectId: "p1",
        targets: ["x.md"],
        ttlMs: 100,
      },
      T0
    );

    expect(broker.sweep(T0 + 5000).map((a) => a.id)).toEqual(["a1"]);
    // Idempotent: already expired, so nothing to report a second time.
    expect(broker.sweep(T0 + 9000)).toEqual([]);
  });

  it("describes itself in one readable sentence", () => {
    const broker = createApprovalBroker();
    const made = broker.request(
      {
        id: "a1",
        sessionId: "s1",
        provider: "claude-code",
        action: "modify_files",
        scope: "write_project",
        projectId: "p1",
        targets: ["a.md", "b.md", "c.md"],
      },
      T0
    );

    if (!made.ok) throw new Error("fixture");
    expect(describeApproval(made.approval, "Claude Code")).toBe(
      "Claude Code wants to modify files (3 items)"
    );
  });

  it("labels every action", () => {
    for (const action of APPROVAL_ACTIONS) {
      const broker = createApprovalBroker();
      const made = broker.request(
        {
          id: action,
          sessionId: "s1",
          provider: "claude-code",
          action,
          scope: "write_project",
          projectId: "p1",
          targets: ["x"],
        },
        T0
      );
      if (made.ok) expect(describeApproval(made.approval, "Agent")).not.toContain("undefined");
    }
  });
});

/* ---------------------------------- context ---------------------------------- */

describe("context attachments", () => {
  it("bounds a long label", () => {
    const made = createAttachment({ kind: "tab", id: "t1", label: "x".repeat(1000) });
    expect(made?.label).toHaveLength(200);
  });

  it("drops an attachment with no usable label", () => {
    expect(createAttachment({ kind: "tab", id: "t1", label: "   " })).toBeNull();
    expect(createAttachment({ kind: "tab", id: "", label: "Tab" })).toBeNull();
  });

  it("rejects an unknown kind", () => {
    expect(createAttachment({ kind: "database" as never, id: "x", label: "X" })).toBeNull();
  });

  it("accepts a well-formed message and rejects an empty one", () => {
    expect(
      isWellFormedMessage({ sessionId: "s1", text: "go", context: { attachments: [] } })
    ).toBe(true);
    expect(
      isWellFormedMessage({ sessionId: "s1", text: "  ", context: { attachments: [] } })
    ).toBe(false);
    expect(isWellFormedMessage({ sessionId: "", text: "go", context: { attachments: [] } })).toBe(
      false
    );
  });

  it("rejects a context over the attachment cap", () => {
    expect(
      isWellFormedContext({
        attachments: Array.from({ length: 300 }, (_, i) => ({
          kind: "tab" as const,
          id: `t${i}`,
          label: "T",
        })),
      })
    ).toBe(false);
  });
});

/* ---------------------------------- persistence ---------------------------------- */

describe("persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setStorageNamespace(null);
  });

  it("round-trips a terminal session", () => {
    const session = { ...createSession({ id: "s1", provider: "claude-code" }, T0), status: "completed" as const };
    expect(saveControlSessions({ version: 1, sessions: [session] })).toBe(true);

    const loaded = loadControlSessions();
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0].status).toBe("completed");
  });

  it("restores a live session as disconnected", () => {
    // Whatever it was doing, it is not doing it now — the process died with
    // the page. Restoring it as `running` would spin forever.
    for (const status of ["connecting", "ready", "running", "waiting_for_approval"] as const) {
      window.localStorage.clear();
      const session = { ...createSession({ id: "s1", provider: "claude-code" }, T0), status };
      saveControlSessions({ version: 1, sessions: [session] });

      expect(loadControlSessions().sessions[0].status, status).toBe("disconnected");
    }
  });

  it("drops a session with a bad provider or status", () => {
    window.localStorage.setItem(
      CONTROL_SESSIONS_KEY,
      JSON.stringify({
        version: 1,
        sessions: [
          { id: "s1", provider: "not-a-provider", status: "ready", createdAt: T0, updatedAt: T0 },
          { id: "s2", provider: "claude-code", status: "levitating", createdAt: T0, updatedAt: T0 },
        ],
      })
    );

    expect(loadControlSessions().sessions).toEqual([]);
  });

  it("revalidates a project path on load", () => {
    // The most security-sensitive line in the module: a hand-edited path in
    // devtools must be dropped, not authorized.
    window.localStorage.setItem(
      CONTROL_PROJECTS_KEY,
      JSON.stringify({
        version: 1,
        projects: [
          { id: "p1", name: "Evil", path: "C:/", providers: ["claude-code"], createdAt: T0, updatedAt: T0 },
          { id: "p2", name: "Home", path: "C:/Users/alice", providers: [], createdAt: T0, updatedAt: T0 },
          { id: "p3", name: "Fine", path: "C:/work/app", providers: ["claude-code"], createdAt: T0, updatedAt: T0 },
        ],
      })
    );

    const loaded = loadControlProjects();
    expect(loaded.projects.map((p) => p.id)).toEqual(["p3"]);
  });

  it("downgrades an unreadable grant to no permissions rather than trusting it", () => {
    window.localStorage.setItem(
      CONTROL_PROJECTS_KEY,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "p1",
            name: "App",
            path: "C:/work/app",
            providers: ["claude-code"],
            permissions: { scopes: ["write_project", "sudo"], grantedAt: T0 },
            createdAt: T0,
            updatedAt: T0,
          },
        ],
      })
    );

    expect(loadControlProjects().projects[0].permissions.scopes).toEqual([]);
  });

  it("drops an unknown provider from a project's authorization list", () => {
    window.localStorage.setItem(
      CONTROL_PROJECTS_KEY,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "p1",
            name: "App",
            path: "C:/work/app",
            providers: ["claude-code", "some-other-agent"],
            createdAt: T0,
            updatedAt: T0,
          },
        ],
      })
    );

    expect(loadControlProjects().projects[0].providers).toEqual(["claude-code"]);
  });

  it("caps what it writes, keeping the most recent", () => {
    const sessions = Array.from({ length: 400 }, (_, index) => ({
      ...createSession({ id: `s${index}`, provider: "claude-code" as const }, T0),
      status: "completed" as const,
      updatedAt: T0 + index,
    }));

    saveControlSessions({ version: 1, sessions });

    const loaded = loadControlSessions();
    expect(loaded.sessions).toHaveLength(200);
    expect(loaded.sessions[0].id).toBe("s399");
  });

  it("returns an empty state when storage holds nothing", () => {
    expect(loadControlSessions().sessions).toEqual([]);
    expect(loadControlProjects().projects).toEqual([]);
  });

  it("writes under the account namespace when one is active", () => {
    setStorageNamespace("user-1");
    const session = { ...createSession({ id: "s1", provider: "claude-code" }, T0), status: "completed" as const };
    saveControlSessions({ version: 1, sessions: [session] });

    expect(window.localStorage.getItem(CONTROL_SESSIONS_KEY)).toBeNull();
    expect(window.localStorage.getItem(`tabdump:u:user-1:agent-sessions:v1`)).not.toBeNull();

    setStorageNamespace(null);
  });
});
