import type { DiffHunk } from "./diff";
import type {
  ControlProjectChangeFile,
  ControlProjectChangeInfo,
  ControlProjectUndoAvailability,
  ControlProjectUndoInfo,
} from "@/lib/agents/control/events";

/**
 * Project changes as people read them (Hubble 1.6): what a measured change
 * did, why it can or cannot be undone, and what a review shows.
 *
 * Every sentence here is the one sentence for its case, used by the approval
 * card, the timeline, the Action Inspector, history and the landing demo.
 */

/** One file of a change, as `review_project_change` shows it — the only place file text ever appears. */
export type ProjectChangeReviewFile = {
  path: string;
  change: ControlProjectChangeFile["change"];
  added?: number;
  removed?: number;
  /** The changed lines with context. Absent with `note` when Hubble cannot show them. */
  hunks?: readonly DiffHunk[];
  truncated?: boolean;
  note?: "sensitive" | "binary" | "too_large" | "no_copy" | "unchanged";
};

/** A review of one measured change. Live only: the runtime holds the copies, history never does. */
export type ProjectChangeReview = {
  changeId: string;
  files: readonly ProjectChangeReviewFile[];
};

/** What an approval card adds about each file it names (computed by the runtime, before you answer). */
export type ApprovalProjectFile = {
  path: string;
  /** Secret-like: Hubble will not read it, so it cannot measure or undo a change to it. */
  sensitive?: true;
  /** Changed since this session last saw it — by someone or something other than this agent. */
  changedOutside?: true;
};

export const REVIEW_NOTE_TEXT: Record<NonNullable<ProjectChangeReviewFile["note"]>, string> = {
  sensitive: "This file may hold secrets, so Hubble doesn't read it.",
  binary: "Binary file — no line changes to show.",
  too_large: "Too large for Hubble to show.",
  no_copy: "Hubble didn't see this file before it changed, so it can't show what changed.",
  unchanged: "No change was made to this file.",
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "+34 −12", or nothing when Hubble could not count. */
export function lineCountsText(file: { added?: number; removed?: number }): string | undefined {
  if (file.added === undefined && file.removed === undefined) return undefined;
  return `+${file.added ?? 0} −${file.removed ?? 0}`;
}

/** The totals across a change's files that Hubble could count. */
export function changeTotals(files: readonly ControlProjectChangeFile[]): { added: number; removed: number; counted: boolean } {
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const file of files) {
    if (file.added !== undefined || file.removed !== undefined) counted = true;
    added += file.added ?? 0;
    removed += file.removed ?? 0;
  }
  return { added, removed, counted };
}

/** Files that actually changed. */
export function changedFiles(info: Pick<ControlProjectChangeInfo, "files">): ControlProjectChangeFile[] {
  return info.files.filter((file) => file.change !== "unchanged");
}

/** "Changed 2 files", "Created src/lib/session.ts", "No files were changed". */
export function projectChangeTitle(info: Pick<ControlProjectChangeInfo, "files" | "outcome">): string {
  const files = changedFiles(info);
  if (info.outcome === "not_applied" || files.length === 0) return "No files were changed";
  if (files.length === 1) {
    const [file] = files;
    const verb = file!.change === "created" ? "Created" : file!.change === "deleted" ? "Deleted" : "Changed";
    return `${verb} ${file!.path}`;
  }
  return `Changed ${plural(files.length, "file", "files")}`;
}

/** The line under it: "+34 −12 · 2 files", "Only 1 of 2 files changed". */
export function projectChangeDetail(info: Pick<ControlProjectChangeInfo, "files" | "outcome">): string | undefined {
  const files = changedFiles(info);
  const totals = changeTotals(files);
  const parts: string[] = [];
  if (totals.counted) parts.push(`+${totals.added} −${totals.removed}`);
  if (info.outcome === "partial") parts.push(`Only ${files.length} of ${plural(info.files.length, "file", "files")} changed`);
  if (info.outcome === "not_applied") parts.push("The approved change wasn't made");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** The result sentence for an applied project change. */
export function projectChangeResult(info: Pick<ControlProjectChangeInfo, "files" | "outcome">, projectName?: string): { tone: "success" | "warning" | "failure"; text: string } {
  const files = changedFiles(info);
  const where = projectName ? ` in ${projectName}` : "";
  if (info.outcome === "not_applied" || files.length === 0) return { tone: "failure", text: `The approved change wasn't made — no file${where} changed.` };
  if (info.outcome === "partial") {
    return { tone: "warning", text: `Partly applied: ${files.length} of ${plural(info.files.length, "file", "files")}${where} changed. Check the rest before continuing.` };
  }
  return { tone: "success", text: `Applied — Hubble confirmed ${plural(files.length, "file", "files")} changed${where}.` };
}

/** Why a recorded change cannot be undone, in the one sentence used everywhere. */
export const PROJECT_UNDO_UNAVAILABLE: Record<Exclude<ControlProjectUndoAvailability, "available">, string> = {
  no_copy: "This change can't be undone because Hubble didn't keep the earlier version of these files.",
  sensitive: "This change can't be undone because it touched a file that may hold secrets, which Hubble never copies.",
  too_large: "This change can't be undone because a file was too large for Hubble to keep a copy of.",
  unsafe: "This change can't be undone because a file is a link or lies outside the project folder.",
};

/** Refusals at the moment of undoing. */
export const UNDO_REFUSED_PROJECT_CHANGED = "This change can't be undone because the project has changed since it was made.";
export const UNDO_REFUSED_NO_COPY = "This change can't be undone because Hubble no longer holds the earlier version of these files.";
export const UNDO_REFUSED_UNAVAILABLE = "Hubble can't reach this project right now, so nothing was undone.";
export const UNDO_PARTIAL = "Only some files could be put back. Check the project before continuing.";

export function undoRefusalText(reason: ControlProjectUndoInfo["reason"]): string {
  switch (reason) {
    case "changed":
      return UNDO_REFUSED_PROJECT_CHANGED;
    case "no_copy":
      return UNDO_REFUSED_NO_COPY;
    case "sensitive":
      return PROJECT_UNDO_UNAVAILABLE.sensitive;
    default:
      return UNDO_REFUSED_UNAVAILABLE;
  }
}

/** "Undid changes to 2 files", or why not. */
export function projectUndoTitle(info: ControlProjectUndoInfo): string {
  if (info.outcome === "undone") return `Undid changes to ${plural(info.files, "file", "files")}`;
  if (info.outcome === "partial") return `Undid changes to ${plural(info.files, "file", "files")} — not all`;
  return "Undo refused";
}

/** Whether a check is running in this stream (Hubble 1.6): one started and not yet finished. */
export function checkRunningIn(events: readonly { kind: string; verification?: { checkId: string } }[]): boolean {
  const open = new Set<string>();
  for (const event of events) {
    if (!event.verification) continue;
    if (event.kind === "verification_started") open.add(event.verification.checkId);
    else open.delete(event.verification.checkId);
  }
  return open.size > 0;
}

/** The latest Git status counts a stream carries, if any. */
export function latestGitCountsIn<T>(events: readonly { verification?: { git?: T } }[]): T | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const counts = events[index]!.verification?.git;
    if (counts) return counts;
  }
  return undefined;
}
