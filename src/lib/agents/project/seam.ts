import type { GitStatusCounts, ProjectCheckId } from "./checks";
import type { ProjectAccessState, ProjectInspection } from "./inspection";

/**
 * The shape of the local machine's project access (Hubble 1.6), as the
 * runtime host sees it. Types only: the host is pure and runs in tests with
 * nothing behind it; the one implementation is server-only
 * (lib/agents/project-host/), supplied by the local and desktop runtime
 * wiring and by nobody else. A host without it — remote, hosted, refused —
 * cannot read, measure, undo or check anything, and says so.
 */

export type FileSnapshot =
  | { kind: "absent" }
  | {
      kind: "file";
      /** Full SHA-256 of the contents, hex. */
      hash: string;
      size: number;
      binary: boolean;
      /** The contents, when small enough to keep. Held in the runtime's memory only, never sent or stored. */
      bytes?: Uint8Array;
    }
  /** Secret-like: never read. */
  | { kind: "sensitive" }
  /** A link, a directory, or a path whose real location is outside the project. */
  | { kind: "unsafe" }
  | { kind: "unreadable" };

export type RestoreOutcome = "restored" | "changed" | "unsafe" | "failed";

export type ProjectFileSystem = {
  access(root: string): Promise<ProjectAccessState>;
  inspect(root: string, files: readonly string[]): Promise<Omit<ProjectInspection, "projectId" | "inspectedAt">>;
  snapshot(root: string, relativePath: string): Promise<FileSnapshot>;
  /**
   * Writes `previous` back over the file — or removes it, when `previous` is
   * `absent` — only if the file is still exactly `expected`. Never otherwise.
   */
  restore(root: string, relativePath: string, previous: FileSnapshot, expected: FileSnapshot): Promise<RestoreOutcome>;
};

export type CheckRunResult = {
  outcome: "passed" | "failed" | "timed_out" | "unavailable" | "error";
  exitCode?: number;
  durationMs: number;
  git?: GitStatusCounts;
};

export type ProjectCheckRunner = {
  run(root: string, check: ProjectCheckId, options?: { timeoutMs?: number }): Promise<CheckRunResult>;
};

/** What a local runtime is given to work on projects. */
export type ProjectHost = { files: ProjectFileSystem; checks: ProjectCheckRunner };

/** Whether two snapshots describe the same state of a file. */
export function sameState(a: FileSnapshot, b: FileSnapshot): boolean {
  if (a.kind === "absent" && b.kind === "absent") return true;
  if (a.kind === "file" && b.kind === "file") return a.hash === b.hash;
  return false;
}
