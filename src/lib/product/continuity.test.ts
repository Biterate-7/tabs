import { describe, expect, it } from "vitest";
import { AWAY_MS, changesSince, greetingFor, previousVisit, projectPulses } from "./continuity";
import { connectedProjects } from "@/lib/knowledge-graph/related";
import type { ProjectEvent } from "@/lib/projects/activity";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

const NOW = new Date(2026, 9, 20, 15, 0).getTime();
const H = 3600_000;

function source(id: string, url: string, addedAt: number, updatedAt = addedAt): Tab {
  return { id, url, normalizedUrl: url, domain: new URL(url).hostname, title: id, resource: { kind: "webpage", origin: "manual", status: "ready", addedAt, updatedAt, content: { chars: 1, extractedAt: updatedAt } } };
}
function project(id: string, tabs: Tab[], createdAt = NOW - 100 * H): Workspace {
  return { id, name: id, tabs, createdAt, updatedAt: NOW };
}
const event = (workspaceId: string, kind: ProjectEvent["kind"], at: number): ProjectEvent => ({ id: `${workspaceId}-${kind}-${at}`, workspaceId, kind, at });

describe("projectPulses", () => {
  it("orders projects by what the person last did there, not by Hubble's background reads", () => {
    // "old" had a source re-read a minute ago; "fresh" had something added an hour ago.
    const old = project("old", [source("a", "https://a.example/", NOW - 50 * H, NOW - 60_000)]);
    const fresh = project("fresh", [source("b", "https://b.example/", NOW - H)]);
    const pulses = projectPulses({ workspaces: [old, fresh], sessions: [], events: [event("old", "source_ready", NOW - 60_000)] });
    expect(pulses.map((pulse) => pulse.workspace.id)).toEqual(["fresh", "old"]);
    expect(pulses[1]!.lastAt).toBe(NOW - 50 * H);
  });

  it("counts a saved conversation, a session and a note as activity", () => {
    const a = project("a", []);
    const b = project("b", []);
    const pulses = projectPulses({
      workspaces: [a, b],
      sessions: [{ id: "s", name: "S", tabs: [{ id: "t", url: "https://x.example/", title: "" }], createdAt: NOW - 3 * H, updatedAt: NOW - 3 * H, lastRestoredAt: NOW - 2 * H, revision: 1, workspaceId: "b" }],
      events: [event("a", "conversation_saved", NOW - 5 * H)],
    });
    expect(pulses[0]!.workspace.id).toBe("b");
    expect(pulses[0]!.session?.id).toBe("s");
    expect(pulses[1]!.lastAt).toBe(NOW - 5 * H);
  });

  it("lists items that could not be read as needing attention", () => {
    const tab = source("x", "https://x.example/", NOW - H);
    tab.resource!.status = "failed";
    const [pulse] = projectPulses({ workspaces: [project("p", [tab])], sessions: [], events: [] });
    expect(pulse!.attention.map((item) => item.id)).toEqual(["x"]);
  });
});

describe("previousVisit and changesSince", () => {
  it("starts 'since' at the last visit that was long enough ago to have been away", () => {
    const records = [
      { kind: "workspace_revisited" as const, at: NOW - 30 * H },
      { kind: "workspace_revisited" as const, at: NOW - 10_000 },
    ];
    expect(previousVisit(records, NOW)).toBe(NOW - 30 * H);
    expect(previousVisit([{ kind: "workspace_revisited", at: NOW - 10_000 }], NOW)).toBeUndefined();
    expect(previousVisit([], NOW)).toBeUndefined();
    expect(AWAY_MS).toBeGreaterThan(0);
  });

  it("reports only what arrived after that", () => {
    const pulses = projectPulses({ workspaces: [project("p", [source("new", "https://n.example/", NOW - H), source("old", "https://o.example/", NOW - 40 * H)])], sessions: [], events: [] });
    expect(changesSince(pulses, NOW - 30 * H).items.map((entry) => entry.item.id)).toEqual(["new"]);
  });
});

describe("greetingFor", () => {
  it("knows the hour and nothing else", () => {
    expect(greetingFor(new Date(2026, 0, 1, 9).getTime())).toBe("Good morning");
    expect(greetingFor(new Date(2026, 0, 1, 14).getTime())).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 0, 1, 20).getTime())).toBe("Good evening");
    expect(greetingFor(new Date(2026, 0, 1, 2).getTime())).toBe("Working late");
  });
});

describe("connectedProjects", () => {
  it("counts sources shared with other projects, ignoring tracking parameters, strongest first", () => {
    const a = project("a", [source("1", "https://p.example/x", NOW), source("2", "https://p.example/y", NOW)]);
    const b = project("b", [source("3", "https://p.example/x?utm_source=z", NOW)]);
    const c = project("c", [source("4", "https://p.example/x", NOW), source("5", "https://p.example/y", NOW)]);
    const d = project("d", [source("6", "https://other.example/", NOW)]);
    expect(connectedProjects([a, b, c, d], "a").map((entry) => [entry.workspace.id, entry.shared])).toEqual([
      ["c", 2],
      ["b", 1],
    ]);
  });
});
