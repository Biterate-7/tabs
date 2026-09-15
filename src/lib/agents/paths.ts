/**
 * Turning a path an agent mentioned into a project-relative identity.
 *
 * This is the gate between "somewhere on a machine" and "a file in a
 * project". Everything downstream — artifact identity, deduplication, what a
 * later UI can show — depends on a path having been through here, and on the
 * ones that do not belong being refused rather than coerced.
 *
 * Deliberately pure string manipulation: `node:path` resolves against the
 * *host's* rules and its own cwd, which is wrong twice over here. The paths
 * being normalised come from another process's records and may be Windows
 * paths read on POSIX or the reverse, and the generic agent domain is
 * forbidden from importing `node:path` at all (see security.test.ts).
 */

/**
 * A path that could not be expressed inside the project.
 *
 * Returned rather than thrown because a rejected path is an ordinary
 * occurrence — an agent reading its own config, a temp file, something
 * outside the repo — not an error worth interrupting a poll for.
 */
export type ProjectRelativeResult =
  | { ok: true; relativePath: string }
  | { ok: false; reason: ProjectPathRejection };

export type ProjectPathRejection =
  | "empty"
  | "outside-project"
  | "escapes-root"
  | "unsupported-form";

/** Forward slashes, collapsed separators, no trailing separator. */
function toSlashes(value: string): string {
  return value.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
}

/**
 * Whether a path names a location on its own, rather than relative to
 * something else.
 *
 * Covers POSIX (`/x`), Windows drive paths (`C:/x`) and UNC (`//server/share`).
 */
function isAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

/**
 * Forms that cannot be resolved against a project root with any confidence.
 *
 * `C:foo` is the interesting one: on Windows that means "foo relative to the
 * current directory *on drive C*", which is a per-process piece of state this
 * code cannot see. Guessing would silently attach a file to the wrong project,
 * so it is refused.
 */
function isUnsupported(value: string): boolean {
  if (/^[A-Za-z]:[^/]/.test(value)) return true;
  // A bare drive with nothing after it names no file.
  if (/^[A-Za-z]:\/?$/.test(value)) return true;
  return false;
}

/**
 * Applies `.` and `..` segments.
 *
 * Returns null when the path climbs above its own root, which is the
 * traversal case: `../../secret.txt` resolved against a project root is not a
 * file in that project, and must never be reported as one.
 */
function resolveSegments(segments: string[]): string[] | null {
  const out: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment !== "..") {
      out.push(segment);
      continue;
    }
    // Climbing past the root is the rejection this function exists for.
    if (out.length === 0) return null;
    out.pop();
  }

  return out;
}

/**
 * The canonical comparison form of a project path.
 *
 * Case-folded because Windows reports the same directory as `C:\Users\x` and
 * `c:/users/x` depending on who wrote it, and a project failing to match
 * itself on that basis would look like a session mysteriously refusing to
 * attach. This is normalisation of one identifier, not fuzzy matching — two
 * genuinely different directories never collide.
 */
export function normalizeProjectPath(projectPath: string): string {
  return toSlashes(projectPath.trim()).toLowerCase();
}

/**
 * Expresses `candidate` as a path relative to `projectPath`.
 *
 * Accepts either an absolute path inside the project or a path already
 * relative to it. Everything else is refused:
 *
 *  - a path under a *different* root is `outside-project`, never re-homed
 *    into this one;
 *  - a relative path that climbs out with `..` is `escapes-root`;
 *  - drive-relative and bare-drive forms are `unsupported-form`.
 *
 * Case is preserved in the result — `src/App.tsx` stays capitalised — while
 * the *root* is compared case-insensitively only for Windows-style paths,
 * where the filesystem itself is. A POSIX root is compared exactly, because
 * there `/repo/Project` and `/repo/project` are two different directories.
 */
export function toProjectRelative(
  projectPath: string,
  candidate: string
): ProjectRelativeResult {
  const rawRoot = toSlashes(projectPath.trim());
  const rawCandidate = toSlashes(candidate.trim());

  if (!rawRoot || !rawCandidate) return { ok: false, reason: "empty" };
  if (isUnsupported(rawCandidate)) return { ok: false, reason: "unsupported-form" };

  if (!isAbsolute(rawCandidate)) {
    const resolved = resolveSegments(rawCandidate.split("/"));
    if (!resolved) return { ok: false, reason: "escapes-root" };
    if (resolved.length === 0) return { ok: false, reason: "empty" };
    return { ok: true, relativePath: resolved.join("/") };
  }

  // Windows paths are case-insensitive; POSIX ones are not.
  const windows = /^[A-Za-z]:\//.test(rawRoot) || /^[A-Za-z]:\//.test(rawCandidate);
  const root = windows ? rawRoot.toLowerCase() : rawRoot;
  const target = windows ? rawCandidate.toLowerCase() : rawCandidate;

  if (target === root) return { ok: false, reason: "empty" };
  // The separator check matters: `C:/repo/project-other` must not be read as
  // living inside `C:/repo/project`.
  if (!target.startsWith(`${root}/`)) return { ok: false, reason: "outside-project" };

  // Sliced from the ORIGINAL candidate, so the result keeps its real case.
  const remainder = rawCandidate.slice(rawRoot.length + 1);
  const resolved = resolveSegments(remainder.split("/"));
  if (!resolved) return { ok: false, reason: "escapes-root" };
  if (resolved.length === 0) return { ok: false, reason: "empty" };

  return { ok: true, relativePath: resolved.join("/") };
}

/**
 * The last segment of a project-relative path — what a summary shows.
 *
 * Kept here beside the normaliser so there is one notion of "the file's name"
 * in the codebase rather than one per provider.
 */
export function relativePathBasename(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}
