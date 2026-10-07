import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LOOP_RECORDS, REVISIT_GAP_MS, loopSummary, readLoopLog, recordLoopMilestone, recordWorkspaceVisit } from "./loop-log";
import { setStorageNamespace } from "@/lib/storage/namespace";

/**
 * The local loop log (Stage 3): milestones, never content; counted once where
 * it must be; never sent anywhere.
 */

const T0 = 1_700_000_000_000;

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

describe("recordLoopMilestone", () => {
  it("keeps the kind, the time, a provider id and an approval's answer — nothing else", () => {
    recordLoopMilestone("approval_answered", { provider: "gemini", approved: true, ...({ prompt: "Fix the auth bug", path: "C:/code" } as object) }, T0);
    expect(readLoopLog()).toEqual([{ kind: "approval_answered", at: T0, provider: "gemini", approved: true }]);
    expect(window.localStorage.getItem("tabdump:loop-log:v1")).not.toMatch(/Fix the auth|C:\/code/);
  });

  it("counts a milestone given a `once` key a single time, across re-reads, and keeps no copy of the key", () => {
    recordLoopMilestone("task_completed", { provider: "gemini", once: "session-42:7" }, T0);
    recordLoopMilestone("task_completed", { provider: "gemini", once: "session-42:7" }, T0 + 1);
    recordLoopMilestone("task_completed", { provider: "gemini", once: "session-42:9" }, T0 + 2);
    expect(readLoopLog().map((record) => record.kind)).toEqual(["task_completed", "task_completed"]);
    expect(window.localStorage.getItem("tabdump:loop-log:v1")).not.toContain("session-42");
  });

  it("drops an unknown kind and a provider that is not an id", () => {
    recordLoopMilestone("nope" as never, {}, T0);
    recordLoopMilestone("session_started", { provider: "https://example.com/x" as never }, T0);
    expect(readLoopLog()).toEqual([{ kind: "session_started", at: T0 }]);
  });

  it("keeps the newest records within its bound", () => {
    for (let index = 0; index < MAX_LOOP_RECORDS + 5; index++) recordLoopMilestone("check_run", {}, T0 + index);
    const log = readLoopLog();
    expect(log).toHaveLength(MAX_LOOP_RECORDS);
    expect(log[0]!.at).toBe(T0 + 5);
  });

  it("is partitioned per account, like the workspaces it describes", () => {
    setStorageNamespace("user-a");
    recordLoopMilestone("workspace_created", {}, T0);
    setStorageNamespace(null);
    expect(readLoopLog()).toEqual([]);
  });

  it("never reaches the network", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    recordLoopMilestone("task_submitted", { provider: "claude-code" }, T0);
    loopSummary();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});

describe("recordWorkspaceVisit", () => {
  it("counts a return at most once per gap", () => {
    recordWorkspaceVisit(T0);
    recordWorkspaceVisit(T0 + 60_000);
    recordWorkspaceVisit(T0 + REVISIT_GAP_MS + 1);
    expect(readLoopLog().filter((record) => record.kind === "workspace_revisited")).toHaveLength(2);
  });
});

describe("loopSummary", () => {
  it("says how much work went all the way round: submitted, then reviewed", () => {
    const at = (offset: number) => T0 + offset;
    recordLoopMilestone("session_started", { provider: "gemini" }, at(0));
    recordLoopMilestone("task_submitted", { provider: "gemini" }, at(1));
    recordLoopMilestone("approval_answered", { provider: "gemini", approved: true }, at(2));
    recordLoopMilestone("task_completed", { provider: "gemini" }, at(3));
    recordLoopMilestone("result_reviewed", { provider: "gemini" }, at(4));
    recordLoopMilestone("check_run", { provider: "gemini" }, at(5)); // the same task: not a second one
    recordLoopMilestone("task_submitted", { provider: "claude-code" }, at(6));
    recordLoopMilestone("session_started", { provider: "claude-code" }, at(7));
    const summary = loopSummary();
    expect(summary.counts.task_submitted).toBe(2);
    expect(summary.counts.task_completed).toBe(1);
    expect(summary.tasksReviewed).toBe(1);
    expect(summary.approvalsApproved).toBe(1);
    expect(summary.agents).toEqual(["claude-code", "gemini"]);
    expect(summary.firstAt).toBe(at(0));
  });
});
