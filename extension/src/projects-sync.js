// The extension's copy of the person's Hubble projects, kept current by the
// Hubble page itself.
//
// Hubble is local-first: the projects live in the Hubble page's own storage,
// and only that page can say what they are. Before this, the extension only
// knew them while a Hubble tab answered a live question within its timeout —
// so a project created a moment ago was missing from the popup whenever the
// Hubble tab was still loading, frozen or discarded by Chrome's Memory Saver,
// or simply not the tab that got asked.
//
// Now the page pushes a snapshot every time the list changes (and whenever it
// is opened, looked at again or reconnects to the extension): the existing
// TABDUMP_PROJECT_FOCUS report, which already carried the list, now carries a
// `revision` too. background.js keeps the newest snapshot in
// chrome.storage.local (PROJECTS_SNAPSHOT_KEY), and every extension surface
// that lists projects reads it immediately and follows
// chrome.storage.onChanged while it is open. A live answer from a Hubble tab
// is still asked for on open and always wins: the snapshot is a cache that
// makes the list right immediately, not a second source of truth.
//
// Snapshots, never deltas: a report is the whole list, so a duplicate report
// is a no-op and a missed one is repaired by the next. `revision` is when the
// reporting page last changed its list (milliseconds), so a report from a tab
// that had not caught up yet can never replace a newer one.
//
// Everything here is pure; background.js and the popup do the chrome.* calls.

import { readProjectList } from "./quick-add.js";

export const PROJECT_EVENTS = {
  CREATED: "project.created",
  UPDATED: "project.updated",
  DELETED: "project.deleted",
};

/** A report as the Hubble page sent it, re-checked: a revision, the open project's id, and ids and names only. */
export function readProjectsReport(payload) {
  const revision = Number(payload?.revision);
  if (!Number.isFinite(revision) || revision <= 0) return undefined;
  const projects = readProjectList(payload?.projects);
  const focusId = typeof payload?.focus?.id === "string" ? payload.focus.id : undefined;
  const currentId = focusId && projects.some((project) => project.id === focusId) ? focusId : undefined;
  return { revision, projects, ...(currentId ? { currentId } : {}) };
}

/** A snapshot as stored, re-checked (storage is the extension's own, but a stored value can still be from an older build). */
export function readProjectsSnapshot(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const report = readProjectsReport({ revision: raw.revision, projects: raw.projects, focus: { id: raw.currentId } });
  if (!report) return undefined;
  return { ...report, receivedAt: Number.isFinite(raw.receivedAt) ? raw.receivedAt : 0 };
}

/** What changed between two lists, as typed events naming ids only. */
export function diffProjects(before, after) {
  const previous = new Map((before ?? []).map((project) => [project.id, project]));
  const next = new Map(after.map((project) => [project.id, project]));
  const changes = [];
  for (const project of after) {
    const old = previous.get(project.id);
    if (!old) changes.push({ type: PROJECT_EVENTS.CREATED, id: project.id });
    else if (old.name !== project.name) changes.push({ type: PROJECT_EVENTS.UPDATED, id: project.id });
  }
  for (const project of before ?? []) if (!next.has(project.id)) changes.push({ type: PROJECT_EVENTS.DELETED, id: project.id });
  return changes;
}

/**
 * Applies one report to the stored snapshot.
 *
 * Returns `{ accepted: false }` for a report that is not newer than what is
 * stored — a duplicate, or a tab that had not caught up yet — and otherwise
 * `{ accepted: true, snapshot, changes }`.
 */
export function applyProjectsReport(stored, report, receivedAt) {
  if (!report) return { accepted: false, reason: "invalid" };
  if (stored && report.revision <= stored.revision) return { accepted: false, reason: report.revision === stored.revision ? "duplicate" : "stale" };
  const snapshot = { revision: report.revision, projects: report.projects, ...(report.currentId ? { currentId: report.currentId } : {}), receivedAt };
  return { accepted: true, snapshot, changes: diffProjects(stored?.projects, report.projects) };
}

/**
 * The project a picker should show selected after the list changed under it:
 * the one chosen, while it still exists; otherwise nothing, and `removed`
 * says the chosen one was deleted in Hubble (so the picker can say so instead
 * of quietly switching).
 */
export function reconcileSelection(selectedId, projects) {
  if (!selectedId) return { selectedId: "", removed: false };
  if (projects.some((project) => project.id === selectedId)) return { selectedId, removed: false };
  return { selectedId: "", removed: true };
}
