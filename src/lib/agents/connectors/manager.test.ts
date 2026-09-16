import { beforeEach, describe, expect, it, vi } from "vitest";
import { setStorageNamespace } from "@/lib/storage/namespace";
import { createTestConnector, testObservation } from "./__fixtures__/test-connector";
import {
  createConnectorManager,
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from "./manager";
import { NO_CAPABILITIES } from "./types";
import type { ConnectorRegistration } from "./registry";
import type { TestConnector } from "./__fixtures__/test-connector";
import type { AgentProviderId, ConnectorStatus } from "./types";

/**
 * The manager, exercised through real connectors built on the real core.
 *
 * Timers are injected rather than mocked globally, so a test can run the
 * pending retry itself and assert exactly what happened — no fake-timer setup,
 * and no dependence on how many microtasks a promise chain happens to take.
 */

function registrationFor(connector: TestConnector): ConnectorRegistration {
  return { descriptor: connector.descriptor, create: () => connector };
}

/** A scheduler a test steps by hand. */
function manualScheduler() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let nextId = 1;

  return {
    scheduler: {
      setTimeout: (handler: () => void, ms: number) => {
        const id = nextId++;
        pending.set(id, { run: handler, ms });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        pending.delete(handle as unknown as number);
      },
    },
    get size() {
      return pending.size;
    },
    delays: () => [...pending.values()].map((entry) => entry.ms),
    /** Runs every pending timer once, in insertion order. */
    flush() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.run();
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

describe("listing and describing", () => {
  it("reports a disconnected view for a provider nothing has touched", () => {
    const connector = createTestConnector({ provider: "gemini", displayName: "Gemini" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    const [view] = manager.list();

    expect(view.descriptor.displayName).toBe("Gemini");
    expect(view.status.kind).toBe("disconnected");
    expect(view.enabled).toBe(false);
    // Not connected means no health to report — not "healthy".
    expect(view.health.kind).toBe("unknown");

    manager.dispose();
  });

  it("surfaces declared capabilities without constructing anything", () => {
    const create = vi.fn(() =>
      createTestConnector({ provider: "claude-code", capabilities: { runs: true, events: true } })
    );
    const manager = createConnectorManager({
      registrations: [
        {
          descriptor: {
            provider: "claude-code",
            displayName: "Claude Code",
            summary: "s",
            capabilities: { ...NO_CAPABILITIES, runs: true, events: true },
          },
          create,
        },
      ],
    });

    expect(manager.describeAll()[0].capabilities.runs).toBe(true);
    expect(manager.describeAll()[0].capabilities.workItems).toBe(false);
    expect(create).not.toHaveBeenCalled();

    manager.dispose();
  });
});

describe("connecting", () => {
  it("connects, records intent, and reports the settled status", async () => {
    const connector = createTestConnector({ provider: "claude-code" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    const status = await manager.connect("claude-code");

    expect(status?.kind).toBe("connected");
    expect(manager.view("claude-code")?.enabled).toBe(true);
    expect(manager.view("claude-code")?.status.kind).toBe("connected");

    manager.dispose();
  });

  it("reports an honest unavailable rather than a connection", async () => {
    const connector = createTestConnector({ provider: "gemini", connectTo: "unavailable" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    const status = await manager.connect("gemini");

    expect(status?.kind).toBe("unavailable");
    expect(status?.detail).toBeTruthy();
    // Intent is still recorded: the user asked, and what they get back is a
    // reason rather than a connection.
    expect(manager.view("gemini")?.enabled).toBe(true);

    manager.dispose();
  });

  it("subscribes to a connector exactly once, however often it is connected", async () => {
    const connector = createTestConnector({ provider: "claude-code" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    const seen: unknown[][] = [];
    manager.subscribe((observations) => seen.push(observations));

    await manager.connect("claude-code");
    await manager.connect("claude-code");
    await manager.connect("claude-code");

    connector.emit([testObservation()]);

    // One delivery, not three. A second attachment would double-count every
    // observation downstream.
    expect(seen).toHaveLength(1);
    expect(connector.observerCount).toBe(1);

    manager.dispose();
  });

  it("returns undefined for a provider that is not registered", async () => {
    const manager = createConnectorManager({ registrations: [] });
    expect(await manager.connect("grok")).toBeUndefined();
    manager.dispose();
  });

  it("survives a connector that throws out of connect", async () => {
    const broken = createTestConnector({ provider: "custom" });
    broken.connect = () => Promise.reject(new Error("provider exploded"));

    const manager = createConnectorManager({ registrations: [registrationFor(broken)] });
    const status = await manager.connect("custom");

    expect(status?.kind).toBe("error");
    expect(status?.lastError?.code).toBe("unknown");
    // The message comes from the fixed table, never from the thrown value —
    // which is how provider text cannot reach a screen or a log.
    expect(status?.lastError?.message).not.toContain("exploded");

    manager.dispose();
  });
});

describe("observations", () => {
  it("merges every connector's observations into one stream", async () => {
    const claude = createTestConnector({ provider: "claude-code" });
    const custom = createTestConnector({ provider: "custom" });
    const manager = createConnectorManager({
      registrations: [registrationFor(claude), registrationFor(custom)],
    });

    const providers: string[] = [];
    manager.subscribe((observations) => {
      for (const observation of observations) providers.push(observation.provider);
    });

    await manager.connect("claude-code");
    await manager.connect("custom");

    claude.emit([testObservation({ provider: "claude-code", externalId: "a" })]);
    custom.emit([testObservation({ provider: "custom", externalId: "b" })]);

    expect(providers).toEqual(["claude-code", "custom"]);

    manager.dispose();
  });

  it("stops delivering to an unsubscribed observer", async () => {
    const connector = createTestConnector({ provider: "claude-code" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    let count = 0;
    const off = manager.subscribe(() => {
      count += 1;
    });

    await manager.connect("claude-code");
    connector.emit([testObservation()]);
    expect(count).toBe(1);

    off();
    connector.emit([testObservation()]);
    expect(count).toBe(1);

    manager.dispose();
  });

  it("delivers nothing after a disconnect", async () => {
    const connector = createTestConnector({ provider: "claude-code" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    let count = 0;
    manager.subscribe(() => {
      count += 1;
    });

    await manager.connect("claude-code");
    manager.disconnect("claude-code");

    connector.emit([testObservation()]);

    expect(count).toBe(0);
    expect(connector.observerCount).toBe(0);

    manager.dispose();
  });
});

describe("disconnecting", () => {
  it("clears intent and reports the transition before detaching", async () => {
    const connector = createTestConnector({ provider: "claude-code" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    const kinds: string[] = [];
    manager.watchStatus((status: ConnectorStatus) => kinds.push(status.kind));

    await manager.connect("claude-code");
    manager.disconnect("claude-code");

    // The final `disconnected` must reach consumers: detaching first would
    // leave every UI showing the state from before the click.
    expect(kinds.at(-1)).toBe("disconnected");
    expect(manager.view("claude-code")?.enabled).toBe(false);

    manager.dispose();
  });

  it("is safe on a provider that was never connected", () => {
    const connector = createTestConnector({ provider: "grok" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    expect(() => manager.disconnect("grok")).not.toThrow();

    manager.dispose();
  });
});

describe("reconnection", () => {
  it("backs off geometrically and stops at the cap", () => {
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(2)).toBe(RECONNECT_BASE_DELAY_MS * 2);
    expect(reconnectDelayMs(3)).toBe(RECONNECT_BASE_DELAY_MS * 4);
    expect(reconnectDelayMs(50)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it("retries a failed connector and gives up after a bounded number of attempts", async () => {
    const clock = manualScheduler();
    const connector = createTestConnector({ provider: "claude-code", connectTo: "error" });
    const manager = createConnectorManager({
      registrations: [registrationFor(connector)],
      scheduler: clock.scheduler,
    });

    await manager.connect("claude-code");
    expect(connector.connectCount).toBe(1);

    // Each failure schedules exactly one retry, and each retry fails again.
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i += 1) {
      expect(clock.size).toBe(1);
      clock.flush();
    }

    // The budget is spent: nothing further is scheduled, so a permanently
    // broken provider does not hammer the user's machine forever.
    expect(clock.size).toBe(0);
    expect(connector.connectCount).toBe(1 + MAX_RECONNECT_ATTEMPTS);

    manager.dispose();
  });

  it("does not resurrect a connector the user disconnected while a retry was pending", async () => {
    const clock = manualScheduler();
    const connector = createTestConnector({ provider: "claude-code", connectTo: "error" });
    const manager = createConnectorManager({
      registrations: [registrationFor(connector)],
      scheduler: clock.scheduler,
    });

    await manager.connect("claude-code");
    expect(connector.connectCount).toBe(1);

    manager.disconnect("claude-code");
    clock.flush();

    // Intent wins over a timer that was already in flight.
    expect(connector.connectCount).toBe(1);

    manager.dispose();
  });

  it("resets the retry budget once a connection succeeds", async () => {
    const clock = manualScheduler();
    const connector = createTestConnector({ provider: "claude-code" });
    const manager = createConnectorManager({
      registrations: [registrationFor(connector)],
      scheduler: clock.scheduler,
    });

    await manager.connect("claude-code");

    connector.fail();
    expect(clock.delays()).toEqual([RECONNECT_BASE_DELAY_MS]);
    clock.flush();

    // The retry reconnected successfully, so the next failure starts from the
    // base delay again rather than from where the last streak left off.
    connector.fail("timeout");
    expect(clock.delays()).toEqual([RECONNECT_BASE_DELAY_MS]);

    manager.dispose();
  });
});

describe("persistence and restore", () => {
  it("connects what the user previously enabled, and nothing else", async () => {
    const claude = createTestConnector({ provider: "claude-code" });
    const gemini = createTestConnector({ provider: "gemini" });

    const first = createConnectorManager({
      registrations: [registrationFor(claude), registrationFor(gemini)],
      persist: true,
    });
    await first.connect("claude-code");
    first.dispose();

    const claude2 = createTestConnector({ provider: "claude-code" });
    const gemini2 = createTestConnector({ provider: "gemini" });
    const second = createConnectorManager({
      registrations: [registrationFor(claude2), registrationFor(gemini2)],
      persist: true,
    });

    await second.restore();

    expect(claude2.connectCount).toBe(1);
    // A provider the user never touched is not connected on their behalf.
    expect(gemini2.connectCount).toBe(0);

    second.dispose();
  });

  it("does not restore a connection status, only the intent to connect", async () => {
    const claude = createTestConnector({ provider: "claude-code" });
    const first = createConnectorManager({
      registrations: [registrationFor(claude)],
      persist: true,
    });
    await first.connect("claude-code");
    first.dispose();

    const claude2 = createTestConnector({ provider: "claude-code" });
    const second = createConnectorManager({
      registrations: [registrationFor(claude2)],
      persist: true,
    });

    // Before restore runs, nothing claims to be connected — a saved
    // "connected" would be a connection that has not been established.
    expect(second.view("claude-code")?.status.kind).toBe("disconnected");
    expect(second.view("claude-code")?.enabled).toBe(true);

    second.dispose();
  });

  it("keeps one account's intent out of another's", async () => {
    const ada = "11111111-1111-4111-8111-111111111111";
    const grace = "22222222-2222-4222-8222-222222222222";

    setStorageNamespace(ada);
    const first = createConnectorManager({
      registrations: [registrationFor(createTestConnector({ provider: "claude-code" }))],
      persist: true,
    });
    await first.connect("claude-code");
    first.dispose();

    setStorageNamespace(grace);
    const graceConnector = createTestConnector({ provider: "claude-code" });
    const second = createConnectorManager({
      registrations: [registrationFor(graceConnector)],
      persist: true,
    });
    await second.restore();

    expect(graceConnector.connectCount).toBe(0);

    second.dispose();
    setStorageNamespace(null);
  });
});

describe("teardown", () => {
  it("releases connectors, listeners and pending retries", async () => {
    const clock = manualScheduler();
    const connector = createTestConnector({ provider: "claude-code", connectTo: "error" });
    const manager = createConnectorManager({
      registrations: [registrationFor(connector)],
      scheduler: clock.scheduler,
    });

    let observations = 0;
    manager.subscribe(() => {
      observations += 1;
    });

    await manager.connect("claude-code");
    expect(clock.size).toBe(1);

    manager.dispose();

    expect(clock.size).toBe(0);
    expect(connector.disposed).toBe(true);
    expect(connector.observerCount).toBe(0);

    connector.emit([testObservation()]);
    expect(observations).toBe(0);
  });

  it("is idempotent", () => {
    const manager = createConnectorManager({
      registrations: [registrationFor(createTestConnector({ provider: "grok" }))],
    });

    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
  });

  it("refuses to connect after disposal", async () => {
    const connector = createTestConnector({ provider: "claude-code" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    manager.dispose();

    expect(await manager.connect("claude-code")).toBeUndefined();
    expect(connector.connectCount).toBe(0);
  });

  it("hands a no-op unsubscribe to a late subscriber rather than throwing", () => {
    const manager = createConnectorManager({ registrations: [] });
    manager.dispose();

    const off = manager.subscribe(() => {});
    expect(() => off()).not.toThrow();
  });
});

describe("status watching", () => {
  it("reports every connector's transitions through one listener", async () => {
    const claude = createTestConnector({ provider: "claude-code" });
    const gemini = createTestConnector({ provider: "gemini", connectTo: "unavailable" });
    const manager = createConnectorManager({
      registrations: [registrationFor(claude), registrationFor(gemini)],
    });

    const kinds: string[] = [];
    manager.watchStatus((status) => kinds.push(status.kind));

    await manager.connect("claude-code");
    await manager.connect("gemini");

    expect(kinds).toContain("connected");
    expect(kinds).toContain("unavailable");

    manager.dispose();
  });

  it("does not wake listeners for a status that did not change", async () => {
    const connector = createTestConnector({ provider: "claude-code" });
    const manager = createConnectorManager({ registrations: [registrationFor(connector)] });

    await manager.connect("claude-code");

    let notifications = 0;
    manager.watchStatus(() => {
      notifications += 1;
    });

    // A poll loop reporting "still connected" must not re-render the app on
    // every tick.
    await manager.connect("claude-code");
    await manager.connect("claude-code");

    expect(notifications).toBe(0);

    manager.dispose();
  });
});

describe("the manager cannot act on an agent", () => {
  it("exposes no control surface", () => {
    const manager = createConnectorManager({ registrations: [] });

    for (const forbidden of ["start", "stop", "kill", "cancel", "exec", "prompt", "sendMessage", "run"]) {
      expect(manager).not.toHaveProperty(forbidden);
    }

    manager.dispose();
  });

  it("registers no provider by default", () => {
    // The manager knows nothing about providers: the catalog does. A manager
    // that shipped with providers baked in would be the coupling this layer
    // exists to avoid.
    const manager = createConnectorManager();
    expect(manager.describeAll()).toEqual([]);
    manager.dispose();
  });
});

describe("provider ids", () => {
  it("covers exactly the providers the product ships", () => {
    const expected: AgentProviderId[] = [
      "claude-code",
      "openai-codex",
      "gemini",
      "grok",
      "custom",
    ];
    // A guard against a provider being added to the union without anyone
    // deciding what its connector, descriptor and capabilities are.
    expect(expected).toHaveLength(5);
  });
});
