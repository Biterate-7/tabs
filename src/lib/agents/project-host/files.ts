import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { validateProjectPath } from "@/lib/agents/control/projects";
import { checksFromProject } from "@/lib/agents/project/checks";
import {
  commitFromPackedRefs,
  detectProjectType,
  MAX_INSPECTED_FILES,
  parseGitDirPointer,
  parseGitHead,
  PROJECT_MARKER_FILES,
} from "@/lib/agents/project/inspection";
import { isSecretLikePath } from "@/lib/agents/project/secrets";
import { sameState } from "@/lib/agents/project/seam";
import type { ProjectAccessState, ProjectFileState, ProjectRepository } from "@/lib/agents/project/inspection";
import type { FileSnapshot, ProjectFileSystem } from "@/lib/agents/project/seam";

/**
 * The only code that reads or writes a project's files on Hubble's own
 * behalf (Hubble 1.6). Server-only; reached by the local and desktop runtime
 * wiring and nothing else (`project-host/security.test.ts`).
 *
 * ## What it does, all of it
 *
 *   - says whether a project's folder can be reached (`access`);
 *   - reads marker files and `.git/HEAD` to say what kind of project it is
 *     and which branch is checked out (`inspect`);
 *   - takes a copy of a file an agent was just allowed to change, before the
 *     agent is unblocked (`snapshot`), and reads it again afterwards;
 *   - puts a copy back when the person undoes a change (`restore`) — only
 *     after re-reading the file and finding it exactly as the agent left it.
 *
 * It never lists a directory, never walks a tree and never follows a link.
 *
 * ## Containment, on the real filesystem
 *
 * `toProjectRelative` already refuses traversal on paper. Here the question is
 * asked of the disk: the project root and the nearest existing ancestor of the
 * target are resolved with `realpath`, and the target must stay inside the
 * root's real path. A symbolic link at the target itself is refused outright
 * — a copy taken through a link, or written back through one, could land
 * anywhere. Secret-like paths (./project/secrets.ts) are refused before any of
 * that: their contents are never read.
 */

/** Largest file Hubble keeps a copy of, per file. Beyond it a change is measured by hash only and cannot be undone. */
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
/** Largest manifest Hubble parses. */
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_GIT_FILE_BYTES = 64 * 1024;

export function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let index = 0; index < limit; index++) if (bytes[index] === 0) return true;
  return false;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** A project-relative path Hubble is willing to resolve at all. */
function isAcceptableRelative(relativePath: string): boolean {
  if (!relativePath || relativePath.length > 300 || relativePath.includes("\0")) return false;
  if (relativePath.includes("\\") || relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) return false;
  const segments = relativePath.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function insideRoot(realRoot: string, candidate: string): boolean {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const root = fold(realRoot);
  const target = fold(candidate);
  return target === root || target.startsWith(root.endsWith(nodePath.sep) ? root : root + nodePath.sep);
}

type Resolved = { ok: true; absolute: string; realRoot: string } | { ok: false; kind: "sensitive" | "unsafe" | "unreadable" };

/** Where a project-relative path really is, or why Hubble will not touch it. */
async function resolveInside(root: string, relativePath: string): Promise<Resolved> {
  if (!isAcceptableRelative(relativePath)) return { ok: false, kind: "unsafe" };
  if (isSecretLikePath(relativePath)) return { ok: false, kind: "sensitive" };
  if (!validateProjectPath(root).ok) return { ok: false, kind: "unsafe" };

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, kind: "unreadable" };
  }
  const absolute = nodePath.join(realRoot, ...relativePath.split("/"));
  if (!insideRoot(realRoot, absolute)) return { ok: false, kind: "unsafe" };

  // The nearest ancestor that exists must really be inside the root: a linked
  // directory part-way down would otherwise carry the path out of it.
  let ancestor = nodePath.dirname(absolute);
  for (;;) {
    try {
      const real = await realpath(ancestor);
      if (!insideRoot(realRoot, real)) return { ok: false, kind: "unsafe" };
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return { ok: false, kind: "unreadable" };
      const parent = nodePath.dirname(ancestor);
      if (parent === ancestor || !insideRoot(realRoot, parent)) return { ok: false, kind: "unsafe" };
      ancestor = parent;
    }
  }
  return { ok: true, absolute, realRoot };
}

async function snapshotOf(root: string, relativePath: string): Promise<FileSnapshot> {
  const resolved = await resolveInside(root, relativePath);
  if (!resolved.ok) return { kind: resolved.kind };
  let info;
  try {
    info = await lstat(resolved.absolute);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
  if (info.isSymbolicLink() || !info.isFile()) return { kind: "unsafe" };
  try {
    const bytes = new Uint8Array(await readFile(resolved.absolute));
    const snapshot: FileSnapshot = { kind: "file", hash: hashOf(bytes), size: bytes.length, binary: isBinary(bytes) };
    if (bytes.length <= MAX_SNAPSHOT_BYTES) snapshot.bytes = bytes;
    return snapshot;
  } catch {
    return { kind: "unreadable" };
  }
}

async function readSmall(absolute: string, max: number): Promise<string | undefined> {
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > max) return undefined;
    return await readFile(absolute, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The Git repository's branch and commit, from `HEAD` alone — Git itself is
 * never run to find them. A `.git` file (a worktree or submodule) names its
 * real Git directory; only `HEAD`, the one ref and `packed-refs` are read there.
 */
async function repositoryOf(realRoot: string): Promise<ProjectRepository | undefined> {
  const dotGit = nodePath.join(realRoot, ".git");
  let gitDir: string | undefined;
  try {
    const info = await lstat(dotGit);
    if (info.isDirectory()) gitDir = dotGit;
    else if (info.isFile()) {
      const pointer = parseGitDirPointer((await readSmall(dotGit, 4096)) ?? "");
      if (pointer) gitDir = nodePath.resolve(realRoot, pointer);
    }
  } catch {
    return undefined;
  }
  if (!gitDir) return undefined;

  const head = parseGitHead((await readSmall(nodePath.join(gitDir, "HEAD"), 4096)) ?? "");
  const repository: ProjectRepository = { kind: "git" };
  if (!head) return repository;
  if (head.detached) return { ...repository, detached: true, ...(head.head ? { head: head.head } : {}) };
  repository.branch = head.branch!;

  // A worktree's own HEAD; its refs live in the common directory it names.
  const common = (await readSmall(nodePath.join(gitDir, "commondir"), 4096))?.trim();
  const refsDir = common ? nodePath.resolve(gitDir, common) : gitDir;
  const loose = (await readSmall(nodePath.join(refsDir, ...head.ref!.split("/")), 4096))?.trim();
  const commit = loose && /^[0-9a-f]{40}$/.test(loose) ? loose.slice(0, 12) : commitFromPackedRefs((await readSmall(nodePath.join(refsDir, "packed-refs"), MAX_GIT_FILE_BYTES * 16)) ?? "", head.ref!);
  if (commit) repository.head = commit;
  return repository;
}

async function accessOf(root: string): Promise<ProjectAccessState> {
  if (!validateProjectPath(root).ok) return "unavailable";
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return "not_a_directory";
    await realpath(root);
    return "ready";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EACCES" || code === "EPERM") return "permission_denied";
    return "unavailable";
  }
}

export function createProjectFileSystem(): ProjectFileSystem {
  return {
    access: accessOf,

    async inspect(root, files) {
      const state = await accessOf(root);
      if (state !== "ready") return { state, checks: [], files: [] };
      const realRoot = await realpath(root);

      const markers = new Set<string>();
      for (const marker of PROJECT_MARKER_FILES) {
        try {
          const info = await lstat(nodePath.join(realRoot, ...marker.split("/")));
          if (info.isFile()) markers.add(marker);
        } catch {
          // Absent is the common case.
        }
      }
      let manifest: unknown;
      if (markers.has("package.json")) {
        const text = await readSmall(nodePath.join(realRoot, "package.json"), MAX_MANIFEST_BYTES);
        try {
          manifest = text ? JSON.parse(text) : undefined;
        } catch {
          manifest = undefined;
        }
        // A manifest that could not be read still marks a Node project.
        manifest ??= {};
      }
      const type = detectProjectType({ ...(manifest !== undefined ? { manifest } : {}), markers });
      const repository = await repositoryOf(realRoot);

      const states: ProjectFileState[] = [];
      for (const path of files.slice(0, MAX_INSPECTED_FILES)) {
        const snapshot = await snapshotOf(root, path);
        if (snapshot.kind === "file") states.push({ path, state: "present", hash: snapshot.hash.slice(0, 12) });
        else if (snapshot.kind === "absent") states.push({ path, state: "missing" });
        else if (snapshot.kind === "sensitive") states.push({ path, state: "sensitive" });
        else states.push({ path, state: "unreadable" });
      }

      return {
        state,
        ...(type ? { type } : {}),
        ...(repository ? { repository } : {}),
        checks: checksFromProject({ ...(manifest !== undefined ? { manifest } : {}), git: Boolean(repository) }),
        files: states,
      };
    },

    snapshot: snapshotOf,

    async restore(root, relativePath, previous, expected) {
      const resolved = await resolveInside(root, relativePath);
      if (!resolved.ok) return "unsafe";
      // Exactly what the agent left, or nothing is written.
      const current = await snapshotOf(root, relativePath);
      if (current.kind === "unsafe" || current.kind === "sensitive") return "unsafe";
      if (!sameState(current, expected)) return "changed";
      try {
        if (previous.kind === "absent") {
          if (current.kind === "file") await unlink(resolved.absolute);
          return "restored";
        }
        if (previous.kind !== "file" || !previous.bytes) return "failed";
        // Beside the file, then renamed over it, so a failure never leaves half a file.
        const temporary = `${resolved.absolute}.hubble-undo-${randomBytes(6).toString("hex")}`;
        await writeFile(temporary, previous.bytes, { flag: "wx" });
        try {
          await rename(temporary, resolved.absolute);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
        return "restored";
      } catch {
        return "failed";
      }
    },
  };
}
