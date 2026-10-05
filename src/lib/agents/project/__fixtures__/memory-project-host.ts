import { createHash } from "node:crypto";
import { checksFromProject } from "../checks";
import { detectProjectType } from "../inspection";
import { isSecretLikePath } from "../secrets";
import { sameState } from "../seam";
import type { ProjectCheckId } from "../checks";
import type { ProjectInspection } from "../inspection";
import type { CheckRunResult, FileSnapshot, ProjectHost } from "../seam";

/**
 * An in-memory project host for tests (Hubble 1.6): folders are maps of
 * project-relative path → text, and the same rules as the real seam apply —
 * secret-like paths are never read, links are unsafe, restore writes only
 * over exactly the expected state.
 */
export type MemoryProject = {
  files: Map<string, string>;
  links?: Set<string>;
  manifest?: unknown;
  git?: { branch: string; head: string };
  state?: ProjectInspection["state"];
};

export type MemoryProjectHost = ProjectHost & {
  projects: Map<string, MemoryProject>;
  /** Writes as an agent (or a person) would — outside Hubble. */
  write(root: string, path: string, text: string | null): void;
  checkRuns: { root: string; check: ProjectCheckId }[];
  /** What each check answers. Default: passed. */
  checkResults: Partial<Record<ProjectCheckId, CheckRunResult>>;
  /** Resolve pending checks only when told, to observe "running". */
  holdChecks?: boolean;
  releaseChecks(): void;
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function createMemoryProjectHost(initial: Record<string, Omit<Partial<MemoryProject>, "files"> & { files?: Record<string, string> }> = {}): MemoryProjectHost {
  const projects = new Map<string, MemoryProject>();
  for (const [root, project] of Object.entries(initial)) {
    projects.set(root, {
      files: new Map(Object.entries(project.files ?? {})),
      ...(project.links ? { links: project.links } : {}),
      ...(project.manifest !== undefined ? { manifest: project.manifest } : {}),
      ...(project.git ? { git: project.git } : {}),
      ...(project.state ? { state: project.state } : {}),
    });
  }
  const held: (() => void)[] = [];

  function snapshot(root: string, path: string): FileSnapshot {
    const project = projects.get(root);
    if (!project) return { kind: "unreadable" };
    if (path.split("/").includes("..") || path.startsWith("/")) return { kind: "unsafe" };
    if (isSecretLikePath(path)) return { kind: "sensitive" };
    if (project.links?.has(path)) return { kind: "unsafe" };
    const text = project.files.get(path);
    if (text === undefined) return { kind: "absent" };
    const bytes = new TextEncoder().encode(text);
    return { kind: "file", hash: hash(text), size: bytes.length, binary: text.includes("\0"), bytes };
  }

  const host: MemoryProjectHost = {
    projects,
    checkRuns: [],
    checkResults: {},
    write(root, path, text) {
      const project = projects.get(root)!;
      if (text === null) project.files.delete(path);
      else project.files.set(path, text);
    },
    releaseChecks() {
      for (const release of held.splice(0)) release();
    },
    files: {
      async access(root) {
        const project = projects.get(root);
        return project ? (project.state ?? "ready") : "missing";
      },
      async inspect(root, files) {
        const project = projects.get(root);
        const state = project ? (project.state ?? "ready") : "missing";
        if (!project || state !== "ready") return { state, checks: [], files: [] };
        const markers = new Set<string>(project.manifest !== undefined ? ["package.json"] : []);
        const type = detectProjectType({ ...(project.manifest !== undefined ? { manifest: project.manifest } : {}), markers });
        return {
          state,
          ...(type ? { type } : {}),
          ...(project.git ? { repository: { kind: "git" as const, branch: project.git.branch, head: project.git.head } } : {}),
          checks: checksFromProject({ ...(project.manifest !== undefined ? { manifest: project.manifest } : {}), git: Boolean(project.git) }),
          files: files.map((path) => {
            const found = snapshot(root, path);
            if (found.kind === "file") return { path, state: "present" as const, hash: found.hash.slice(0, 12) };
            if (found.kind === "absent") return { path, state: "missing" as const };
            if (found.kind === "sensitive") return { path, state: "sensitive" as const };
            return { path, state: "unreadable" as const };
          }),
        };
      },
      async snapshot(root, path) {
        return snapshot(root, path);
      },
      async restore(root, path, previous, expected) {
        const current = snapshot(root, path);
        if (current.kind === "unsafe" || current.kind === "sensitive") return "unsafe";
        if (!sameState(current, expected)) return "changed";
        if (previous.kind === "absent") {
          projects.get(root)!.files.delete(path);
          return "restored";
        }
        if (previous.kind !== "file" || !previous.bytes) return "failed";
        projects.get(root)!.files.set(path, new TextDecoder().decode(previous.bytes));
        return "restored";
      },
    },
    checks: {
      run(root, check) {
        host.checkRuns.push({ root, check });
        const result = (): CheckRunResult => host.checkResults[check] ?? { outcome: "passed", exitCode: 0, durationMs: 1200 };
        if (!host.holdChecks) return Promise.resolve(result());
        return new Promise((resolve) => held.push(() => resolve(result())));
      },
    },
  };
  return host;
}
