import { beforeEach, describe, expect, it } from "vitest";
import { deleteLegacyAgentData, exportLegacyAgentData, findLegacyAgentData, hasLegacyAgentData, LEGACY_AGENT_KEYS } from "./legacy-agent-data";
import { setStorageNamespace } from "./namespace";
import { parseProjectActivity, projectActivitySnapshot, projectEventsIn } from "@/lib/projects/activity";

/**
 * Removing the agent product must not destroy what it recorded: the records
 * stay until the person downloads or deletes them, and deleting them leaves
 * everything else alone.
 */

const ACTIVITY = "tabdump:project-activity:v1";

function seed() {
  window.localStorage.setItem("tabdump:agents:v1", JSON.stringify({ version: 1, runs: [{ id: "r1", task: "Summarise sources" }] }));
  window.localStorage.setItem("tabdump:agent-sessions:v1", "not json");
  window.localStorage.setItem("tabdump:workspaces:v1", JSON.stringify({ keep: true }));
  window.localStorage.setItem(
    ACTIVITY,
    JSON.stringify({
      version: 1,
      events: [
        { id: "e1", workspaceId: "w", kind: "task", at: 1, provider: "claude-code", task: "Summarise sources", state: "done" },
        { id: "e2", workspaceId: "w", kind: "conversation_saved", at: 2, provider: "chatgpt" },
      ],
    })
  );
}

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

describe("legacy agent data", () => {
  it("is found where the agent features kept it, including their project history entries", () => {
    expect(hasLegacyAgentData()).toBe(false);
    seed();
    const found = findLegacyAgentData();
    expect(found.keys.map((entry) => entry.key)).toEqual(["tabdump:agents:v1", "tabdump:agent-sessions:v1"]);
    expect(found.projectEvents).toBe(1);
    expect(hasLegacyAgentData(found)).toBe(true);
  });

  it("is never shown in a project's history, but survives every write until deleted", () => {
    seed();
    expect(projectEventsIn(projectActivitySnapshot(), "w").map((event) => event.kind)).toEqual(["conversation_saved"]);
  });

  it("exports as one JSON document, parsing what parses and keeping the rest as text", () => {
    seed();
    const exported = JSON.parse(exportLegacyAgentData(new Date(Date.UTC(2026, 9, 13))));
    expect(exported).toMatchObject({
      kind: "hubble-legacy-agent-data",
      exportedAt: "2026-10-13T00:00:00.000Z",
      storage: { "tabdump:agents:v1": { runs: [{ id: "r1" }] }, "tabdump:agent-sessions:v1": "not json" },
      projectHistory: [{ id: "e1", kind: "task" }],
    });
    expect(Object.keys(exported.storage).every((key) => (LEGACY_AGENT_KEYS as readonly string[]).includes(key))).toBe(true);
  });

  it("deletes only the agent records, when asked", () => {
    seed();
    expect(deleteLegacyAgentData()).toBe(3);
    expect(hasLegacyAgentData()).toBe(false);
    expect(window.localStorage.getItem("tabdump:workspaces:v1")).toBe(JSON.stringify({ keep: true }));
    expect(parseProjectActivity(projectActivitySnapshot()).map((event) => event.id)).toEqual(["e2"]);
  });

  it("touches only the signed-in account's partition", () => {
    seed();
    setStorageNamespace("user-a");
    expect(hasLegacyAgentData()).toBe(false);
    expect(deleteLegacyAgentData()).toBe(0);
    setStorageNamespace(null);
    expect(hasLegacyAgentData()).toBe(true);
  });
});
