import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeConnector } from "./claude-code";
import type { ClaudeObservationResponse } from "@/lib/agents/claude-code/contract";
import type { ConnectorObservation } from "../types";

/**
 * The Claude Code connector, over the real Phase 12 adapter.
 *
 * The network is faked at the adapter's own injection point and the scheduler
 * never fires, so every poll below is one this test asked for. Everything
 * between — the cursor, the in-flight guard, the subscriber-counted timer —
 * is the production code.
 */

const SESSION = "b70abc10-f01a-48de-8d41-8ac936e8eff8";

function response(over: Partial<ClaudeObservationResponse> = {}): ClaudeObservationResponse {
  return { available: true, sessions: [], observations: [], cursor: "c1", ...over };
}

function observation(over: Partial<ConnectorObservation> = {}): ConnectorObservation {
  return { provider: "claude-code", externalId: SESSION, status: "working", ...over };
}

/** A connector whose network is a function this test controls, and whose timer never fires. */
function connectorWith(fetchObservations: (cursor: string) => Promise<ClaudeObservationResponse>) {
  return createClaudeCodeConnector({
    adapterOptions: {
      fetchObservations,
      scheduler: {
        setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => {},
      },
    },
  });
}

describe("identity and capabilities", () => {
  it("declares only what the pipeline actually produces", () => {
    const connector = connectorWith(async () => response());

    expect(connector.provider).toBe("claude-code");
    expect(connector.descriptor.capabilities).toEqual({
      runs: true,
      events: true,
      files: true,
      artifacts: true,
      workItems: true,
      liveUpdates: true,
    });

    connector.dispose();
  });

  it("starts disconnected and observes nothing until connected", async () => {
    const fetchObservations = vi.fn(async () => response());
    const connector = connectorWith(fetchObservations);

    expect(connector.getStatus().kind).toBe("disconnected");
    // Constructing a connector must not read the user's machine.
    expect(fetchObservations).not.toHaveBeenCalled();

    connector.dispose();
  });
});

describe("connecting", () => {
  it("settles into connected when a local installation answers", async () => {
    const connector = connectorWith(async () => response({ sessions: [] }));

    const status = await connector.connect();

    expect(status.kind).toBe("connected");
    expect(connector.getStatus().kind).toBe("connected");

    connector.dispose();
  });

  it("reports unavailable — not an error — when nothing local is visible", async () => {
    const connector = connectorWith(async () =>
      response({ available: false, cursor: "" })
    );

    const status = await connector.connect();

    // A hosted deployment, or a machine that has never run Claude Code, is a
    // correct and stable answer rather than a fault to send someone chasing.
    expect(status.kind).toBe("unavailable");
    expect(status.detail).toContain("local Claude Code");
    expect(status.lastError).toBeUndefined();

    connector.dispose();
  });

  it("does not start a second poll loop when connected twice", async () => {
    const fetchObservations = vi.fn(async () => response());
    const connector = connectorWith(fetchObservations);

    await connector.connect();
    const afterFirst = fetchObservations.mock.calls.length;

    await connector.connect();

    expect(fetchObservations.mock.calls.length).toBe(afterFirst);

    connector.dispose();
  });

  it("recovers from unavailable to connected when the machine answers later", async () => {
    let available = false;
    const connector = connectorWith(async () => response({ available, cursor: available ? "c1" : "" }));

    await connector.connect();
    expect(connector.getStatus().kind).toBe("unavailable");

    available = true;
    await connector.refresh();

    expect(connector.getStatus().kind).toBe("connected");

    connector.dispose();
  });
});

describe("observations", () => {
  it("delivers what the endpoint returned, unchanged", async () => {
    const connector = connectorWith(async () =>
      response({ observations: [observation({ title: "Implement auth" })] })
    );

    const batches: ConnectorObservation[][] = [];
    connector.subscribe((incoming) => batches.push(incoming));

    await connector.connect();

    expect(batches).toHaveLength(1);
    expect(batches[0][0].title).toBe("Implement auth");

    connector.dispose();
  });

  it("stamps the last observation time on the status", async () => {
    const connector = connectorWith(async () => response({ observations: [observation()] }));

    connector.subscribe(() => {});
    await connector.connect();

    expect(connector.getStatus().lastObservationAt).toBeGreaterThan(0);

    connector.dispose();
  });

  it("records no observation time for a poll that found nothing", async () => {
    const connector = connectorWith(async () => response({ observations: [] }));

    connector.subscribe(() => {});
    await connector.connect();

    // Connected and quiet is a real state; claiming an observation would make
    // a healthy-looking connector out of one that has seen nothing.
    expect(connector.getStatus().lastObservationAt).toBeUndefined();

    connector.dispose();
  });

  it("surfaces sessions for the mapping UI", async () => {
    const connector = connectorWith(async () =>
      response({
        sessions: [
          {
            sessionId: SESSION,
            projectPath: "C:\\Users\\someone\\project",
            status: "working",
          } as never,
        ],
      })
    );

    await connector.connect();

    expect(connector.getSessions()).toHaveLength(1);

    connector.dispose();
  });
});

describe("failure", () => {
  it("does not mark anything failed because a read did not land", async () => {
    let fail = false;
    const connector = connectorWith(async () => {
      if (fail) throw new Error("ECONNREFUSED /api/agents/claude-code");
      return response({ observations: [observation()] });
    });

    const batches: ConnectorObservation[][] = [];
    connector.subscribe((incoming) => batches.push(incoming));

    await connector.connect();
    expect(connector.getStatus().kind).toBe("connected");

    fail = true;
    await connector.refresh();

    // A failed poll says nothing about the sessions themselves, so no run is
    // marked failed and no observation is invented.
    expect(batches).toHaveLength(1);
    expect(connector.getStatus().kind).toBe("unavailable");

    connector.dispose();
  });

  it("never carries a provider's own error text into the status", async () => {
    const connector = connectorWith(async () => {
      throw new Error("secret-bearer-token-leaked-in-message");
    });

    await connector.connect();

    expect(JSON.stringify(connector.getStatus())).not.toContain("secret-bearer-token");

    connector.dispose();
  });

  it("survives a malformed response without corrupting anything", async () => {
    const connector = connectorWith(
      async () => ({ nonsense: true }) as unknown as ClaudeObservationResponse
    );

    const batches: ConnectorObservation[][] = [];
    connector.subscribe((incoming) => batches.push(incoming));

    await expect(connector.connect()).resolves.toBeDefined();

    // No observations invented from a response that carried none.
    expect(batches).toEqual([]);
    expect(connector.getSessions()).toEqual([]);

    connector.dispose();
  });
});

describe("lifecycle and cleanup", () => {
  it("stops observing on disconnect", async () => {
    const fetchObservations = vi.fn(async () => response({ observations: [observation()] }));
    const connector = connectorWith(fetchObservations);

    const batches: ConnectorObservation[][] = [];
    connector.subscribe((incoming) => batches.push(incoming));

    await connector.connect();
    expect(batches).toHaveLength(1);

    connector.disconnect();
    expect(connector.getStatus().kind).toBe("disconnected");
    // Sessions are cleared too: a stale list would still be rendered as
    // though it described something live.
    expect(connector.getSessions()).toEqual([]);

    connector.dispose();
  });

  it("can be reconnected after a disconnect, and reports it as reconnecting", async () => {
    const connector = connectorWith(async () => response());

    await connector.connect();
    connector.disconnect();

    const kinds: string[] = [];
    connector.watchStatus((status) => kinds.push(status.kind));

    await connector.connect();

    // Not "connecting": this connector has been connected before, and saying
    // so is what distinguishes a first attempt from a recovery.
    expect(kinds[0]).toBe("reconnecting");
    expect(connector.getStatus().kind).toBe("connected");

    connector.dispose();
  });

  it("detaches an unsubscribed observer", async () => {
    const connector = connectorWith(async () => response({ observations: [observation()] }));

    let count = 0;
    const off = connector.subscribe(() => {
      count += 1;
    });

    await connector.connect();
    expect(count).toBe(1);

    off();
    await connector.refresh();

    expect(count).toBe(1);

    connector.dispose();
  });

  it("emits nothing after disposal, even from a poll already in flight", async () => {
    let release: (value: ClaudeObservationResponse) => void = () => {};
    const connector = connectorWith(
      () =>
        new Promise<ClaudeObservationResponse>((resolve) => {
          release = resolve;
        })
    );

    let count = 0;
    connector.subscribe(() => {
      count += 1;
    });

    const connecting = connector.connect();
    connector.dispose();

    release(response({ observations: [observation()] }));
    await connecting;

    // A slow read that resolves after teardown must not push into a
    // torn-down app.
    expect(count).toBe(0);
  });

  it("releases a connect that was still waiting when disconnected", async () => {
    let release: (value: ClaudeObservationResponse) => void = () => {};
    const connector = connectorWith(
      () =>
        new Promise<ClaudeObservationResponse>((resolve) => {
          release = resolve;
        })
    );

    const connecting = connector.connect();
    connector.disconnect();

    // Resolves rather than hanging forever: disconnecting mid-connect is a
    // normal thing for an impatient user to do.
    await expect(connecting).resolves.toBeDefined();

    release(response());
    connector.dispose();
  });

  it("is idempotent on dispose", async () => {
    const connector = connectorWith(async () => response());
    await connector.connect();

    connector.dispose();
    expect(() => connector.dispose()).not.toThrow();
  });
});

describe("the connector adds no control surface", () => {
  it("exposes only observation and lifecycle members", async () => {
    const connector = connectorWith(async () => response());

    for (const forbidden of ["start", "kill", "cancel", "exec", "prompt", "sendMessage", "write"]) {
      expect(connector).not.toHaveProperty(forbidden);
    }

    connector.dispose();
  });
});
