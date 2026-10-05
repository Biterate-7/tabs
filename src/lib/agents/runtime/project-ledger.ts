import { lineDiff } from "@/lib/agents/project/diff";
import { isSecretLikePath } from "@/lib/agents/project/secrets";
import { sameState } from "@/lib/agents/project/seam";
import { scrubSecretShapes } from "@/lib/secret-shapes";
import { MAX_PROJECT_CHANGE_FILES } from "@/lib/agents/control/events";
import type {
  ControlProjectChangeFile,
  ControlProjectChangeInfo,
  ControlProjectUndoAvailability,
  ControlProjectUndoInfo,
} from "@/lib/agents/control/events";
import type { ApprovalProjectFile, ProjectChangeReview, ProjectChangeReviewFile } from "@/lib/agents/project/changes";
import type { FileSnapshot, ProjectFileSystem } from "@/lib/agents/project/seam";

/**
 * What approved project writes actually changed (Hubble 1.6), kept in the
 * runtime host's memory.
 *
 * ## The order that makes a measurement honest
 *
 *   1. The person approves a write to `src/auth.ts`.
 *   2. **Before the agent is told**, the host copies `src/auth.ts` as it is
 *      (`open`). The agent is still waiting on the approval, so this copy is
 *      the file the agent had not yet touched.
 *   3. The agent writes, and reports the file (`noteFile`) — or its turn ends.
 *   4. The host reads the file again (`finalize`) and compares: created,
 *      modified, deleted or unchanged, and by how many lines. That, not the
 *      approval and not the agent's report, is the record (`project_changed`).
 *
 * ## What it keeps, and for how long
 *
 * The copies live here and nowhere else: never in an event, history, a pack
 * or a reply other than a live review. A secret-like file is never copied.
 * Memory is bounded (`maxBytes`); past it the oldest copies are released and
 * their changes can no longer be undone or reviewed — said, not hidden. A
 * runtime restart releases everything, which history then reports as a
 * change Hubble no longer holds the earlier version of.
 *
 * ## Undo is refused unless it is exact
 *
 * Every file must still be exactly as the agent left it (same SHA-256), or
 * nothing is written. Hubble never overwrites a change it did not measure.
 */

export type LedgerFile = {
  path: string;
  before: FileSnapshot;
  after?: FileSnapshot;
  /** The agent reported this file. */
  seen: boolean;
  /** Reported by the agent without having been named in the approval: Hubble never saw it before. */
  unannounced?: true;
  reportedAs?: "created" | "modified";
};

export type LedgerEntry = {
  changeId: string;
  ownerId: string;
  sessionId: string;
  projectId: string;
  root: string;
  contextId?: string;
  files: LedgerFile[];
  openedAt: number;
  status: "open" | "recorded" | "undone";
  /** The copies were released for memory; undo and review are no longer possible. */
  released?: true;
  info?: ControlProjectChangeInfo;
};

export type UndoResult = Pick<ControlProjectUndoInfo, "outcome" | "reason" | "files"> & { projectId?: string };

export type ProjectLedger = {
  /** Copies every target as it is now. Call before the approval reaches the agent. */
  open(input: {
    changeId: string;
    ownerId: string;
    sessionId: string;
    projectId: string;
    root: string;
    targets: readonly string[];
    contextId?: string;
    now: number;
  }): Promise<void>;
  /** The agent reported a file. Returns the change that is now complete, if this completed one. */
  noteFile(sessionId: string, path: string, reportedAs: "created" | "modified"): LedgerEntry | undefined;
  /** Open changes of a session — to finalize when its turn ends, or before a later write to the same file. */
  openFor(sessionId: string, paths?: readonly string[]): LedgerEntry[];
  /** Measures a change and records it. Idempotent: a recorded change is answered from its record. */
  finalize(changeId: string): Promise<ControlProjectChangeInfo | undefined>;
  get(changeId: string): LedgerEntry | undefined;
  /** The latest recorded change of a session, for what a check verifies. */
  latestRecorded(sessionId: string): LedgerEntry | undefined;
  /** What an approval card should add about each of its files. */
  annotate(sessionId: string, root: string, targets: readonly string[]): Promise<ApprovalProjectFile[]>;
  undo(ownerId: string, sessionId: string, changeId: string): Promise<UndoResult | undefined>;
  review(ownerId: string, sessionId: string, changeId: string): ProjectChangeReview | undefined;
  /** Forgets a session's changes — when the session is disposed. */
  forgetSession(sessionId: string): void;
};

export const DEFAULT_LEDGER_BYTES = 64 * 1024 * 1024;

function bytesOf(snapshot: FileSnapshot | undefined): number {
  return snapshot?.kind === "file" && snapshot.bytes ? snapshot.bytes.length : 0;
}

function textOf(snapshot: FileSnapshot): string | undefined {
  if (snapshot.kind === "absent") return "";
  if (snapshot.kind !== "file" || !snapshot.bytes || snapshot.binary) return undefined;
  return new TextDecoder("utf-8", { fatal: false }).decode(snapshot.bytes);
}

function changeKind(file: LedgerFile): ControlProjectChangeFile["change"] {
  const before = file.before;
  const after = file.after;
  if (!after) return "unchanged";
  // Hubble did not read it: the agent's own report is all there is, and it is said as that.
  if (before.kind === "sensitive" || after.kind === "sensitive" || before.kind === "unsafe" || after.kind === "unsafe" || after.kind === "unreadable") {
    return file.seen ? (file.reportedAs === "created" ? "created" : "modified") : "unchanged";
  }
  if (before.kind === "unreadable") {
    if (after.kind === "absent") return file.seen ? "deleted" : "unchanged";
    return file.seen ? (file.reportedAs === "created" ? "created" : "modified") : "unchanged";
  }
  if (before.kind === "absent" && after.kind === "absent") return "unchanged";
  if (before.kind === "absent") return "created";
  if (after.kind === "absent") return "deleted";
  return sameState(before, after) ? "unchanged" : "modified";
}

function measured(file: LedgerFile, change: ControlProjectChangeFile["change"]): ControlProjectChangeFile {
  const base: ControlProjectChangeFile = { path: file.path, change };
  if (file.before.kind === "sensitive" || isSecretLikePath(file.path)) return { ...base, sensitive: true };
  const after = file.after!;
  // The state the agent left, for telling later whether it changed outside the session.
  const out: ControlProjectChangeFile = after.kind === "file" ? { ...base, hash: after.hash.slice(0, 12) } : base;
  if (change === "unchanged") return out;
  if ((file.before.kind === "file" && file.before.binary) || (after.kind === "file" && after.binary)) return { ...out, binary: true };
  const before = textOf(file.before);
  const now = textOf(after);
  if (before === undefined || now === undefined) return out;
  const diff = lineDiff(before, now);
  return { ...out, added: diff.added, removed: diff.removed };
}

function availability(entry: LedgerEntry, changed: readonly LedgerFile[]): ControlProjectUndoAvailability {
  if (entry.released) return "no_copy";
  let result: ControlProjectUndoAvailability = "available";
  for (const file of changed) {
    const { before, after } = file;
    if (before.kind === "sensitive" || after?.kind === "sensitive") return "sensitive";
    if (before.kind === "unsafe" || after?.kind === "unsafe") result = result === "available" ? "unsafe" : result;
    else if (file.unannounced || before.kind === "unreadable" || after?.kind === "unreadable" || !after) result = result === "available" ? "no_copy" : result;
    else if ((before.kind === "file" && !before.bytes) || (after.kind === "file" && !after.bytes)) result = result === "available" ? "too_large" : result;
  }
  return result;
}

export function createProjectLedger(options: { files: ProjectFileSystem; maxBytes?: number }): ProjectLedger {
  const { files: fs } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_LEDGER_BYTES;
  const entries = new Map<string, LedgerEntry>();
  /** Insertion order is age: the oldest copies are released first. */
  let held = 0;

  function account(): void {
    held = 0;
    for (const entry of entries.values()) {
      if (entry.released) continue;
      for (const file of entry.files) held += bytesOf(file.before) + bytesOf(file.after);
    }
    for (const entry of entries.values()) {
      if (held <= maxBytes) break;
      if (entry.released || entry.status === "open") continue;
      for (const file of entry.files) {
        held -= bytesOf(file.before) + bytesOf(file.after);
        if (file.before.kind === "file") delete file.before.bytes;
        if (file.after?.kind === "file") delete file.after.bytes;
      }
      entry.released = true;
    }
  }

  const ledger: ProjectLedger = {
    async open(input) {
      if (entries.has(input.changeId)) return;
      const files: LedgerFile[] = [];
      const seen = new Set<string>();
      for (const path of input.targets) {
        if (seen.has(path) || files.length >= MAX_PROJECT_CHANGE_FILES) continue;
        seen.add(path);
        files.push({ path, before: await fs.snapshot(input.root, path), seen: false });
      }
      entries.set(input.changeId, {
        changeId: input.changeId,
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        root: input.root,
        ...(input.contextId ? { contextId: input.contextId } : {}),
        files,
        openedAt: input.now,
        status: "open",
      });
      account();
    },

    noteFile(sessionId, path, reportedAs) {
      const open = [...entries.values()].filter((entry) => entry.sessionId === sessionId && entry.status === "open");
      // The most recent change that named this file; else the most recent that named none.
      const named = open.filter((entry) => entry.files.some((file) => file.path === path)).pop();
      const target = named ?? open.filter((entry) => entry.files.every((file) => file.unannounced)).pop() ?? open.pop();
      if (!target) return undefined;
      let file = target.files.find((candidate) => candidate.path === path);
      if (!file) {
        if (target.files.length >= MAX_PROJECT_CHANGE_FILES) return undefined;
        file = { path, before: { kind: "unreadable" }, seen: false, unannounced: true };
        target.files.push(file);
      }
      file.seen = true;
      file.reportedAs = reportedAs;
      return target.files.every((candidate) => candidate.seen) ? target : undefined;
    },

    openFor(sessionId, paths) {
      return [...entries.values()].filter(
        (entry) =>
          entry.sessionId === sessionId &&
          entry.status === "open" &&
          (!paths || entry.files.some((file) => paths.includes(file.path)))
      );
    },

    async finalize(changeId) {
      const entry = entries.get(changeId);
      if (!entry) return undefined;
      if (entry.status !== "open") return entry.info;
      // Marked first, so a second trigger while this one reads the disk answers from the record.
      entry.status = "recorded";
      for (const file of entry.files) file.after = await fs.snapshot(entry.root, file.path);
      // A target that never existed, never appeared and was never reported is not a file at all:
      // an agent that names no location is approved under its tool's label ("Edit"). Not counted.
      entry.files = entry.files.filter(
        (file) => !(file.before.kind === "absent" && file.after?.kind === "absent" && !file.seen && !/[./]/.test(file.path))
      );

      const kinds = entry.files.map((file) => changeKind(file));
      const changed = entry.files.filter((_, index) => kinds[index] !== "unchanged");
      const outcome: ControlProjectChangeInfo["outcome"] =
        changed.length === 0 ? "not_applied" : changed.length === entry.files.length ? "applied" : "partial";
      const info: ControlProjectChangeInfo = {
        changeId: entry.changeId,
        projectId: entry.projectId,
        outcome,
        files: entry.files.map((file, index) => measured(file, kinds[index]!)),
        undo: changed.length === 0 ? "no_copy" : availability(entry, changed),
        ...(entry.contextId ? { contextId: entry.contextId } : {}),
      };
      entry.info = info;
      account();
      return info;
    },

    get: (changeId) => entries.get(changeId),

    latestRecorded(sessionId) {
      return [...entries.values()].filter((entry) => entry.sessionId === sessionId && entry.status !== "open" && entry.info?.outcome !== "not_applied").pop();
    },

    async annotate(sessionId, root, targets) {
      const out: ApprovalProjectFile[] = [];
      for (const path of targets.slice(0, MAX_PROJECT_CHANGE_FILES)) {
        if (isSecretLikePath(path)) {
          out.push({ path, sensitive: true });
          continue;
        }
        // The state this session last left it in, if it changed it before.
        const last = [...entries.values()]
          .filter((entry) => entry.sessionId === sessionId && entry.status !== "open")
          .flatMap((entry) => entry.files.filter((file) => file.path === path && file.after))
          .pop();
        if (last?.after && (last.after.kind === "file" || last.after.kind === "absent")) {
          const now = await fs.snapshot(root, path);
          if ((now.kind === "file" || now.kind === "absent") && !sameState(now, last.after)) {
            out.push({ path, changedOutside: true });
            continue;
          }
        }
        out.push({ path });
      }
      return out;
    },

    async undo(ownerId, sessionId, changeId) {
      const entry = entries.get(changeId);
      if (!entry || entry.ownerId !== ownerId || entry.sessionId !== sessionId) return undefined;
      const base = { projectId: entry.projectId };
      if (entry.status === "open") return { ...base, outcome: "refused", reason: "unavailable", files: 0 };
      if (entry.status === "undone") return { ...base, outcome: "refused", reason: "unavailable", files: 0 };
      const info = entry.info;
      if (!info || info.outcome === "not_applied") return { ...base, outcome: "refused", reason: "unavailable", files: 0 };
      const changed = entry.files.filter((file) => changeKind(file) !== "unchanged");
      const available = availability(entry, changed);
      if (available !== "available") {
        return { ...base, outcome: "refused", reason: available === "sensitive" ? "sensitive" : available === "unsafe" ? "unavailable" : "no_copy", files: 0 };
      }
      if ((await fs.access(entry.root)) !== "ready") return { ...base, outcome: "refused", reason: "unavailable", files: 0 };

      // Every file first, exactly as the agent left it — or nothing is written.
      for (const file of changed) {
        const current = await fs.snapshot(entry.root, file.path);
        if (!sameState(current, file.after!)) return { ...base, outcome: "refused", reason: "changed", files: 0 };
      }
      let restored = 0;
      let stopped: UndoResult["reason"];
      for (const file of changed) {
        const result = await fs.restore(entry.root, file.path, file.before, file.after!);
        if (result === "restored") restored += 1;
        else stopped ??= result === "changed" ? "changed" : "unavailable";
      }
      entry.status = "undone";
      if (restored === changed.length) return { ...base, outcome: "undone", files: restored };
      return { ...base, outcome: restored === 0 ? "refused" : "partial", reason: stopped ?? "unavailable", files: restored };
    },

    review(ownerId, sessionId, changeId) {
      const entry = entries.get(changeId);
      if (!entry || entry.ownerId !== ownerId || entry.sessionId !== sessionId || entry.status === "open") return undefined;
      const files: ProjectChangeReviewFile[] = entry.files.map((file) => {
        const change = changeKind(file);
        const base: ProjectChangeReviewFile = { path: file.path, change };
        if (file.before.kind === "sensitive" || isSecretLikePath(file.path)) return { ...base, note: "sensitive" };
        if (change === "unchanged") return { ...base, note: "unchanged" };
        if (entry.released || file.unannounced || file.before.kind === "unreadable" || file.before.kind === "unsafe") return { ...base, note: "no_copy" };
        const after = file.after!;
        if ((file.before.kind === "file" && file.before.binary) || (after.kind === "file" && after.binary)) return { ...base, note: "binary" };
        const before = textOf(file.before);
        const now = textOf(after);
        if (before === undefined || now === undefined) return { ...base, note: "too_large" };
        const diff = lineDiff(before, now, { hunks: true });
        return {
          ...base,
          added: diff.added,
          removed: diff.removed,
          // Shown to the person on their own machine, and still scrubbed of anything shaped like a credential.
          ...(diff.hunks ? { hunks: diff.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => ({ ...line, text: scrubSecretShapes(line.text) })) })) } : { note: "too_large" as const }),
          ...(diff.truncated ? { truncated: true } : {}),
        };
      });
      return { changeId, files };
    },

    forgetSession(sessionId) {
      for (const [id, entry] of entries) if (entry.sessionId === sessionId) entries.delete(id);
      account();
    },
  };
  return ledger;
}
