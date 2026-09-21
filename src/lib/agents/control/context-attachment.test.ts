import { describe, expect, it } from "vitest";
import { createControlService } from "./service";
import { createUnimplementedControlAdapter } from "./unimplemented";
import { capabilitySet } from "./capabilities";
import { isWellFormedAttachedContext } from "./context";
import { attachContextToSession, createSession } from "./session";
import type { AgentAttachedContext, AgentContextAttachment } from "./context";
import type { AgentControlAdapter, ControlResult, CreateSessionRequest } from "./types";

/**
 * The control plane's side of context attachment.
 *
 * What is under test here is deliberately narrow: this layer *carries*
 * context, it does not resolve any. Everything about what a snapshot
 * contains lives in `lib/agents/context/`, and the guard suite there proves
 * this directory cannot reach it.
 */

const T0 = 1_700_000_000_000;

function attachments(...ids: string[]): AgentContextAttachment[] {
  return ids.map((id) => ({ kind: "tab" as const, id, label: `Tab ${id}` }));
}

function context(over: Partial<AgentAttachedContext> = {}): AgentAttachedContext {
  return { snapshotId: "snap-1", capturedAt: T0, attachments: attachments("a1"), ...over };
}

function adapterSpy() {
  const creations: CreateSessionRequest[] = [];
  const base = createUnimplementedControlAdapter({ provider: "claude-code", detail: "test" });

  const adapter = {
    ...base,
    getCapabilities: () => capabilitySet("create_session", "message", "cancel_run"),
    createSession: async (request: CreateSessionRequest) => {
      creations.push(request);
      return { ok: true, value: { sessionId: request.sessionId, status: "ready" } } as ControlResult<{
        sessionId: string;
        status: "ready";
      }>;
    },
    sendMessage: async () => ({ ok: true, value: undefined }) as ControlResult<void>,
    cancelRun: async () => ({ ok: true, value: undefined }) as ControlResult<void>,
  } as AgentControlAdapter;

  return { adapter, creations };
}

function service(adapter: AgentControlAdapter) {
  return createControlService({
    runtime: () => ({ allowed: true, kind: "local-desktop" }),
    resolveAdapter: () => adapter,
    now: () => T0,
  });
}

describe("well-formedness", () => {
  it("accepts a coherent attached context", () => {
    expect(isWellFormedAttachedContext(context())).toBe(true);
  });

  it("rejects one with no snapshot id, or an unusable capture time", () => {
    expect(isWellFormedAttachedContext(context({ snapshotId: "" }))).toBe(false);
    expect(isWellFormedAttachedContext(context({ capturedAt: Number.NaN }))).toBe(false);
  });

  it("rejects one carrying more attachments than a message may", () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      kind: "tab" as const,
      id: `t${i}`,
      label: `Tab ${i}`,
    }));
    expect(isWellFormedAttachedContext(context({ attachments: tooMany }))).toBe(false);
  });
});

describe("seeding a session", () => {
  it("hands the attachments to the adapter and records the snapshot id", async () => {
    const { adapter, creations } = adapterSpy();
    const control = service(adapter);

    const started = await control.startSession({ provider: "claude-code", context: context() });

    expect(started.ok).toBe(true);
    expect(creations[0].attachments).toEqual(attachments("a1"));
    expect(started.ok && started.value.contextSnapshotId).toBe("snap-1");
    expect(control.contextFor(started.ok ? started.value.id : "")).toEqual(context());
  });

  it("starts with nothing attached by default", async () => {
    const { adapter, creations } = adapterSpy();
    const control = service(adapter);

    const started = await control.startSession({ provider: "claude-code" });

    expect(creations[0].attachments).toEqual([]);
    expect(started.ok && started.value.contextSnapshotId).toBeUndefined();
    expect(control.contextFor(started.ok ? started.value.id : "")).toBeUndefined();
  });

  it("refuses the whole start rather than quietly dropping bad context", async () => {
    const { adapter, creations } = adapterSpy();
    const control = service(adapter);

    const started = await control.startSession({
      provider: "claude-code",
      context: context({ snapshotId: "" }),
    });

    expect(started).toEqual({
      ok: false,
      error: { code: "invalid-request", message: expect.any(String) },
    });
    expect(creations).toEqual([]);
  });
});

describe("attaching and detaching", () => {
  it("replaces rather than merging, so a session knows one thing at a time", async () => {
    const { adapter } = adapterSpy();
    const control = service(adapter);
    const started = await control.startSession({ provider: "claude-code", context: context() });
    const id = started.ok ? started.value.id : "";

    const second = context({ snapshotId: "snap-2", attachments: attachments("b1", "b2") });
    const attached = control.attachContext(id, second);

    expect(attached.ok).toBe(true);
    expect(control.contextFor(id)).toEqual(second);
    expect(attached.ok && attached.value.contextSnapshotId).toBe("snap-2");
  });

  it("clears the reference on detach", async () => {
    const { adapter } = adapterSpy();
    const control = service(adapter);
    const started = await control.startSession({ provider: "claude-code", context: context() });
    const id = started.ok ? started.value.id : "";

    const detached = control.detachContext(id);

    expect(detached.ok).toBe(true);
    expect(detached.ok && detached.value.contextSnapshotId).toBeUndefined();
    expect(control.contextFor(id)).toBeUndefined();
  });

  it("is idempotent on a session that holds nothing", async () => {
    const { adapter } = adapterSpy();
    const control = service(adapter);
    const started = await control.startSession({ provider: "claude-code" });
    const id = started.ok ? started.value.id : "";

    expect(control.detachContext(id).ok).toBe(true);
    expect(control.detachContext(id).ok).toBe(true);
  });

  it("refuses an unknown session", () => {
    const { adapter } = adapterSpy();
    expect(service(adapter).attachContext("nope", context())).toEqual({
      ok: false,
      error: { code: "invalid-session", message: expect.any(String) },
    });
  });

  it("refuses a finished session, so a closed record cannot gain context", async () => {
    const { adapter } = adapterSpy();
    const control = service(adapter);
    const started = await control.startSession({ provider: "claude-code" });
    const id = started.ok ? started.value.id : "";

    await control.cancelRun(id);
    expect(control.session(id)?.status).toBe("cancelled");

    expect(control.attachContext(id, context())).toEqual({
      ok: false,
      error: { code: "invalid-session", message: expect.any(String) },
    });
  });

  it("refuses malformed context", async () => {
    const { adapter } = adapterSpy();
    const control = service(adapter);
    const started = await control.startSession({ provider: "claude-code" });

    expect(
      control.attachContext(started.ok ? started.value.id : "", context({ capturedAt: Number.NaN }))
    ).toEqual({ ok: false, error: { code: "invalid-request", message: expect.any(String) } });
  });
});

/** Everything attaching a snapshot is allowed to move, removed. */
function stripped(session: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...session };
  delete copy.contextSnapshotId;
  delete copy.updatedAt;
  return copy;
}

describe("the session record", () => {
  it("attaching a snapshot id changes nothing else about it", () => {
    const session = createSession({ id: "s1", provider: "claude-code", projectId: "p1" }, T0);
    const next = attachContextToSession(session, "snap-1", T0 + 1);

    expect(next.contextSnapshotId).toBe("snap-1");
    expect(stripped(next)).toEqual(stripped(session));
  });

  it("is a no-op when the snapshot is already the one held", () => {
    const session = createSession({ id: "s1", provider: "claude-code" }, T0);
    const once = attachContextToSession(session, "snap-1", T0 + 1);
    expect(attachContextToSession(once, "snap-1", T0 + 2)).toBe(once);
  });
});
