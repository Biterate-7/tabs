import { describe, expect, it, vi } from "vitest";
import { capabilitySet } from "./capabilities";
import { createControlService } from "./service";
import { createGrant } from "./permissions";
import { createProject } from "./projects";
import { createUnimplementedControlAdapter } from "./unimplemented";
import type { AgentControlEvent } from "./events";
import type { AgentProject } from "./projects";
import type { AgentCapabilitySet } from "./capabilities";
import type { AgentControlAdapter, ControlResult, SessionHandle } from "./types";

/**
 * The service's job is to refuse things.
 *
 * Every case below drives one gate on its own, with the others satisfied —
 * a gate that only works because the one before it also fired is a gate that
 * stops working the day the order changes.
 */

const T0 = 1_700_000_000_000;
const ALLOW = () => ({ allowed: true as const, kind: "local-server" as const });

function project(over: Partial<AgentProject> = {}): AgentProject {
  const made = createProject(
    { id: "p1", name: "Research", path: "C:/work/research", providers: ["claude-code"] },
    T0
  );
  if (!made.ok) throw new Error("fixture failed");
  return { ...made.project, ...over };
}

type Spy = AgentControlAdapter & {
  calls: string[];
  emit: (event: AgentControlEvent) => void;
};

function spyAdapter(capabilities: AgentCapabilitySet, over: Partial<AgentControlAdapter> = {}): Spy {
  const calls: string[] = [];
  const base = createUnimplementedControlAdapter({ provider: "claude-code", detail: "test" });
  let listener: ((event: AgentControlEvent) => void) | null = null;

  const adapter: Spy = {
    ...base,
    calls,
    emit: (event) => listener?.(event),
    getCapabilities: () => capabilities,
    subscribeToEvents: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    createSession: async () => {
      calls.push("createSession");
      return { ok: true, value: { sessionId: "ignored", status: "ready" } } as ControlResult<SessionHandle>;
    },
    resumeSession: async () => {
      calls.push("resumeSession");
      return {
        ok: true,
        value: { sessionId: "ignored", providerSessionId: "uuid-1", status: "ready" },
      } as ControlResult<SessionHandle>;
    },
    sendMessage: async () => {
      calls.push("sendMessage");
      return { ok: true, value: undefined };
    },
    cancelRun: async () => {
      calls.push("cancelRun");
      return { ok: true, value: undefined };
    },
    respondToApproval: async () => {
      calls.push("respondToApproval");
      return { ok: true, value: undefined };
    },
    ...over,
  } as Spy;

  return adapter;
}

function serviceWith(adapter: AgentControlAdapter, over: Record<string, unknown> = {}) {
  let counter = 0;
  return createControlService({
    runtime: ALLOW,
    resolveAdapter: () => adapter,
    resolveProject: (id) => (id === "p1" ? project() : undefined),
    now: () => T0,
    createId: () => `s${++counter}`,
    ...over,
  });
}

describe("starting a session", () => {
  it("reaches the adapter and returns a ready session", async () => {
    const adapter = spyAdapter(capabilitySet("create_session"));
    const service = serviceWith(adapter);

    const result = await service.startSession({ provider: "claude-code" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("ready");
    expect(adapter.calls).toEqual(["createSession"]);
  });

  it("keeps TabDump's own session id rather than the adapter's", async () => {
    // The adapter returns `sessionId: "ignored"`. TabDump's id is the handle
    // every other layer uses, and an adapter must not be able to rename it.
    const service = serviceWith(spyAdapter(capabilitySet("create_session")));
    const result = await service.startSession({ provider: "claude-code" });

    expect(result.ok && result.value.id).toBe("s1");
  });

  it("records the session as failed when the adapter refuses", async () => {
    const adapter = spyAdapter(capabilitySet("create_session"), {
      createSession: async () => ({ ok: false, error: { code: "unreachable", message: "x" } }),
    });
    const service = serviceWith(adapter);

    const result = await service.startSession({ provider: "claude-code" });

    expect(result).toMatchObject({ ok: false, error: { code: "unreachable" } });
    expect(service.sessions()[0]?.status).toBe("failed");
  });

  it("passes the resolved project to the adapter, not the id", async () => {
    // The adapter receives an already-validated, already-authorized project.
    // It never resolves one itself and never sees a raw path from a caller.
    let seen: AgentProject | undefined;
    const adapter = spyAdapter(capabilitySet("create_session"), {
      createSession: async (request) => {
        seen = request.project;
        return { ok: true, value: { sessionId: "x", status: "ready" } };
      },
    });

    const grant = createGrant(["read_project"], T0, "p1")!;
    await serviceWith(adapter).startSession({
      provider: "claude-code",
      projectId: "p1",
      permissions: grant,
    });

    expect(seen?.path).toBe("C:/work/research");
  });
});

describe("resuming a session", () => {
  it("carries the provider's own id through", async () => {
    const adapter = spyAdapter(capabilitySet("resume_session"));
    const service = serviceWith(adapter);

    const result = await service.resumeSession({
      provider: "claude-code",
      providerSessionId: "uuid-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.providerSessionId).toBe("uuid-1");
    expect(adapter.calls).toEqual(["resumeSession"]);
  });

  it("refuses when the adapter does not declare resume", async () => {
    const adapter = spyAdapter(capabilitySet("create_session"));
    const result = await serviceWith(adapter).resumeSession({
      provider: "claude-code",
      providerSessionId: "uuid-1",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(adapter.calls).toEqual([]);
  });
});

describe("sending a message", () => {
  async function readySession(capabilities = capabilitySet("create_session", "message")) {
    const adapter = spyAdapter(capabilities);
    const service = serviceWith(adapter);
    const started = await service.startSession({ provider: "claude-code" });
    return { adapter, service, sessionId: started.ok ? started.value.id : "" };
  }

  it("delivers and moves the session to running", async () => {
    const { adapter, service, sessionId } = await readySession();

    const sent = await service.sendMessage({
      sessionId,
      text: "fix the parser",
      context: { attachments: [] },
    });

    expect(sent.ok).toBe(true);
    expect(adapter.calls).toEqual(["createSession", "sendMessage"]);
    expect(service.session(sessionId)?.status).toBe("running");
  });

  it("refuses an unknown session", async () => {
    const { service } = await readySession();

    const sent = await service.sendMessage({
      sessionId: "nope",
      text: "hello",
      context: { attachments: [] },
    });

    expect(sent).toMatchObject({ ok: false, error: { code: "invalid-session" } });
  });

  it("refuses an empty or over-long message before any gate", async () => {
    const { adapter, service, sessionId } = await readySession();

    for (const text of ["", "   ", "x".repeat(200_000)]) {
      const sent = await service.sendMessage({ sessionId, text, context: { attachments: [] } });
      expect(sent).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    }

    expect(adapter.calls).toEqual(["createSession"]);
  });

  it("refuses a context carrying more attachments than the cap", async () => {
    const { adapter, service, sessionId } = await readySession();

    const sent = await service.sendMessage({
      sessionId,
      text: "go",
      context: {
        attachments: Array.from({ length: 500 }, (_, index) => ({
          kind: "tab" as const,
          id: `t${index}`,
          label: "Tab",
        })),
      },
    });

    expect(sent).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(adapter.calls).toEqual(["createSession"]);
  });

  it("refuses once the session has ended", async () => {
    const { service, sessionId } = await readySession(
      capabilitySet("create_session", "message", "cancel_run")
    );

    await service.cancelRun(sessionId);

    const sent = await service.sendMessage({
      sessionId,
      text: "still there?",
      context: { attachments: [] },
    });

    expect(sent).toMatchObject({ ok: false, error: { code: "invalid-session" } });
  });
});

describe("cancelling", () => {
  it("moves the session to cancelled", async () => {
    const adapter = spyAdapter(capabilitySet("create_session", "cancel_run"));
    const service = serviceWith(adapter);
    const started = await service.startSession({ provider: "claude-code" });
    const sessionId = started.ok ? started.value.id : "";

    const cancelled = await service.cancelRun(sessionId);

    expect(cancelled.ok).toBe(true);
    expect(service.session(sessionId)?.status).toBe("cancelled");
  });

  it("does not mark it cancelled when the adapter refused", async () => {
    // A session the provider could not stop is still running, whatever the
    // UI would prefer to show.
    const adapter = spyAdapter(capabilitySet("create_session", "cancel_run"), {
      cancelRun: async () => ({ ok: false, error: { code: "unreachable", message: "x" } }),
    });
    const service = serviceWith(adapter);
    const started = await service.startSession({ provider: "claude-code" });
    const sessionId = started.ok ? started.value.id : "";

    expect((await service.cancelRun(sessionId)).ok).toBe(false);
    expect(service.session(sessionId)?.status).toBe("ready");
  });
});

describe("events from an adapter", () => {
  async function running() {
    const adapter = spyAdapter(capabilitySet("create_session", "message"));
    const service = serviceWith(adapter);
    const started = await service.startSession({ provider: "claude-code" });
    return { adapter, service, sessionId: started.ok ? started.value.id : "" };
  }

  function base(sessionId: string): AgentControlEvent {
    return {
      id: "e1",
      sessionId,
      provider: "claude-code",
      kind: "thinking",
      timestamp: T0,
      summary: "working",
    };
  }

  it("forwards a well-formed event to subscribers", async () => {
    const { adapter, service, sessionId } = await running();
    const seen: AgentControlEvent[] = [];
    service.subscribe((event) => seen.push(event));

    adapter.emit(base(sessionId));

    expect(seen).toHaveLength(1);
    expect(service.session(sessionId)?.status).toBe("running");
  });

  it("drops a malformed event at the boundary", async () => {
    // An adapter is not trusted to have normalized correctly.
    const { adapter, service, sessionId } = await running();
    const seen: AgentControlEvent[] = [];
    service.subscribe((event) => seen.push(event));

    adapter.emit({
      ...base(sessionId),
      kind: "file_modified",
      file: { relativePath: "../../etc/passwd", projectId: "p1" },
    });

    expect(seen).toEqual([]);
  });

  it("drops an event for a session it does not own", async () => {
    const { adapter, service } = await running();
    const seen: AgentControlEvent[] = [];
    service.subscribe((event) => seen.push(event));

    adapter.emit(base("someone-elses-session"));

    expect(seen).toEqual([]);
  });

  it("drops an event whose provider does not match the stream it arrived on", async () => {
    const { adapter, service, sessionId } = await running();
    const seen: AgentControlEvent[] = [];
    service.subscribe((event) => seen.push(event));

    adapter.emit({ ...base(sessionId), provider: "grok" });

    expect(seen).toEqual([]);
  });

  it("moves the session through approval and back", async () => {
    const { adapter, service, sessionId } = await running();

    adapter.emit({ ...base(sessionId), kind: "approval_requested", approvalId: "a1" });
    expect(service.session(sessionId)?.status).toBe("waiting_for_approval");

    adapter.emit({ ...base(sessionId), kind: "approval_granted", approvalId: "a1" });
    expect(service.session(sessionId)?.status).toBe("running");
  });

  it("refuses to apply an impossible transition an adapter implies", async () => {
    // The adapter describes what happened; the service decides what that
    // means. A `run_completed` on a cancelled session must not revive it.
    const adapter = spyAdapter(capabilitySet("create_session", "cancel_run"));
    const service = serviceWith(adapter);
    const started = await service.startSession({ provider: "claude-code" });
    const sessionId = started.ok ? started.value.id : "";
    await service.cancelRun(sessionId);

    adapter.emit({ ...base(sessionId), kind: "run_completed" });

    expect(service.session(sessionId)?.status).toBe("cancelled");
  });

  it("subscribes to an adapter once however many sessions it has", async () => {
    const subscribe = vi.fn(() => () => {});
    const adapter = spyAdapter(capabilitySet("create_session"), {
      subscribeToEvents: subscribe,
    });
    const service = serviceWith(adapter);

    await service.startSession({ provider: "claude-code" });
    await service.startSession({ provider: "claude-code" });
    await service.startSession({ provider: "claude-code" });

    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});

describe("approvals through the service", () => {
  it("settles the broker even when the adapter then fails", async () => {
    // A deny must never be lost because a provider was unreachable.
    const adapter = spyAdapter(capabilitySet("create_session", "approvals"), {
      respondToApproval: async () => ({ ok: false, error: { code: "unreachable", message: "x" } }),
    });
    const service = serviceWith(adapter);
    const started = await service.startSession({ provider: "claude-code" });
    const sessionId = started.ok ? started.value.id : "";

    service.approvals.request(
      {
        id: "a1",
        sessionId,
        provider: "claude-code",
        action: "modify_files",
        scope: "write_project",
        projectId: "p1",
        targets: ["notes.md"],
      },
      T0
    );

    const responded = await service.respondToApproval("a1", "denied");

    expect(responded.ok).toBe(false);
    expect(service.approvals.get("a1")?.status).toBe("denied");
  });

  it("refuses an unknown approval", async () => {
    const service = serviceWith(spyAdapter(capabilitySet("approvals")));
    expect(await service.respondToApproval("ghost", "granted")).toMatchObject({
      ok: false,
      error: { code: "invalid-request" },
    });
  });
});

describe("canDrive", () => {
  it("is false when the runtime denies, whatever the adapter claims", () => {
    const service = createControlService({
      runtime: () => ({ allowed: false, kind: "hosted", reason: "hosted-platform" }),
      resolveAdapter: () => spyAdapter(capabilitySet("message")),
      now: () => T0,
    });

    expect(service.canDrive("claude-code", "message")).toBe(false);
  });

  it("is false for an undeclared capability", () => {
    const service = serviceWith(spyAdapter(capabilitySet("create_session")));
    expect(service.canDrive("claude-code", "message")).toBe(false);
    expect(service.canDrive("claude-code", "create_session")).toBe(true);
  });
});

describe("run attachment", () => {
  it("references a domain run without duplicating it", async () => {
    const service = serviceWith(spyAdapter(capabilitySet("create_session")));
    const started = await service.startSession({ provider: "claude-code" });
    const sessionId = started.ok ? started.value.id : "";

    service.attachRun(sessionId, "run-1");
    service.attachRun(sessionId, "run-1");

    expect(service.session(sessionId)?.runIds).toEqual(["run-1"]);
  });
});
