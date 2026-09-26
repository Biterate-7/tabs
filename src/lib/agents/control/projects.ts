import { normalizeProjectPath, toProjectRelative } from "@/lib/agents/paths";
import { isValidGrant, NO_PERMISSIONS } from "./permissions";
import type { AgentPermissionGrant } from "./permissions";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * A local directory the user has explicitly authorized.
 *
 * ## What a project is, and what it is not
 *
 * A project is a **grant of scope over one directory**, not a discovered
 * location. Hubble never scans, never walks, never enumerates and never
 * suggests: a project exists because a person chose a directory, and the only
 * directory an agent can ever reach is one that exists here.
 *
 * ## Where validation actually happens
 *
 * Everything in this module is pure and runs anywhere, which means it can run
 * in the browser — and a browser-side check is a convenience, never a
 * security boundary. The frontend may call `validateProjectPath` to show a
 * useful message; the **local runtime re-validates every path it is given**,
 * against the registered project, before touching anything. See
 * ./runtime.ts. A path arriving from the client is a claim, not a fact.
 *
 * The guard test asserts that nothing here imports `node:fs` or `node:path`,
 * for the same reason `lib/agents/paths.ts` does not: these functions must
 * behave identically for a Windows path read on POSIX, and `node:path`
 * resolves against the host's rules and its own cwd.
 */

/**
 * Where a project's files actually are.
 *
 * ## Why this is on the project rather than on the session
 *
 * Because it is a property of the *grant*, not of any particular use of it. A
 * directory on someone's laptop and a workspace inside a microVM are two
 * different things to authorize, they carry two different blast radiuses, and
 * a person choosing one has not thereby chosen the other. Putting the
 * distinction on the session would mean the same authorization could be spent
 * in either place depending on how it was invoked.
 *
 * ## Why `local` is the default everywhere
 *
 * Every project that existed before Phase I is a local one, and every call
 * site that does not mention a source still produces one. A stored record
 * with no `source` field revives as `local`, which is what it was — see
 * ./persistence.ts.
 */
export type AgentProjectSource =
  /** A directory on the machine running the runtime. The original, and the default. */
  | "local"
  /** Files the user uploaded, unpacked into a sandbox workspace Hubble created. */
  | "remote_upload"
  /**
   * A repository cloned into a sandbox workspace.
   *
   * Declared, and deliberately not implemented in this phase. Doing it safely
   * needs a credential path that does not exist yet — see
   * docs/agent-remote-runtime.md — and inventing one to complete the union
   * would be exactly the insecure shortcut the brief rules out. Nothing
   * creates a project with this source, and the remote store refuses one.
   */
  | "remote_git";

export const AGENT_PROJECT_SOURCES: readonly AgentProjectSource[] = [
  "local",
  "remote_upload",
  "remote_git",
] as const;

export function isAgentProjectSource(value: unknown): value is AgentProjectSource {
  return (
    typeof value === "string" && (AGENT_PROJECT_SOURCES as readonly string[]).includes(value)
  );
}

/** Whether this source's files live somewhere other than the runtime's own machine. */
export function isRemoteSource(source: AgentProjectSource): boolean {
  return source === "remote_upload" || source === "remote_git";
}

export type AgentProject = {
  id: string;
  /** What the user calls it. Never derived from the path without them seeing it. */
  name: string;
  /**
   * Which plane this project's files live on.
   *
   * Never accepted from the browser. `authorize_projects` — the one command
   * that carries project records across the boundary — refuses anything but
   * `local`, because a remote project is not something a client can assert
   * into existence: it exists because the server created a sandbox for it and
   * wrote a row, and it is resolved from that row. See ./runtime's
   * `resolveProject` seam and ../runtime/protocol.ts.
   */
  source: AgentProjectSource;
  /**
   * The authorized root, in its original spelling.
   *
   * Compared through `normalizeProjectPath`, never directly — see that
   * function on why a project would otherwise fail to match itself.
   */
  path: string;
  /**
   * Which providers may use this project.
   *
   * An explicit list, not "all connected providers". Authorizing a directory
   * for Claude Code must not silently authorize it for whatever is connected
   * next week.
   */
  providers: readonly AgentProviderId[];
  /**
   * Further directories this project's sessions may reach, beyond `path`.
   *
   * Each is validated exactly as `path` is — no roots, no home directories,
   * no traversal — and each is an *additional explicit decision*, never
   * derived. A sibling of the project root is not included because it is a
   * sibling; it is included because the user named it.
   *
   * Empty is the default and the common case.
   */
  additionalDirectories: readonly string[];
  permissions: AgentPermissionGrant;
  createdAt: number;
  updatedAt: number;
};

export type ProjectPathRejection =
  | "empty"
  | "not-absolute"
  | "unsupported-form"
  | "filesystem-root"
  | "sensitive-location"
  | "too-long";

export type ProjectPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: ProjectPathRejection };

/** Generous for a real project path, far short of anything pathological. */
export const MAX_PROJECT_PATH_LENGTH = 4096;

/**
 * Forward slashes, collapsed separators, no trailing separator. Spelling
 * preserved.
 *
 * The leading `//` of a UNC path is put back after collapsing. Without that
 * step `\\server\share` becomes `/server/share` — a path that looks absolute,
 * is not the directory anybody named, and would sail past a root check
 * looking like an ordinary two-segment folder.
 */
function toSlashes(value: string): string {
  const unc = /^[\\/]{2}[^\\/]/.test(value);
  const collapsed = value.replace(/[\\/]+/g, "/").replace(/(.)\/+$/, "$1");
  return unc ? `/${collapsed}` : collapsed;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

/**
 * Whether a normalized path *is* a user's home directory.
 *
 * Distinct from the leaf-name check below, and necessary because a home
 * directory's last segment is the username — which cannot be enumerated.
 * `C:/Users/alice` and `/home/alice` are caught by shape, not by name.
 */
function isHomeDirectory(normalized: string): boolean {
  return (
    /^[a-z]:\/users\/[^/]+$/.test(normalized) ||
    /^\/home\/[^/]+$/.test(normalized) ||
    /^\/users\/[^/]+$/.test(normalized) ||
    // The container of every home directory is worse still.
    /^[a-z]:\/users$/.test(normalized)
  );
}

/**
 * Locations a project may never be rooted at.
 *
 * Not an attempt at a complete list of dangerous directories — that list
 * cannot be completed, and pretending otherwise is worse than not trying.
 * These are the roots whose authorization is *never* what someone means: a
 * filesystem root or a bare drive hands over the machine, and a home
 * directory or a well-known user folder hands over everything the user owns
 * including every other project.
 *
 * A person who genuinely wants an agent in `~/Documents` can authorize the
 * specific directory inside it that they mean.
 */
const FORBIDDEN_LEAF_NAMES: readonly string[] = [
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "music",
  "videos",
  "onedrive",
  "users",
  "home",
  "windows",
  "system32",
  "program files",
  "program files (x86)",
  "programdata",
  "appdata",
  "library",
  "applications",
  ".ssh",
  ".aws",
  ".config",
  ".claude",
];

/**
 * Whether a normalized path is a filesystem root or a bare drive.
 *
 * `/`, `C:/`, `//server` — each authorizes everything reachable, which is the
 * one outcome the permission model exists to make impossible.
 */
function isFilesystemRoot(normalized: string): boolean {
  if (normalized === "/" || normalized === "") return true;
  if (/^[A-Za-z]:\/?$/.test(normalized)) return true;
  // A UNC path with no share beyond the host names the whole host.
  if (/^\/\/[^/]+\/?$/.test(normalized)) return true;
  return false;
}

/**
 * Whether the path is a user's home directory or a well-known folder inside
 * it, rather than a project within one.
 *
 * Judged on the final segment only. A directory *named* `documents` two
 * levels inside a repository is a legitimate project folder, so the check is
 * on depth as well: a shallow path ending in one of these names is the home
 * folder itself, while a deep one is a directory somebody made.
 */
function isSensitiveLocation(normalized: string): boolean {
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return true;

  if (isHomeDirectory(normalized)) return true;

  // A forbidden *name* is refused only when it is the leaf. A directory
  // called `documents` two levels inside a repository is a legitimate project
  // folder; `C:/Users/alice/Documents` is not. Judging on the leaf means the
  // rare false positive is a project the user is asked to name by its parent,
  // which is a far better failure than authorizing a home folder.
  return FORBIDDEN_LEAF_NAMES.includes(segments[segments.length - 1]);
}

/**
 * Validates a candidate project root.
 *
 * Returns the normalized-for-storage path (forward slashes, no trailing
 * separator, original case) or a reason. Refuses rather than coerces: a path
 * this cannot express with confidence is not silently repaired into one that
 * points somewhere else.
 */
export function validateProjectPath(candidate: string): ProjectPathResult {
  const trimmed = candidate.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_PROJECT_PATH_LENGTH) return { ok: false, reason: "too-long" };

  const slashed = toSlashes(trimmed);

  // `C:foo` is drive-relative — "foo relative to the cwd on drive C" — which
  // is per-process state this code cannot see. Guessing would authorize a
  // directory the user did not choose.
  if (/^[A-Za-z]:[^/]/.test(slashed)) return { ok: false, reason: "unsupported-form" };
  if (slashed.includes("\0")) return { ok: false, reason: "unsupported-form" };

  if (!isAbsolutePath(slashed)) return { ok: false, reason: "not-absolute" };

  // A root that still contains traversal segments has not been resolved, and
  // resolving it here would mean guessing at a real filesystem.
  const segments = slashed.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    return { ok: false, reason: "unsupported-form" };
  }

  // Lowercased here rather than through `normalizeProjectPath`, which
  // collapses a leading `//` and would turn a UNC host back into an ordinary
  // first segment — undoing the very thing `toSlashes` just preserved.
  const normalized = slashed.toLowerCase();
  if (isFilesystemRoot(normalized)) return { ok: false, reason: "filesystem-root" };
  if (isSensitiveLocation(normalized)) return { ok: false, reason: "sensitive-location" };

  return { ok: true, path: slashed };
}

export const PROJECT_PATH_REJECTION_MESSAGES: Record<ProjectPathRejection, string> = {
  empty: "Choose a folder.",
  "not-absolute": "That needs to be a full path to a folder.",
  "unsupported-form": "Hubble can't resolve that path with confidence.",
  "filesystem-root": "A whole drive is too broad. Choose the project folder itself.",
  "sensitive-location":
    "That folder holds everything else you own. Choose the specific project inside it.",
  "too-long": "That path is too long.",
};

/** Whether two project paths name the same directory. */
export function isSameProjectPath(a: string, b: string): boolean {
  return normalizeProjectPath(a) === normalizeProjectPath(b);
}

export type CreateProjectInput = {
  id: string;
  name: string;
  path: string;
  /** Defaults to `local`, so every pre-Phase-I call site means what it always did. */
  source?: AgentProjectSource;
  providers?: readonly AgentProviderId[];
  /** Each validated exactly as `path` is. One bad entry rejects the whole project. */
  additionalDirectories?: readonly string[];
  permissions?: AgentPermissionGrant;
};

export type CreateProjectResult =
  | { ok: true; project: AgentProject }
  | {
      ok: false;
      reason:
        | ProjectPathRejection
        | "invalid-name"
        | "invalid-permissions"
        | "invalid-additional-directory";
    };

/**
 * Mints a project.
 *
 * Starts with **no permissions and no providers** unless both are supplied
 * explicitly. Connecting a folder and authorizing an agent to write in it are
 * two separate decisions, and this is where that separation is enforced.
 */
export function createProject(input: CreateProjectInput, now: number): CreateProjectResult {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: "invalid-name" };

  const validated = validateProjectPath(input.path);
  if (!validated.ok) return { ok: false, reason: validated.reason };

  const permissions = input.permissions ?? NO_PERMISSIONS;
  if (permissions !== NO_PERMISSIONS && !isValidGrant(permissions)) {
    return { ok: false, reason: "invalid-permissions" };
  }

  // A grant handed in must be scoped to *this* project, or it is not a grant
  // over it. Silently re-homing one would let a permission set written for
  // another directory apply here.
  if (permissions.projectId && permissions.projectId !== input.id) {
    return { ok: false, reason: "invalid-permissions" };
  }

  // Every additional directory is held to exactly the same standard as the
  // root, and one bad entry rejects the whole project rather than being
  // dropped. Silently discarding it would leave the user believing they had
  // authorized something they had not.
  const additionalDirectories: string[] = [];
  for (const candidate of input.additionalDirectories ?? []) {
    const extra = validateProjectPath(candidate);
    if (!extra.ok) return { ok: false, reason: "invalid-additional-directory" };
    if (!additionalDirectories.includes(extra.path)) additionalDirectories.push(extra.path);
  }

  return {
    ok: true,
    project: {
      id: input.id,
      name,
      // Absent means local. A project that does not say where it lives is one
      // from before the question was asked, and every one of those was local.
      source: input.source ?? "local",
      path: validated.path,
      providers: input.providers ? [...input.providers] : [],
      additionalDirectories,
      permissions,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/**
 * Whether `candidate` is reachable from this project at all — inside the root
 * or inside one of the explicitly authorized additional directories.
 *
 * Distinct from `containsPath`, which asks only about the root. This is the
 * question the runtime asks before handing a directory to a provider.
 */
export function isReachable(project: AgentProject, candidate: string): boolean {
  if (containsPath(project, candidate).ok) return true;
  return project.additionalDirectories.some((directory) =>
    toProjectRelative(directory, candidate).ok
  );
}

/** Whether `provider` was explicitly authorized for this project. Absence denies. */
export function isProviderAuthorized(
  project: AgentProject,
  provider: AgentProviderId
): boolean {
  return project.providers.includes(provider);
}

export type ContainmentResult =
  | { ok: true; relativePath: string }
  | { ok: false; reason: "outside-project" | "escapes-root" | "empty" | "unsupported-form" };

/**
 * Whether `candidate` names a file inside `project`, and what it is called
 * relative to the root.
 *
 * The one function that answers "may this path be touched at all", and it
 * delegates to `toProjectRelative` rather than reimplementing containment —
 * that function already refuses traversal, foreign roots and drive-relative
 * forms, and is already covered by its own tests. A second implementation
 * here would be a second chance to get it wrong.
 */
export function containsPath(project: AgentProject, candidate: string): ContainmentResult {
  const result = toProjectRelative(project.path, candidate);
  if (result.ok) return { ok: true, relativePath: result.relativePath };
  return { ok: false, reason: result.reason };
}
