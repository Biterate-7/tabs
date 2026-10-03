import { describe, expect, it } from "vitest";
import { capabilitySet } from "./capabilities";
import { contextCountsLine, domainEventKindFor, isWellFormedControlEvent, MAX_CONTROL_CONTEXT_COUNT } from "./events";
import { createControlService } from "./service";
import { createUnimplementedControlAdapter } from "./unimplemented";
import type { AgentControlEvent } from "./events";
import type { AgentControlAdapter, ControlResult, SessionHandle } from "./types";

/**
 * Hubble's own context events (`context_loaded`, `context_read`): the source
 * of the activity timeline's "Read workspace · 18 tabs" rows.
 *
 * Three properties matter, and each is asserted here at the layer that owns
 * it: the event can carry counts and nothing else; only Hubble can raise one
 * (an adapter that tries is dropped); and one never crosses into a session or
 * workspace it does not belong to.
 */

const T0 = 1_700_000_000_000;

function contextEvent(over: Partial<AgentControlEvent> = {}): AgentControlEvent {
  return {
    id: "e1",
    sessionId: "s1",
    provider: "claude-code",
    kind: "context_read",
    timestamp: T0,
    summary: "14 matching tabs",
    context: { workspaceId: "w1", operation: "search_tabs", ok: true, matches: 14 },
    ...over,
  };
}

describe("the context slice", () => {
  it("is required on the context kinds and refused on every other", () => {
    expect(isWellFormedControlEvent(contextEvent())).toBe(true);
    expect(isWellFormedControlEvent(contextEvent({ context: undefined }))).toBe(false);
    expect(isWellFormedControlEvent(contextEvent({ kind: "message_received" }))).toBe(false);
    expect(isWellFormedControlEvent(contextEvent({ kind: "context_loaded", context: { workspaceId: "w1", tabs: 3, collections: 1 } }))).toBe(true);
  });

  it("carries counts only — bounded non-negative integers", () => {
    for (const bad of [-1, 1.5, Number.NaN, MAX_CONTROL_CONTEXT_COUNT + 1]) {
      expect(isWellFormedControlEvent(contextEvent({ context: { workspaceId: "w1", matches: bad } }))).toBe(false);
    }
    expect(isWellFormedControlEvent(contextEvent({ context: { workspaceId: "w1", matches: "14" as unknown as number } }))).toBe(false);
  });

  it("names its operation in Hubble's vocabulary only — never free text", () => {
    for (const operation of ["search tabs for my bank", "Search_Tabs", "x".repeat(49), ""]) {
      expect(isWellFormedControlEvent(contextEvent({ context: { workspaceId: "w1", operation } }))).toBe(false);
    }
  });

  it("is said in counts and fixed words", () => {
    expect(contextCountsLine({ workspaceId: "w", tabs: 18, collections: 3 })).toBe("18 tabs · 3 collections");
    expect(contextCountsLine({ workspaceId: "w", matches: 1 })).toBe("1 matching tab");
    expect(contextCountsLine({ workspaceId: "w", ok: false, tabs: 2 })).toBe("Hubble could not answer");
    expect(contextCountsLine({ workspaceId: "w" })).toBe("Answered");
  });

  it("stays out of the durable log", () => {
    expect(domainEventKindFor("context_loaded")).toBeNull();
    expect(domainEventKindFor("context_read")).toBeNull();
  });
});

function harness(workspaceId: string | null = "w1") {
  let listener: ((event: AgentControlEvent) => void) | null = null;
  const base = createUnimplementedControlAdapter({ provider: "claude-code", detail: "test" });
  const adapter = {
    ...base,
    getCapabilities: () => capabilitySet("create_session"),
    subscribeToEvents: (next: (event: AgentControlEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    createSession: async () => ({ ok: true, value: { sessionId: "x", status: "ready" } }) as ControlResult<SessionHandle>,
  } as AgentControlAdapter;
  let counter = 0;
  const service = createControlService({
    runtime: () => ({ allowed: true as const, kind: "local-server" as const }),
    resolveAdapter: () => adapter,
    resolveProject: () => undefined,
    now: () => T0,
    createId: () => `s${++counter}`,
  });
  const seen: AgentControlEvent[] = [];
  service.subscribe((event) => seen.push(event));
  return {
    service,
    seen,
    emitAsAdapter: (event: AgentControlEvent) => listener?.(event),
    start: () => service.startSession({ provider: "claude-code", ...(workspaceId ? { workspaceId } : {}) }),
  };
}

describe("who may raise one", () => {
  it("Hubble can, with a summary it wrote from the counts", async () => {
    const h = harness();
    const started = await h.start();
    const id = started.ok ? started.value.id : "";
    h.service.recordContextEvent(id, "context_read", { workspaceId: "w1", operation: "search_tabs", ok: true, matches: 14 });
    expect(h.seen).toEqual([
      expect.objectContaining({ kind: "context_read", sessionId: id, summary: "14 matching tabs", context: { workspaceId: "w1", operation: "search_tabs", ok: true, matches: 14 } }),
    ]);
    // A read is said, not acted on: the session's state does not move.
    expect(h.service.session(id)?.status).toBe("ready");
  });

  it("an adapter cannot: a fabricated read is dropped at the boundary", async () => {
    const h = harness();
    const started = await h.start();
    const id = started.ok ? started.value.id : "";
    h.emitAsAdapter(contextEvent({ sessionId: id }));
    h.emitAsAdapter(contextEvent({ id: "e2", sessionId: id, kind: "context_loaded", context: { workspaceId: "w1", tabs: 999 } }));
    expect(h.seen.filter((event) => event.kind.startsWith("context_"))).toEqual([]);
  });

  it("never for another workspace, an unknown session, or one that has ended", async () => {
    const h = harness();
    const started = await h.start();
    const id = started.ok ? started.value.id : "";
    h.service.recordContextEvent(id, "context_read", { workspaceId: "w-other", operation: "search_tabs", matches: 1 });
    h.service.recordContextEvent("nobody", "context_read", { workspaceId: "w1", operation: "search_tabs", matches: 1 });
    expect(h.seen).toEqual([]);

    // The agent stops on an error, as an adapter reports it: the session is over.
    h.emitAsAdapter({ id: "err", sessionId: id, provider: "claude-code", kind: "error", timestamp: T0, summary: "Agent disconnected unexpectedly." });
    expect(h.service.session(id)?.status).toBe("failed");
    h.service.recordContextEvent(id, "context_read", { workspaceId: "w1", operation: "search_tabs", matches: 1 });
    expect(h.seen.filter((event) => event.kind === "context_read")).toEqual([]);
  });

  it("never for a session with no workspace", async () => {
    const h = harness(null);
    const started = await h.start();
    const id = started.ok ? started.value.id : "";
    h.service.recordContextEvent(id, "context_loaded", { workspaceId: "w1", tabs: 1 });
    expect(h.seen).toEqual([]);
  });
});
