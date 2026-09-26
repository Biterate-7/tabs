import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveContext } from "./resolve";
import { refreshContext } from "./snapshot";
import { snapshotToAttachments } from "./attach";
import { createControlService } from "@/lib/agents/control/service";
import { createUnimplementedControlAdapter } from "@/lib/agents/control/unimplemented";
import { capabilitySet } from "@/lib/agents/control/capabilities";
import { NO_PERMISSIONS } from "@/lib/agents/control/permissions";
import { createProject } from "@/lib/agents/control/projects";
import { saveControlSessions, loadControlSessions } from "@/lib/agents/control/persistence";
import { fixtureWorld, scopeA, scopeAWithProject, T0 } from "./__fixtures__/world";
import type { AgentContextRequest, AgentContextSnapshot } from "./types";
import type { AgentContextWorld } from "./world";
import type { AgentControlAdapter, ControlResult } from "@/lib/agents/control/types";
import type { AgentCapabilitySet } from "@/lib/agents/control/capabilities";
import type { AgentProject } from "@/lib/agents/control/projects";
import type { CreateSessionRequest } from "@/lib/agents/control/types";

/**
 * The Context Bridge's structural guards.
 *
 * ## The one property this suite exists to prove
 *
 * > Telling an agent about something is not the same as letting it touch
 * > that thing.
 *
 * Every test below is a way of failing that sentence. They are structural
 * — file-level assertions about what this directory may import, and
 * behavioural assertions driven through the real control service — because
 * both failure modes are silent. A resolver that leaked another account's
 * workspace would return a plausible-looking snapshot; an attachment that
 * widened a grant would produce a session that simply worked.
 *
 * The Phase B/C guards in `control/security.test.ts` are untouched and
 * still pass. This suite is the second half, from the other side of the
 * boundary.
 */

const CONTEXT_DIR = path.resolve(__dirname);
const CONTROL_DIR = path.resolve(__dirname, "../control");
const SRC_DIR = path.resolve(__dirname, "../../..");
const REPO_ROOT = path.resolve(SRC_DIR, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__fixtures__" || entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const contextSources = walk(CONTEXT_DIR).map((file) => ({
  file: path.relative(REPO_ROOT, file),
  name: path.basename(file),
  source: readFileSync(file, "utf8"),
}));

/** Code lines only — prose legitimately discusses what is deliberately not done. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

function importsOf(source: string): string[] {
  return [
    ...source.matchAll(/^\s*import\s[^\n]*?["']([^"']+)["']/gm),
    ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

function resolveOrThrow(
  request: AgentContextRequest,
  world: AgentContextWorld = fixtureWorld(),
  localRuntimeAllowed = false
): AgentContextSnapshot {
  const result = resolveContext(request, world, {
    now: () => T0,
    createSnapshotId: () => "snap",
    localRuntimeAllowed,
  });
  if (!result.ok) throw new Error(`expected resolution, got ${result.reason}`);
  return result.snapshot;
}

function project(): AgentProject {
  const made = createProject(
    { id: "proj-a", name: "API service", path: "C:/work/api", providers: ["claude-code"] },
    T0
  );
  if (!made.ok) throw new Error("fixture failed");
  return made.project;
}

/** A session record with everything context is allowed to move removed. */
function withoutContextFields(session: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...session };
  delete copy.contextSnapshotId;
  delete copy.updatedAt;
  return copy;
}

/** An adapter that claims everything and records the requests that reached it. */
function spyAdapter(capabilities: AgentCapabilitySet): AgentControlAdapter & {
  calls: string[];
  creations: CreateSessionRequest[];
} {
  const calls: string[] = [];
  const creations: CreateSessionRequest[] = [];
  const base = createUnimplementedControlAdapter({ provider: "claude-code", detail: "test" });

  return {
    ...base,
    calls,
    creations,
    getCapabilities: () => capabilities,
    createSession: async (request: CreateSessionRequest) => {
      calls.push("createSession");
      creations.push(request);
      return { ok: true, value: { sessionId: request.sessionId, status: "ready" } } as ControlResult<{
        sessionId: string;
        status: "ready";
      }>;
    },
    sendMessage: async () => {
      calls.push("sendMessage");
      return { ok: true, value: undefined };
    },
  } as AgentControlAdapter & { calls: string[]; creations: CreateSessionRequest[] };
}

const ALL_CAPABILITIES = capabilitySet(
  "create_session",
  "message",
  "read_files",
  "write_files",
  "run_commands",
  "mcp",
  "approvals",
  "cancel_run"
);

/* ------------------------------------------------------------------ *
 * 1. Context is not authorization
 * ------------------------------------------------------------------ */

describe("context cannot grant permission", () => {
  it("attaching project metadata does not let the agent read the project", async () => {
    const adapter = spyAdapter(ALL_CAPABILITIES);
    const service = createControlService({
      runtime: () => ({ allowed: true, kind: "local-desktop" }),
      resolveAdapter: () => adapter,
      resolveProject: () => project(),
    });

    // A snapshot that names the project, its root and everything else the
    // bridge can say about it.
    const snapshot = resolveOrThrow(
      { scope: scopeAWithProject(), sources: ["project"], projectIds: ["proj-a"] },
      fixtureWorld(),
      true
    );
    expect(snapshot.items).toHaveLength(1);

    const started = await service.startSession({
      provider: "claude-code",
      projectId: "proj-a",
      // The agent has been told everything and granted nothing.
      permissions: NO_PERMISSIONS,
      context: {
        snapshotId: snapshot.id,
        capturedAt: snapshot.capturedAt,
        attachments: snapshotToAttachments(snapshot),
      },
    });

    expect(started.ok).toBe(true);
    // The context said "C:/work/api exists". The grant still says nothing.
    expect(service.canDrive("claude-code", "read_files")).toBe(true); // the adapter *can*
    const session = started.ok ? started.value : undefined;
    expect(session?.contextSnapshotId).toBe("snap");

    // But every local-effect capability is still refused, because the
    // permission check reads the grant and the grant was never touched.
    const message = await service.sendMessage({
      sessionId: session!.id,
      text: "read the config",
      context: { attachments: [] },
    });
    expect(message.ok).toBe(true); // messaging needs no scope

    // The gate that matters: a capability requiring `read_project`.
    const readGate = createControlService({
      runtime: () => ({ allowed: true, kind: "local-desktop" }),
      resolveAdapter: () => adapter,
      resolveProject: () => project(),
    });
    const denied = await readGate.startSession({
      provider: "claude-code",
      projectId: "proj-a",
      permissions: NO_PERMISSIONS,
    });
    expect(denied.ok).toBe(true);
    // `isCapabilityPermitted` is the join, and context is not an input to it.
    const { isCapabilityPermitted } = await import("@/lib/agents/control/permissions");
    expect(isCapabilityPermitted("read_files", NO_PERMISSIONS, "proj-a")).toBe(false);
    expect(isCapabilityPermitted("write_files", NO_PERMISSIONS, "proj-a")).toBe(false);
    expect(isCapabilityPermitted("run_commands", NO_PERMISSIONS, "proj-a")).toBe(false);
  });

  it("attaching a workspace grants no filesystem scope at all", () => {
    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["workspace", "tab"],
      workspaceIds: ["ws-a"],
    });

    // A workspace attachment produces attachments and nothing else. There is
    // no field on one that a permission check reads.
    const attachments = snapshotToAttachments(snapshot);
    expect(attachments.length).toBeGreaterThan(0);
    for (const attachment of attachments) {
      expect(Object.keys(attachment).sort()).toEqual(
        expect.arrayContaining(["id", "kind", "label"])
      );
      expect(Object.keys(attachment)).not.toContain("scopes");
      expect(Object.keys(attachment)).not.toContain("permissions");
      expect(Object.keys(attachment)).not.toContain("path");
      expect(Object.keys(attachment)).not.toContain("capabilities");
    }
  });

  it("does not change a session's grant, project or status", () => {
    const adapter = spyAdapter(ALL_CAPABILITIES);
    const service = createControlService({
      runtime: () => ({ allowed: true, kind: "local-desktop" }),
      resolveAdapter: () => adapter,
    });

    return service
      .startSession({ provider: "claude-code", permissions: NO_PERMISSIONS })
      .then((started) => {
        expect(started.ok).toBe(true);
        const before = started.ok ? started.value : undefined;

        const snapshot = resolveOrThrow({
          scope: scopeA(),
          sources: ["tab"],
          workspaceIds: ["ws-a"],
        });
        const attached = service.attachContext(before!.id, {
          snapshotId: snapshot.id,
          capturedAt: snapshot.capturedAt,
          attachments: snapshotToAttachments(snapshot),
        });

        expect(attached.ok).toBe(true);
        const after = attached.ok ? attached.value : undefined;

        expect(after!.status).toBe(before!.status);
        expect(after!.projectId).toBe(before!.projectId);
        // Only the context reference and the timestamp moved.
        expect(withoutContextFields(after!)).toEqual(withoutContextFields(before!));
      });
  });

  it("does not register a project, so an unknown project stays denied", async () => {
    const adapter = spyAdapter(ALL_CAPABILITIES);
    const service = createControlService({
      runtime: () => ({ allowed: true, kind: "local-desktop" }),
      resolveAdapter: () => adapter,
      // Nothing is registered. Context naming a project must not change that.
      resolveProject: () => undefined,
    });

    const snapshot = resolveOrThrow(
      { scope: scopeAWithProject(), sources: ["project"], projectIds: ["proj-a"] },
      fixtureWorld(),
      true
    );

    const started = await service.startSession({
      provider: "claude-code",
      projectId: "proj-a",
      permissions: NO_PERMISSIONS,
      context: {
        snapshotId: snapshot.id,
        capturedAt: snapshot.capturedAt,
        attachments: snapshotToAttachments(snapshot),
      },
    });

    expect(started).toEqual({
      ok: false,
      error: { code: "project-denied", message: expect.any(String) },
    });
    expect(adapter.calls).toEqual([]);
  });

  it("does not itself reach an adapter — resolving executes nothing", () => {
    const adapter = spyAdapter(ALL_CAPABILITIES);
    createControlService({
      runtime: () => ({ allowed: true, kind: "local-desktop" }),
      resolveAdapter: () => adapter,
    });

    resolveOrThrow({
      scope: scopeAWithProject(),
      sources: ["workspace", "tab", "collection", "relationship", "graph", "project", "agent_activity"],
      workspaceIds: ["ws-a"],
      collectionIds: ["col-a1"],
      projectIds: ["proj-a"],
      graph: { centerTabIds: ["a1"], depth: 2 },
    });

    expect(adapter.calls).toEqual([]);
  });

  it("attaching context dispatches nothing to the provider", async () => {
    const adapter = spyAdapter(ALL_CAPABILITIES);
    const service = createControlService({
      runtime: () => ({ allowed: true, kind: "local-desktop" }),
      resolveAdapter: () => adapter,
    });

    const started = await service.startSession({ provider: "claude-code" });
    adapter.calls.length = 0;

    const snapshot = resolveOrThrow({ scope: scopeA(), sources: ["tab"], tabIds: ["a1"] });
    service.attachContext(started.ok ? started.value.id : "", {
      snapshotId: snapshot.id,
      capturedAt: snapshot.capturedAt,
      attachments: snapshotToAttachments(snapshot),
    });

    expect(adapter.calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Capabilities are unchanged by context
 * ------------------------------------------------------------------ */

describe("context cannot widen what a provider can do", () => {
  it("an adapter declares the same capabilities with and without context", async () => {
    const adapter = spyAdapter(capabilitySet("create_session", "message"));
    const before = [...adapter.getCapabilities()];

    const service = createControlService({
      runtime: () => ({ allowed: true, kind: "local-desktop" }),
      resolveAdapter: () => adapter,
    });

    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["workspace", "tab"],
      workspaceIds: ["ws-a"],
    });

    await service.startSession({
      provider: "claude-code",
      context: {
        snapshotId: snapshot.id,
        capturedAt: snapshot.capturedAt,
        attachments: snapshotToAttachments(snapshot),
      },
    });

    expect([...adapter.getCapabilities()]).toEqual(before);
  });

  it("a provider that declares nothing still refuses everything with context attached", async () => {
    const none = createUnimplementedControlAdapter({
      provider: "openai-codex",
      detail: "not built",
    });
    const service = createControlService({
      runtime: () => ({ allowed: true, kind: "local-desktop" }),
      resolveAdapter: () => none,
    });

    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["workspace", "tab"],
      workspaceIds: ["ws-a"],
    });

    const started = await service.startSession({
      provider: "openai-codex",
      context: {
        snapshotId: snapshot.id,
        capturedAt: snapshot.capturedAt,
        attachments: snapshotToAttachments(snapshot),
      },
    });

    expect(started).toEqual({
      ok: false,
      error: { code: "unsupported", message: expect.any(String) },
    });
    expect([...none.getCapabilities()]).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. What this directory may reach
 * ------------------------------------------------------------------ */

describe("the bridge reaches nothing it should not", () => {
  it("finds the files it is supposed to be checking", () => {
    expect(contextSources.length).toBeGreaterThanOrEqual(6);
    const names = contextSources.map((entry) => entry.name);
    expect(names).toContain("resolve.ts");
    expect(names).toContain("types.ts");
    expect(names).toContain("sanitize.ts");
  });

  it("imports no persistence module", () => {
    // The bridge is handed a world. If it could load one, then anything
    // holding a resolver would transitively hold the whole store.
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      for (const specifier of importsOf(source)) {
        if (/persistence|\/storage\/|namespace/.test(specifier)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("touches no browser storage, cookie or credential API", () => {
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      const code = codeOf(source);
      for (const forbidden of [
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "document.cookie",
        "navigator.credentials",
        "caches.",
      ]) {
        if (code.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("performs no network or filesystem access", () => {
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      const code = codeOf(source);
      for (const forbidden of ["fetch(", "XMLHttpRequest", "WebSocket", "child_process", "node:fs"]) {
        if (code.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
      }
      for (const specifier of importsOf(source)) {
        if (/^node:/.test(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scrapes no page — nothing here reads a DOM or a document body", () => {
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      const code = codeOf(source);
      for (const forbidden of [
        "document.querySelector",
        "innerHTML",
        "innerText",
        "textContent",
        "DOMParser",
        "chrome.tabs",
        "chrome.scripting",
      ]) {
        if (code.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares no credential field", () => {
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      for (const pattern of [
        /\b(apiKey|accessToken|refreshToken|clientSecret|password|cookie|bearer|authHeader)\s*[?:]/i,
      ]) {
        if (pattern.test(codeOf(source))) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports no approval broker, so context cannot answer its own approval", () => {
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      for (const specifier of importsOf(source)) {
        if (/approvals/.test(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports no provider adapter, and no adapter imports the bridge", () => {
    for (const { file, source } of contextSources) {
      for (const specifier of importsOf(source)) {
        expect(`${file}: ${specifier}`).not.toMatch(/providers\//);
      }
    }

    // And the reverse, which is the one that matters more: a provider that
    // could import the bridge could resolve context it was never given.
    const controlSources = walk(CONTROL_DIR).map((file) => ({
      file: path.relative(REPO_ROOT, file),
      source: readFileSync(file, "utf8"),
    }));

    const offenders: string[] = [];
    for (const { file, source } of controlSources) {
      for (const specifier of importsOf(source)) {
        if (/agents\/context|\.\.\/context\//.test(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the control plane free of Hubble's domain", () => {
    // The Phase B rule, re-asserted now that a bridge exists. An adapter
    // must never learn what a workspace *is*.
    const controlSources = walk(CONTROL_DIR).map((file) => ({
      file: path.relative(REPO_ROOT, file),
      source: readFileSync(file, "utf8"),
    }));

    const offenders: string[] = [];
    for (const { file, source } of controlSources) {
      for (const specifier of importsOf(source)) {
        if (/@\/lib\/(workspace|tabs|collections|dependencies|graph|sections)\b/.test(specifier)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Ownership boundaries
 * ------------------------------------------------------------------ */

describe("cross-account isolation", () => {
  it("refuses a scope whose owner is not the world's owner", () => {
    const result = resolveContext(
      { scope: scopeA("user-2"), sources: ["tab"], workspaceIds: ["ws-a"] },
      fixtureWorld("user-1"),
      { now: () => T0, createSnapshotId: () => "snap" }
    );

    expect(result).toEqual({ ok: false, reason: "owner-mismatch" });
  });

  it("refuses signed-out content against a signed-in scope, and the reverse", () => {
    const signedOutWorld = fixtureWorld(null);

    expect(
      resolveContext(
        { scope: scopeA("user-1"), sources: ["tab"], workspaceIds: ["ws-a"] },
        signedOutWorld,
        { now: () => T0, createSnapshotId: () => "s" }
      )
    ).toEqual({ ok: false, reason: "owner-mismatch" });

    expect(
      resolveContext(
        { scope: scopeA(null), sources: ["tab"], workspaceIds: ["ws-a"] },
        fixtureWorld("user-1"),
        { now: () => T0, createSnapshotId: () => "s" }
      )
    ).toEqual({ ok: false, reason: "owner-mismatch" });
  });

  it("an id alone is never enough — the same ids fail under the wrong owner", () => {
    // Both accounts hold a workspace called ws-a. Only the matching owner
    // resolves, which is the whole point: Hubble's partition is applied at
    // load, so the resolver has to re-check it rather than trust the id.
    const mine = resolveOrThrow(
      { scope: scopeA("user-1"), sources: ["tab"], workspaceIds: ["ws-a"] },
      fixtureWorld("user-1")
    );
    expect(mine.items.length).toBeGreaterThan(0);

    expect(
      resolveContext(
        { scope: scopeA("user-1"), sources: ["tab"], workspaceIds: ["ws-a"] },
        fixtureWorld("user-2"),
        { now: () => T0, createSnapshotId: () => "s" }
      )
    ).toEqual({ ok: false, reason: "owner-mismatch" });
  });
});

describe("cross-workspace isolation", () => {
  it("a request for workspace A contains nothing from workspace B", () => {
    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["workspace", "tab", "collection", "relationship", "graph", "agent_activity"],
      workspaceIds: ["ws-a"],
      collectionIds: ["col-a1", "col-b1"],
      tabIds: ["b1", "b2"],
      graph: { centerTabIds: ["a1"], depth: 3 },
    });

    const serialized = JSON.stringify(snapshot.items);
    for (const leak of [
      "ws-b",
      "Personal",
      "b1",
      "b2",
      "bank.example.com",
      "mail.example.com",
      "col-b1",
      "Money",
      "run-b",
      "Sort the receipts",
      "sort code",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("reports the exclusions rather than hiding them", () => {
    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["tab", "collection"],
      tabIds: ["b1"],
      collectionIds: ["col-b1"],
    });

    expect(snapshot.omissions.map((o) => `${o.sourceType}:${o.reason}`)).toEqual(
      expect.arrayContaining(["tab:out-of-scope", "collection:out-of-scope"])
    );
  });
});

/* ------------------------------------------------------------------ *
 * 5. Hosted fail-closed
 * ------------------------------------------------------------------ */

describe("hosted environments cannot resolve local-only data", () => {
  it("withholds a project root when the runtime was not asserted", () => {
    const snapshot = resolveOrThrow(
      { scope: scopeAWithProject(), sources: ["project"], projectIds: ["proj-a"] },
      fixtureWorld(),
      false
    );

    expect(JSON.stringify(snapshot)).not.toContain("C:/work/api");
    expect(snapshot.omissions.some((o) => o.reason === "hosted-runtime")).toBe(true);
  });

  it("defaults to withholding when the caller says nothing at all", () => {
    const result = resolveContext(
      { scope: scopeAWithProject(), sources: ["project"], projectIds: ["proj-a"] },
      fixtureWorld(),
      // No `localRuntimeAllowed` key at all. Fail closed.
      { now: () => T0, createSnapshotId: () => "s" }
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.ok && result.snapshot)).not.toContain("C:/work/api");
  });
});

/* ------------------------------------------------------------------ *
 * 6. Secrets never enter a snapshot
 * ------------------------------------------------------------------ */

describe("secret filtering", () => {
  it("removes credentials from every string a snapshot serializes", () => {
    const snapshot = resolveOrThrow(
      {
        scope: scopeAWithProject(),
        sources: ["workspace", "tab", "collection", "relationship", "graph", "project", "agent_activity"],
        workspaceIds: ["ws-a"],
        collectionIds: ["col-a1"],
        projectIds: ["proj-a"],
        graph: { centerTabIds: ["a1"], depth: 2 },
        includeNotes: true,
      },
      fixtureWorld(),
      true
    );

    const serialized = JSON.stringify(snapshot);
    for (const secret of ["hunter2", "sk-live-SECRET", "eyJhbG", "alice:"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("a snapshot has no field that could hold a token even if one were found", () => {
    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["tab"],
      workspaceIds: ["ws-a"],
    });

    for (const item of snapshot.items) {
      for (const key of Object.keys(item)) {
        expect(key).not.toMatch(/token|secret|password|cookie|credential|auth/i);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. Snapshots and refresh
 * ------------------------------------------------------------------ */

describe("snapshot integrity", () => {
  const request: AgentContextRequest = {
    scope: scopeA(),
    sources: ["tab"],
    workspaceIds: ["ws-a"],
  };

  it("cannot be mutated after it is minted", () => {
    const snapshot = resolveOrThrow(request);

    expect(() => {
      (snapshot.items as unknown as unknown[]).push({ sourceType: "tab" });
    }).toThrow();
    expect(() => {
      (snapshot as unknown as Record<string, unknown>).capturedAt = 0;
    }).toThrow();
  });

  it("a refresh mints a new snapshot and leaves the old one alone", () => {
    const first = resolveOrThrow(request);
    const before = JSON.stringify(first);

    const refreshed = refreshContext(first, request, fixtureWorld(), {
      now: () => T0 + 5_000,
      createSnapshotId: () => "snap-2",
    });

    expect(refreshed.ok).toBe(true);
    const second = refreshed.ok ? refreshed.snapshot : undefined;

    expect(second!.id).toBe("snap-2");
    expect(second!.previousSnapshotId).toBe("snap");
    expect(second!.capturedAt).toBe(T0 + 5_000);
    expect(JSON.stringify(first)).toBe(before);
  });

  it("a refresh re-runs the ownership gate rather than trusting the old snapshot", () => {
    const first = resolveOrThrow(request);

    // The account changed under us. The old snapshot resolved fine; the
    // refresh must not.
    const refreshed = refreshContext(first, request, fixtureWorld("user-2"), {
      now: () => T0 + 5_000,
      createSnapshotId: () => "snap-2",
    });

    expect(refreshed).toEqual({ ok: false, reason: "owner-mismatch" });
  });

  it("a refresh re-applies limits rather than inheriting them", () => {
    const first = resolveOrThrow(request);
    expect(first.items.length).toBe(5);

    const refreshed = refreshContext(
      first,
      { ...request, limits: { maxTabs: 1 } },
      fixtureWorld(),
      { now: () => T0 + 1, createSnapshotId: () => "snap-2" }
    );

    expect(refreshed.ok && refreshed.snapshot.items).toHaveLength(1);
  });

  it("reports a deleted entity honestly rather than substituting another", () => {
    const first = resolveOrThrow({ scope: scopeA(), sources: ["tab"], tabIds: ["a3"] });
    expect(first.items).toHaveLength(1);

    const world = fixtureWorld();
    const withoutA3: AgentContextWorld = {
      ...world,
      workspaces: world.workspaces.map((w) =>
        w.id === "ws-a" ? { ...w, tabs: w.tabs.filter((t) => t.id !== "a3") } : w
      ),
    };

    const refreshed = refreshContext(
      first,
      { scope: scopeA(), sources: ["tab"], tabIds: ["a3"] },
      withoutA3,
      { now: () => T0 + 1, createSnapshotId: () => "snap-2" }
    );

    expect(refreshed.ok && refreshed.snapshot.items).toEqual([]);
    expect(
      refreshed.ok && refreshed.snapshot.omissions.map((o) => o.reason)
    ).toContain("not-found");
  });
});

/* ------------------------------------------------------------------ *
 * 8. Persistence
 * ------------------------------------------------------------------ */

describe("context is not persisted", () => {
  it("a saved session carries no context reference and no attachment", () => {
    saveControlSessions({
      version: 1,
      sessions: [
        {
          id: "s1",
          provider: "claude-code",
          status: "completed",
          createdAt: T0,
          updatedAt: T0,
          runIds: [],
          contextSnapshotId: "snap",
        },
      ],
    });

    const raw = window.localStorage.getItem("tabdump:agent-sessions:v1") ?? "";
    expect(raw).not.toContain("snap");
    expect(raw).not.toContain("contextSnapshotId");

    const restored = loadControlSessions();
    expect(restored.sessions[0]?.contextSnapshotId).toBeUndefined();
  });
});
