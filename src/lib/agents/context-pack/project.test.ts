import { describe, expect, it } from "vitest";
import { emptyContextWorld } from "@/lib/agents/context/world";
import { createGrant } from "@/lib/agents/control/permissions";
import { describeProject } from "@/lib/agents/project/describe";
import { contextPackAttachedContext } from "./attach";
import { contextPackFingerprint, contextPackId } from "./pack";
import { contextDeliveryLine, contextPackRows } from "./present";
import { contextDeliveryState, sessionContextPack } from "./session";
import type { ProjectInspection } from "@/lib/agents/project/inspection";
import type { AgentContextWorld } from "@/lib/agents/context/world";

/** The project section of the one Context Pack (Hubble 1.6). */

const world: AgentContextWorld = {
  ...emptyContextWorld(null),
  workspaces: [
    {
      id: "w-dev",
      name: "Development",
      tabs: [
        { id: "t1", url: "https://nextjs.org/docs/app/api-reference", title: "Next.js API", domain: "nextjs.org", createdAt: 1, updatedAt: 1, category: "reference" } as never,
      ],
      brief: { focus: "authentication", updatedAt: 1 },
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  collections: [{ id: "c-api", workspaceId: "w-dev", name: "API", tabIds: ["t1"], createdAt: 1, updatedAt: 1 }],
};

const PROJECT = {
  id: "p1",
  name: "Hubble",
  source: "local" as const,
  path: "C:/Projects/hubble",
  permissions: createGrant(["read_workspace", "read_project", "write_project", "run_commands"], 1, "p1")!,
};

function inspection(over: Partial<ProjectInspection> = {}): ProjectInspection {
  return {
    projectId: "p1",
    state: "ready",
    type: "nextjs",
    repository: { kind: "git", branch: "main", head: "0123456789ab" },
    checks: [{ id: "typecheck", command: "npm run typecheck — tsc" }],
    files: [{ path: "src/auth.ts", state: "present", hash: "aaaaaaaaaaaa" }],
    inspectedAt: 1,
    ...over,
  };
}

function pack(over: { inspection?: ProjectInspection; instruction?: string; files?: { path: string; change: "created" | "updated" }[]; providerCapabilities?: Parameters<typeof describeProject>[0]["providerCapabilities"] } = {}) {
  const built = sessionContextPack({
    world,
    workspaceId: "w-dev",
    selection: { workspaceId: "w-dev", tabIds: ["t1"], collectionIds: ["c-api"] },
    project: describeProject({
      project: PROJECT,
      inspection: over.inspection ?? inspection(),
      local: true,
      ...(over.providerCapabilities ? { providerCapabilities: over.providerCapabilities } : {}),
    }),
    projectFiles: over.files ?? [{ path: "src/auth.ts", change: "updated" }],
    ...(over.instruction ? { instruction: over.instruction } : {}),
  });
  if (!built.ok) throw new Error(built.reason);
  return built.pack;
}

describe("a Context Pack with a project", () => {
  it("carries the project's name, kind, Git state and enforced capabilities — never its path", () => {
    const built = pack();
    expect(built.project).toEqual({
      id: "p1",
      name: "Hubble",
      location: "local",
      state: "ready",
      type: "nextjs",
      repository: { branch: "main", head: "0123456789ab" },
      capabilities: ["read_files", "write_files", "run_commands", "inspect_repository", "run_checks"],
    });
    expect(built.files).toEqual([{ path: "src/auth.ts", change: "updated", state: "present", hash: "aaaaaaaaaaaa" }]);
    const attached = contextPackAttachedContext(built, 0)!;
    expect(JSON.stringify(built)).not.toContain("C:/Projects");
    expect(JSON.stringify(attached)).not.toContain("C:/Projects");
    expect(attached.attachments.find((attachment) => attachment.kind === "project")).toEqual({
      kind: "project",
      id: "p1",
      label: "Hubble",
      detail:
        "Next.js project · Git branch main at 0123456789ab · on the person's own machine — your working directory · You may read files; modify files (each change asks the person first); run commands (each command asks the person first)",
    });
    expect(attached.attachments.filter((attachment) => attachment.kind === "file")).toEqual([
      { kind: "file", id: "src/auth.ts", label: "src/auth.ts", detail: "edited by earlier work" },
    ]);
  });

  it("is deterministic, and its fingerprint ignores the instruction", () => {
    expect(pack().fingerprint).toBe(pack().fingerprint);
    expect(pack({ instruction: "Fix the authentication bug." }).fingerprint).toBe(pack().fingerprint);
    const { fingerprint, ...body } = pack();
    expect(contextPackFingerprint(body)).toBe(fingerprint);
  });

  it("changes fingerprint when the project changes under it", () => {
    const base = pack().fingerprint;
    expect(pack({ inspection: inspection({ repository: { kind: "git", branch: "feature", head: "0123456789ab" } }) }).fingerprint).not.toBe(base);
    expect(pack({ inspection: inspection({ repository: { kind: "git", branch: "main", head: "ffffffffffff" } }) }).fingerprint).not.toBe(base);
    expect(pack({ inspection: inspection({ files: [{ path: "src/auth.ts", state: "present", hash: "bbbbbbbbbbbb" }] }) }).fingerprint).not.toBe(base);
    expect(pack({ inspection: inspection({ state: "missing" }) }).fingerprint).not.toBe(base);
    expect(pack({ providerCapabilities: ["read_files"] }).fingerprint).not.toBe(base);
  });

  it("leaves secret-like files out, and says so", () => {
    const built = pack({ files: [{ path: ".env.local", change: "updated" }, { path: "keys/deploy.pem", change: "created" }, { path: "src/auth.ts", change: "updated" }] });
    expect(built.files.map((file) => file.path)).toEqual(["src/auth.ts"]);
    expect(built.omitted.sensitive).toBe(2);
    expect(JSON.stringify(contextPackAttachedContext(built, 0))).not.toContain(".env");
  });

  it("describes a remote project as a sandbox, never a local folder", () => {
    const built = sessionContextPack({
      world,
      workspaceId: "w-dev",
      project: describeProject({ project: { ...PROJECT, source: "remote_upload" }, local: true }),
    });
    expect(built.ok && built.pack.project).toMatchObject({ location: "remote", capabilities: ["read_files", "write_files", "run_commands"] });
    const attached = built.ok ? contextPackAttachedContext(built.pack, 0) : null;
    expect(attached?.attachments.find((attachment) => attachment.kind === "project")?.detail).toContain("in a sandbox Hubble created");
  });

  it("is what the Context Inspector shows", () => {
    const rows = contextPackRows(pack());
    expect(rows.find((row) => row.key === "project")).toEqual({ key: "project", label: "Project", value: "Hubble", detail: "Next.js · Git main · Local · Ready" });
    expect(rows.find((row) => row.key === "capabilities")?.items).toEqual([
      "Read files",
      "Modify files · asks first",
      "Run commands · asks first",
      "Inspect repository",
      "Run checks",
    ]);
  });

  it("says when the project changed after the agent received it", () => {
    const delivered = pack();
    const later = pack({ inspection: inspection({ files: [{ path: "src/auth.ts", state: "present", hash: "cccccccccccc" }] }) });
    const state = contextDeliveryState({ contextSnapshotId: contextPackId(delivered), contextDelivered: true }, later);
    expect(state).toBe("changed");
    expect(contextDeliveryLine(state, "Codex", "project")).toBe("Project changed since Codex received it");
  });
});

describe("telling a project change from any other", () => {
  it("is \"project\" only when nothing but the project moved", async () => {
    const { contextChangeOf } = await import("./session")
    const delivered = pack()
    const fileMoved = pack({ inspection: inspection({ files: [{ path: "src/auth.ts", state: "present", hash: "dddddddddddd" }] }) })
    const branchMoved = pack({ inspection: inspection({ repository: { kind: "git", branch: "fix/auth", head: "0123456789ab" } }) })
    expect(contextChangeOf(delivered, fileMoved)).toBe("project")
    expect(contextChangeOf(delivered, branchMoved)).toBe("project")
    // A file the agent changed, changed again outside the session: still only the project.
    const drifted = sessionContextPack({
      world,
      workspaceId: "w-dev",
      selection: { workspaceId: "w-dev", tabIds: ["t1"], collectionIds: ["c-api"] },
      project: describeProject({ project: PROJECT, inspection: inspection(), local: true }),
      projectFiles: [{ path: "src/auth.ts", change: "updated" }, { path: "src/session.ts", change: "updated", outside: true }],
    })
    expect(drifted.ok && contextChangeOf(delivered, drifted.pack)).toBe("project")
    // The selection changed too: just "changed".
    const reselected = sessionContextPack({
      world,
      workspaceId: "w-dev",
      selection: { workspaceId: "w-dev", tabIds: [], collectionIds: ["c-api"] },
      project: describeProject({ project: PROJECT, inspection: inspection({ files: [{ path: "src/auth.ts", state: "present", hash: "dddddddddddd" }] }), local: true }),
      projectFiles: [{ path: "src/auth.ts", change: "updated" }],
    })
    expect(reselected.ok && contextChangeOf(delivered, reselected.pack)).toBeUndefined()
    // Unknown delivered pack, or nothing changed: no claim.
    expect(contextChangeOf(undefined, fileMoved)).toBeUndefined()
    expect(contextChangeOf(delivered, delivered)).toBeUndefined()
  })
})
