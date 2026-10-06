import { beforeEach, describe, expect, it } from "vitest";
import { forgetLastTask, lastTaskFor, lastTaskOf, lastTaskStateLabel, rememberLastTask } from "./last-task";
import { setStorageNamespace } from "@/lib/storage/namespace";
import type { TaskOutcome } from "@/lib/agents/activity/outcome";

/** A workspace's last agent task (Stage 3): what a returning developer is shown. */

const T0 = 1_700_000_000_000;

function outcome(over: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    state: "done",
    headline: "Changed 2 files in hubble-app",
    task: "Fix the authentication bug.",
    taskSequence: 4,
    changes: { files: 2, added: 17, removed: 6, counted: true, workspace: 0, partial: false, latestProjectChangeId: "ap1" },
    checks: [{ check: "test", label: "Tests", outcome: "passed" }],
    rejected: 0,
    at: T0,
    ...over,
  };
}

const of = (over: Partial<TaskOutcome> = {}, workspaceId = "w-dev") =>
  lastTaskOf({ workspaceId, sessionId: "s1", provider: "gemini", projectId: "p1", outcome: outcome(over), checksAvailable: true })!;

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

describe("lastTaskOf", () => {
  it("is the outcome in words: state, headline, task and facts", () => {
    expect(of()).toEqual({
      workspaceId: "w-dev",
      sessionId: "s1",
      provider: "gemini",
      projectId: "p1",
      state: "done",
      headline: "Changed 2 files in hubble-app",
      task: "Fix the authentication bug.",
      facts: ["+17 −6", "Tests passed"],
      attention: false,
      at: T0,
    });
  });

  it("is nothing for a session that has no task yet", () => {
    expect(lastTaskOf({ workspaceId: "w-dev", sessionId: "s1", provider: "gemini", outcome: outcome({ state: "ready", task: undefined as never }) })).toBeUndefined();
  });

  it("marks what still asks for the developer", () => {
    expect(of({ state: "needs_you" }).attention).toBe(true);
    expect(of({ checks: [{ check: "test", label: "Tests", outcome: "failed" }] }).attention).toBe(true);
  });
});

describe("rememberLastTask", () => {
  it("keeps one task per workspace, and never lets an older one replace a newer", () => {
    rememberLastTask(of({ at: T0 + 10, headline: "Newer" }));
    rememberLastTask(of({ at: T0, headline: "Older" }));
    rememberLastTask(of({ at: T0 + 5, headline: "Elsewhere" }, "w-research"));
    expect(lastTaskFor("w-dev")?.headline).toBe("Newer");
    expect(lastTaskFor("w-research")?.headline).toBe("Elsewhere");
  });

  it("is partitioned per account", () => {
    setStorageNamespace("user-a");
    rememberLastTask(of());
    setStorageNamespace(null);
    expect(lastTaskFor("w-dev")).toBeUndefined();
  });

  it("is forgotten with its workspace, and survives corrupted storage", () => {
    rememberLastTask(of());
    forgetLastTask("w-dev");
    expect(lastTaskFor("w-dev")).toBeUndefined();
    window.localStorage.setItem("tabdump:agent-last-task:v1", "{not json");
    expect(lastTaskFor("w-dev")).toBeUndefined();
    window.localStorage.setItem("tabdump:agent-last-task:v1", JSON.stringify({ version: 1, tasks: [{ workspaceId: "w-dev", state: "exploded" }] }));
    expect(lastTaskFor("w-dev")).toBeUndefined();
  });
});

describe("lastTaskStateLabel", () => {
  it("never claims an agent is still working when it was only last seen so", () => {
    expect(lastTaskStateLabel({ state: "working" })).toBe("Last seen working");
    expect(lastTaskStateLabel({ state: "needs_you" })).toBe("Was waiting for you");
    expect(lastTaskStateLabel({ state: "done" })).toBe("Done");
  });
});
