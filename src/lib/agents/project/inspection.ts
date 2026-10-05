import { isProjectCheckId } from "./checks";
import { isSecretLikePath } from "./secrets";
import type { ProjectCheck } from "./checks";

/**
 * What the runtime found when it looked at a project (Hubble 1.6).
 *
 * Produced by the local runtime's filesystem seam (./files-node.ts) and read
 * strictly here, because it crosses the runtime protocol. Nothing in it is a
 * path, a file's contents, an environment variable or a command's output:
 * whether the folder is reachable, what kind of project it is, the Git branch
 * and commit Hubble read from `.git/HEAD`, the checks it offers, and — for the
 * files a context names — whether each is still there and a short hash of it.
 */

/** Whether the project's folder can be reached, as the runtime last found it. */
export type ProjectAccessState =
  | "ready"
  /** Nothing is at the authorized path any more: moved, renamed or deleted. */
  | "missing"
  /** Something is there, and the runtime is not allowed to read it. */
  | "permission_denied"
  /** The path names a file, not a folder. */
  | "not_a_directory"
  /** Anything else that stopped the runtime reading it. */
  | "unavailable";

export const PROJECT_ACCESS_STATES: readonly ProjectAccessState[] = [
  "ready",
  "missing",
  "permission_denied",
  "not_a_directory",
  "unavailable",
] as const;

export type ProjectTypeId = "nextjs" | "react" | "vite" | "node" | "tauri" | "rust" | "python" | "go";

export const PROJECT_TYPE_LABELS: Record<ProjectTypeId, string> = {
  nextjs: "Next.js",
  react: "React",
  vite: "Vite",
  node: "Node.js",
  tauri: "Tauri",
  rust: "Rust",
  python: "Python",
  go: "Go",
};

export type ProjectRepository = {
  kind: "git";
  /** The checked-out branch, when `HEAD` names one. */
  branch?: string;
  /** The commit `HEAD` resolves to, abbreviated to 12 characters. */
  head?: string;
  /** `HEAD` names a commit rather than a branch. */
  detached?: boolean;
};

/** A file a context names, as it is now. Never its contents. */
export type ProjectFileState = {
  path: string;
  state: "present" | "missing" | "sensitive" | "unreadable";
  /** 12 hex characters of the content's SHA-256 — equality, nothing more. Absent unless `present`. */
  hash?: string;
};

export type ProjectInspection = {
  projectId: string;
  state: ProjectAccessState;
  type?: ProjectTypeId;
  repository?: ProjectRepository;
  checks: readonly ProjectCheck[];
  files: readonly ProjectFileState[];
  inspectedAt: number;
};

export const MAX_INSPECTED_FILES = 20;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,100}$/;
const HEAD_PATTERN = /^[0-9a-f]{7,40}$/;
const HASH_PATTERN = /^[0-9a-f]{12}$/;

/* ------------------------------------------------------------------ *
 * Detection — pure, so it is tested without a filesystem
 * ------------------------------------------------------------------ */

function dependsOn(manifest: unknown, name: string): boolean {
  if (!manifest || typeof manifest !== "object") return false;
  const record = manifest as Record<string, unknown>;
  return ["dependencies", "devDependencies", "peerDependencies"].some((key) => {
    const deps = record[key];
    return Boolean(deps && typeof deps === "object" && name in (deps as Record<string, unknown>));
  });
}

/**
 * The project's kind, from its marker files only. The most specific match
 * wins; nothing is guessed from file names inside the source tree.
 */
export function detectProjectType(input: { manifest?: unknown; markers: ReadonlySet<string> }): ProjectTypeId | undefined {
  const { manifest, markers } = input;
  if (manifest !== undefined) {
    if (dependsOn(manifest, "next")) return "nextjs";
    // By its config file alone: the desktop shell's package is named in exactly one shipped module (no-tauri-in-web.test).
    if (markers.has("src-tauri/tauri.conf.json")) return "tauri";
    if (dependsOn(manifest, "vite")) return "vite";
    if (dependsOn(manifest, "react")) return "react";
    return "node";
  }
  if (markers.has("Cargo.toml")) return "rust";
  if (markers.has("pyproject.toml") || markers.has("requirements.txt") || markers.has("setup.py")) return "python";
  if (markers.has("go.mod")) return "go";
  return undefined;
}

/** The marker files `detectProjectType` reads, relative to the project root. */
export const PROJECT_MARKER_FILES: readonly string[] = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "go.mod",
];

/** A `.git` *file* (a worktree or submodule) names its real Git directory. */
export function parseGitDirPointer(text: string): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  return match?.[1];
}

/** What `.git/HEAD` says: a branch ref, or a detached commit. */
export function parseGitHead(text: string): { branch?: string; ref?: string; head?: string; detached?: boolean } | undefined {
  const line = text.split(/\r?\n/)[0]?.trim() ?? "";
  const ref = /^ref:\s*(refs\/heads\/(.+))$/.exec(line);
  if (ref) {
    const branch = ref[2]!;
    if (!BRANCH_PATTERN.test(branch) || branch.includes("..")) return undefined;
    return { branch, ref: ref[1]! };
  }
  if (/^[0-9a-f]{40}$/.test(line)) return { head: line.slice(0, 12), detached: true };
  return undefined;
}

/** A ref's commit from `packed-refs`, when it has no loose file. */
export function commitFromPackedRefs(text: string, ref: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40}) (.+)$/.exec(line.trim());
    if (match && match[2] === ref) return match[1]!.slice(0, 12);
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Reading one back
 * ------------------------------------------------------------------ */

function readRepository(value: unknown): ProjectRepository | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "git") return undefined;
  const out: ProjectRepository = { kind: "git" };
  if (typeof record.branch === "string" && BRANCH_PATTERN.test(record.branch) && !record.branch.includes("..")) out.branch = record.branch;
  if (typeof record.head === "string" && HEAD_PATTERN.test(record.head)) out.head = record.head.slice(0, 12);
  if (record.detached === true) out.detached = true;
  return out;
}

function readCheck(value: unknown): ProjectCheck | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!isProjectCheckId(record.id)) return undefined;
  if (typeof record.command !== "string" || !record.command || record.command.length > 200) return undefined;
  return { id: record.id, command: record.command };
}

function readFileState(value: unknown): ProjectFileState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : "";
  if (!path || path.length > 300 || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) return undefined;
  const state = record.state;
  if (state !== "present" && state !== "missing" && state !== "sensitive" && state !== "unreadable") return undefined;
  // A secret-like file is never reported as readable, whatever arrived.
  if (isSecretLikePath(path)) return { path, state: "sensitive" };
  const out: ProjectFileState = { path, state };
  if (state === "present" && typeof record.hash === "string" && HASH_PATTERN.test(record.hash)) out.hash = record.hash;
  return out;
}

/** An inspection from the wire, or `null`. Unknown fields dropped; anything malformed refused or left out. */
export function readProjectInspection(value: unknown): ProjectInspection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.projectId !== "string" || !record.projectId || record.projectId.length > 200) return null;
  if (!(PROJECT_ACCESS_STATES as readonly unknown[]).includes(record.state)) return null;
  if (typeof record.inspectedAt !== "number" || !Number.isFinite(record.inspectedAt)) return null;
  const type = typeof record.type === "string" && record.type in PROJECT_TYPE_LABELS ? (record.type as ProjectTypeId) : undefined;
  const repository = readRepository(record.repository);
  const checks = Array.isArray(record.checks) ? record.checks.map(readCheck).filter((check): check is ProjectCheck => Boolean(check)) : [];
  const files = Array.isArray(record.files)
    ? record.files.slice(0, MAX_INSPECTED_FILES).map(readFileState).filter((file): file is ProjectFileState => Boolean(file))
    : [];
  return {
    projectId: record.projectId,
    state: record.state as ProjectAccessState,
    ...(type ? { type } : {}),
    ...(repository ? { repository } : {}),
    checks,
    files,
    inspectedAt: record.inspectedAt,
  };
}
