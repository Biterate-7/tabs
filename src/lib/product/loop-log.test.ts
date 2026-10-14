import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LOOP_RECORDS, REVISIT_GAP_MS, loopSummary, readLoopLog, recordLoopMilestone, recordWorkspaceVisit } from "./loop-log";
import { setStorageNamespace } from "@/lib/storage/namespace";

/**
 * The local loop log: capture → find → reuse milestones, never content;
 * counted once where it must be; never sent anywhere.
 */

const T0 = 1_700_000_000_000;

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

describe("recordLoopMilestone", () => {
  it("keeps the kind, the time and the AI app — nothing else", () => {
    recordLoopMilestone("conversation_captured", { provider: "claude", ...({ prompt: "Causes of WW1", url: "https://claude.ai/chat/x" } as object) }, T0);
    expect(readLoopLog()).toEqual([{ kind: "conversation_captured", at: T0, provider: "claude" }]);
    expect(window.localStorage.getItem("tabdump:loop-log:v1")).not.toMatch(/Causes|claude\.ai/);
  });

  it("counts a milestone given a `once` key a single time, across re-reads, and keeps no copy of the key", () => {
    recordLoopMilestone("project_returned", { once: "project-42:Mon" }, T0);
    recordLoopMilestone("project_returned", { once: "project-42:Mon" }, T0 + 1);
    recordLoopMilestone("project_returned", { once: "project-42:Tue" }, T0 + 2);
    expect(readLoopLog().map((record) => record.kind)).toEqual(["project_returned", "project_returned"]);
    expect(window.localStorage.getItem("tabdump:loop-log:v1")).not.toContain("project-42");
  });

  it("drops an unknown kind (an old agent milestone included) and a provider that is not an AI app", () => {
    recordLoopMilestone("nope" as never, {}, T0);
    recordLoopMilestone("task_submitted" as never, {}, T0);
    recordLoopMilestone("memory_copied", { provider: "https://example.com/x" as never }, T0);
    expect(readLoopLog()).toEqual([{ kind: "memory_copied", at: T0 }]);
  });

  it("keeps the newest records within its bound", () => {
    for (let index = 0; index < MAX_LOOP_RECORDS + 5; index++) recordLoopMilestone("search_used", {}, T0 + index);
    const log = readLoopLog();
    expect(log).toHaveLength(MAX_LOOP_RECORDS);
    expect(log[0]!.at).toBe(T0 + 5);
  });

  it("is partitioned per account, like the projects it describes", () => {
    setStorageNamespace("user-a");
    recordLoopMilestone("workspace_created", {}, T0);
    setStorageNamespace(null);
    expect(readLoopLog()).toEqual([]);
  });

  it("never reaches the network", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    recordLoopMilestone("memory_inserted", { provider: "chatgpt" }, T0);
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
  it("says how much of what was saved came back, and across which AI apps", () => {
    const at = (offset: number) => T0 + offset;
    recordLoopMilestone("conversation_captured", { provider: "chatgpt" }, at(0));
    recordLoopMilestone("search_used", {}, at(1));
    recordLoopMilestone("memory_inserted", { provider: "claude" }, at(2));
    recordLoopMilestone("memory_copied", { provider: "gemini" }, at(3)); // nothing new saved since: not a second "came back"
    recordLoopMilestone("conversation_imported", { provider: "claude" }, at(4));
    recordLoopMilestone("note_added", {}, at(5));
    recordLoopMilestone("memory_copied", { provider: "chatgpt" }, at(6));
    const summary = loopSummary();
    expect(summary.counts.conversation_captured).toBe(1);
    expect(summary.counts.memory_copied).toBe(2);
    expect(summary.reusesAfterCapture).toBe(2);
    expect(summary.capturedFrom).toEqual(["chatgpt", "claude"]);
    expect(summary.reusedIn).toEqual(["chatgpt", "claude", "gemini"]);
    expect(summary.firstAt).toBe(at(0));
    expect(summary.lastAt).toBe(at(6));
  });
});
