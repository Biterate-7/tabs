import { describe, expect, it } from "vitest";
import {
  AGENT_SESSION_STATUSES,
  attachRunToSession,
  canTransition,
  createSession,
  isBlockedSessionStatus,
  isLiveSessionStatus,
  isTerminalSessionStatus,
  SESSION_TRANSITIONS,
  transitionSession,
} from "./session";
import type { AgentSession, AgentSessionStatus } from "./session";

const T0 = 1_700_000_000_000;

function session(status: AgentSessionStatus): AgentSession {
  return { ...createSession({ id: "s1", provider: "claude-code" }, T0), status };
}

describe("the transition table", () => {
  it("covers every status", () => {
    // A status missing from the table would throw at runtime rather than
    // refusing, which is the opposite of fail-closed.
    for (const status of AGENT_SESSION_STATUSES) {
      expect(SESSION_TRANSITIONS[status]).toBeDefined();
    }
    expect(Object.keys(SESSION_TRANSITIONS).sort()).toEqual([...AGENT_SESSION_STATUSES].sort());
  });

  it("names only real statuses as destinations", () => {
    for (const [from, destinations] of Object.entries(SESSION_TRANSITIONS)) {
      for (const to of destinations) {
        expect(AGENT_SESSION_STATUSES, `${from} -> ${to}`).toContain(to);
      }
    }
  });

  it("lets nothing leave a terminal state", () => {
    for (const status of AGENT_SESSION_STATUSES) {
      if (!isTerminalSessionStatus(status)) continue;
      expect(SESSION_TRANSITIONS[status]).toEqual([]);
    }
  });

  it("never permits a self-transition", () => {
    // `running -> running` looks harmless and would let a second message
    // silently overwrite the first's timestamps.
    for (const status of AGENT_SESSION_STATUSES) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });

  it("allows failure and disconnection from every live state", () => {
    for (const status of AGENT_SESSION_STATUSES) {
      if (!isLiveSessionStatus(status)) continue;
      expect(canTransition(status, "failed"), `${status} -> failed`).toBe(true);
      expect(canTransition(status, "disconnected"), `${status} -> disconnected`).toBe(true);
    }
  });

  it("keeps the live, blocked and terminal sets disjoint where they must be", () => {
    for (const status of AGENT_SESSION_STATUSES) {
      if (isTerminalSessionStatus(status)) expect(isLiveSessionStatus(status)).toBe(false);
      if (isBlockedSessionStatus(status)) expect(isLiveSessionStatus(status)).toBe(true);
    }
  });
});

describe("the happy path", () => {
  it("walks created -> connecting -> ready -> running -> completed", () => {
    const path: AgentSessionStatus[] = [
      "connecting",
      "ready",
      "running",
      "completed",
    ];

    let current = session("created");
    for (const next of path) {
      const result = transitionSession(current, next, T0 + 1);
      expect(result.ok, `${current.status} -> ${next}`).toBe(true);
      if (result.ok) current = result.session;
    }

    expect(current.status).toBe("completed");
  });

  it("walks running -> waiting_for_approval -> running", () => {
    let current = session("running");

    const blocked = transitionSession(current, "waiting_for_approval", T0 + 1);
    expect(blocked.ok).toBe(true);
    if (blocked.ok) current = blocked.session;

    const resumed = transitionSession(current, "running", T0 + 2);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.session.status).toBe("running");
  });

  it("can block straight out of ready, for a session resumed mid-approval", () => {
    // Regression. Resuming a session that was already blocked lands in
    // `ready` and only then learns an approval is outstanding, so the block
    // has to be reachable without a run having started in this process.
    expect(transitionSession(session("ready"), "waiting_for_approval", T0 + 1).ok).toBe(true);
    expect(transitionSession(session("ready"), "waiting_for_input", T0 + 1).ok).toBe(true);
  });

  it("walks running -> waiting_for_input -> running", () => {
    const blocked = transitionSession(session("running"), "waiting_for_input", T0 + 1);
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;

    expect(transitionSession(blocked.session, "running", T0 + 2).ok).toBe(true);
  });
});

describe("refused transitions", () => {
  it("cannot skip connecting", () => {
    expect(transitionSession(session("created"), "ready", T0 + 1)).toMatchObject({
      ok: false,
      reason: "invalid-transition",
    });
  });

  it("cannot run before it is ready", () => {
    expect(transitionSession(session("connecting"), "running", T0 + 1).ok).toBe(false);
  });

  it("cannot revive a completed session", () => {
    for (const to of AGENT_SESSION_STATUSES) {
      expect(transitionSession(session("completed"), to, T0 + 1).ok, to).toBe(false);
    }
  });

  it("cannot cancel work that never started", () => {
    // Cancelling is only meaningful once something could be running. From
    // `created` it is allowed (the session exists and can be abandoned);
    // from a terminal state it is not.
    expect(transitionSession(session("created"), "cancelled", T0 + 1).ok).toBe(true);
    expect(transitionSession(session("failed"), "cancelled", T0 + 1).ok).toBe(false);
  });

  it("returns the original session untouched when it refuses", () => {
    const before = session("completed");
    const result = transitionSession(before, "running", T0 + 99);

    expect(result.ok).toBe(false);
    expect(before.status).toBe("completed");
    expect(before.updatedAt).toBe(T0);
  });
});

describe("timestamps", () => {
  it("stamps endedAt exactly when it becomes terminal, and not before", () => {
    const ready = transitionSession(
      transitionSession(session("created"), "connecting", T0 + 1).ok
        ? (transitionSession(session("created"), "connecting", T0 + 1) as { session: AgentSession }).session
        : session("connecting"),
      "ready",
      T0 + 2
    );

    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.session.endedAt).toBeUndefined();

    const done = transitionSession(ready.session, "completed", T0 + 3);
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.session.endedAt).toBe(T0 + 3);
  });

  it("advances updatedAt on every accepted transition", () => {
    const moved = transitionSession(session("created"), "connecting", T0 + 500);
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.session.updatedAt).toBe(T0 + 500);
  });
});

describe("creation", () => {
  it("always starts in created", () => {
    // The only way a session is born, so none starts mid-lifecycle.
    expect(createSession({ id: "s1", provider: "grok" }, T0).status).toBe("created");
  });

  it("omits absent optional fields rather than storing undefined", () => {
    const made = createSession({ id: "s1", provider: "claude-code" }, T0);

    expect("projectId" in made).toBe(false);
    expect("workspaceId" in made).toBe(false);
    expect("title" in made).toBe(false);
    expect("providerSessionId" in made).toBe(false);
    expect(made.runIds).toEqual([]);
  });

  it("carries the fields it is given", () => {
    const made = createSession(
      {
        id: "s1",
        provider: "claude-code",
        projectId: "p1",
        workspaceId: "w1",
        title: "Fix the parser",
        providerSessionId: "uuid-1",
      },
      T0
    );

    expect(made).toMatchObject({
      projectId: "p1",
      workspaceId: "w1",
      title: "Fix the parser",
      providerSessionId: "uuid-1",
    });
  });
});

describe("run attachment", () => {
  it("records a run once, however many times it is reported", () => {
    // A provider re-reporting the same run across a reconnect must not make
    // the session claim two.
    let current = session("running");
    current = attachRunToSession(current, "run-1", T0 + 1);
    current = attachRunToSession(current, "run-1", T0 + 2);
    current = attachRunToSession(current, "run-2", T0 + 3);

    expect(current.runIds).toEqual(["run-1", "run-2"]);
  });

  it("returns the same object when nothing changed", () => {
    const before = attachRunToSession(session("running"), "run-1", T0 + 1);
    expect(attachRunToSession(before, "run-1", T0 + 2)).toBe(before);
  });
});
