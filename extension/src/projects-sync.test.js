// The extension's copy of the person's projects: what a Hubble page report is
// allowed to change, in which order, and what a picker does when the project
// it shows is renamed or deleted in Hubble.
import { describe, expect, it } from "vitest";
import { PROJECT_EVENTS, applyProjectsReport, diffProjects, readProjectsReport, readProjectsSnapshot, reconcileSelection } from "./projects-sync.js";

const HISTORY = { id: "ws-history", name: "History IA" };
const PHYSICS = { id: "ws-physics", name: "Physics EE" };

describe("readProjectsReport", () => {
  it("keeps a revision, ids and names, and the open project only when it is one of them", () => {
    expect(readProjectsReport({ revision: 10, focus: { id: "ws-history" }, projects: [HISTORY, { id: 3 }, { ...PHYSICS, sources: 4, secret: "x" }] })).toEqual({
      revision: 10,
      currentId: "ws-history",
      projects: [HISTORY, PHYSICS],
    });
    expect(readProjectsReport({ revision: 10, focus: { id: "elsewhere" }, projects: [HISTORY] })).toEqual({ revision: 10, projects: [HISTORY] });
  });

  it("refuses a report with no usable revision (an older page): it can't be ordered", () => {
    for (const revision of [undefined, 0, -1, "soon", Number.NaN]) expect(readProjectsReport({ revision, projects: [HISTORY] })).toBeUndefined();
  });

  it("re-reads a stored snapshot the same way", () => {
    expect(readProjectsSnapshot({ revision: 5, projects: [HISTORY], currentId: "ws-history", receivedAt: 9 })).toEqual({ revision: 5, projects: [HISTORY], currentId: "ws-history", receivedAt: 9 });
    expect(readProjectsSnapshot({ projects: [HISTORY] })).toBeUndefined();
    expect(readProjectsSnapshot("nope")).toBeUndefined();
  });
});

describe("applyProjectsReport", () => {
  it("takes a newer report and says what changed: a project made, renamed and deleted", () => {
    const stored = { revision: 1, projects: [HISTORY, PHYSICS], receivedAt: 1 };
    const report = { revision: 2, projects: [{ ...HISTORY, name: "History IA (final)" }, { id: "ws-bio", name: "Biology" }] };
    const applied = applyProjectsReport(stored, report, 50);
    expect(applied.accepted).toBe(true);
    expect(applied.snapshot).toEqual({ revision: 2, projects: report.projects, receivedAt: 50 });
    expect(applied.changes).toEqual([
      { type: PROJECT_EVENTS.UPDATED, id: "ws-history" },
      { type: PROJECT_EVENTS.CREATED, id: "ws-bio" },
      { type: PROJECT_EVENTS.DELETED, id: "ws-physics" },
    ]);
  });

  it("takes the first report there is", () => {
    expect(applyProjectsReport(undefined, { revision: 1, projects: [HISTORY] }, 5)).toMatchObject({ accepted: true, changes: [{ type: PROJECT_EVENTS.CREATED, id: "ws-history" }] });
  });

  it("ignores a duplicate, and a report from a tab that had not caught up yet", () => {
    const stored = { revision: 7, projects: [HISTORY, PHYSICS], receivedAt: 1 };
    expect(applyProjectsReport(stored, { revision: 7, projects: [HISTORY, PHYSICS] }, 2)).toEqual({ accepted: false, reason: "duplicate" });
    // Older: it would bring back a deleted project or drop a new one.
    expect(applyProjectsReport(stored, { revision: 3, projects: [HISTORY] }, 2)).toEqual({ accepted: false, reason: "stale" });
  });

  it("reports nothing changed for a newer report of the same list", () => {
    expect(applyProjectsReport({ revision: 1, projects: [HISTORY] }, { revision: 2, projects: [HISTORY] }, 3).changes).toEqual([]);
    expect(diffProjects([HISTORY], [HISTORY])).toEqual([]);
  });
});

describe("reconcileSelection", () => {
  it("keeps the chosen project while it exists — renamed or not", () => {
    expect(reconcileSelection("ws-history", [{ ...HISTORY, name: "Renamed" }])).toEqual({ selectedId: "ws-history", removed: false });
  });

  it("clears a project deleted in Hubble and says it was removed, rather than quietly choosing another", () => {
    expect(reconcileSelection("ws-physics", [HISTORY])).toEqual({ selectedId: "", removed: true });
    expect(reconcileSelection("", [HISTORY])).toEqual({ selectedId: "", removed: false });
  });
});
