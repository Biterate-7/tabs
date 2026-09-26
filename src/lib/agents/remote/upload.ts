import { REMOTE_LIMITS } from "./types";
import type { SandboxFile } from "./sandbox";

/**
 * Validating the one thing a user genuinely hands the remote plane.
 *
 * ## Why this module is paranoid out of proportion to its size
 *
 * Everywhere else in the remote plane, the browser names an id and the server
 * resolves it. This is the single exception: creating a remote project from
 * an upload means accepting a list of *file names* chosen on the client, and
 * those names become paths inside a filesystem.
 *
 * That is the classic archive-extraction hole — `../../etc/passwd`,
 * `/etc/passwd`, `C:\Windows\...`, a symlink, a NUL byte truncating a string
 * in a layer written in C. The consequences here are smaller than usual,
 * because the filesystem in question is a disposable microVM that holds
 * nothing but this project. They are not zero: the sandbox also holds the
 * bridge and the provider credential in its environment, and a file written
 * over the bridge script would be code the agent runner then executes.
 *
 * So every name is rebuilt from validated segments rather than sanitized in
 * place. A path that cannot be rebuilt is refused, never repaired: "repair"
 * means deciding what somebody meant, and the version of that decision which
 * is wrong is the one that writes outside the directory.
 *
 * ## Why it is pure
 *
 * No `node:path`, no `node:fs`, for the same reason `lib/agents/paths.ts`
 * avoids them: `path.normalize` resolves against the *host's* rules, so the
 * same archive would validate differently on a Windows control plane and a
 * Linux one, and the sandbox is always Linux. The rules below are the
 * sandbox's rules, applied identically wherever this runs.
 */

export type UploadRejection =
  | "empty-path"
  | "absolute-path"
  | "traversal"
  | "drive-relative"
  | "unsupported-character"
  | "too-deep"
  | "too-long"
  | "file-too-large"
  | "too-many-files"
  | "upload-too-large"
  | "duplicate-path"
  | "no-files";

export const UPLOAD_REJECTION_MESSAGES: Record<UploadRejection, string> = {
  "empty-path": "One of those files has no name.",
  "absolute-path": "Project files must be inside the folder you chose.",
  traversal: "Project files must be inside the folder you chose.",
  "drive-relative": "Hubble can't resolve one of those paths with confidence.",
  "unsupported-character": "One of those file names has a character Hubble can't use.",
  "too-deep": "One of those files is nested too deeply.",
  "too-long": "One of those file names is too long.",
  "file-too-large": "One of those files is too big to upload.",
  "too-many-files": "That's more files than a project upload can carry.",
  "upload-too-large": "That upload is too big.",
  "duplicate-path": "That upload names the same file twice.",
  "no-files": "There's nothing in that upload.",
};

/** Deep enough for any real project; far short of anything pathological. */
const MAX_DEPTH = 32;
const MAX_SEGMENT_LENGTH = 255;
const MAX_PATH_LENGTH = 1024;

/**
 * Segments that are never a file in a project a user meant to upload.
 *
 * `.git` is excluded because an uploaded repository's history is both large
 * and not what the agent needs, and because a crafted `.git/hooks/*` is
 * executable code that a later `git` invocation inside the sandbox would run.
 * The others are the well-known places a secret ends up by accident — and the
 * brief is explicit that credentials must not reach the agent. Excluding them
 * is quieter than refusing the whole upload, and is reported back so the user
 * knows what was left out rather than discovering it later.
 */
const EXCLUDED_SEGMENTS: readonly string[] = [
  ".git",
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".netrc",
  ".ssh",
  ".aws",
  "node_modules",
  ".next",
  ".vercel",
] as const;

export type UploadEntry = {
  path: string;
  content: Uint8Array;
};

export type UploadResult =
  | {
      ok: true;
      files: readonly SandboxFile[];
      /** Paths dropped because they matched an excluded segment. Reported, never silent. */
      excluded: readonly string[];
    }
  | { ok: false; reason: UploadRejection };

/**
 * Rebuilds one relative path from validated segments, or refuses.
 *
 * Returns the normalized path. Note what is *not* done: no stripping of
 * leading slashes, no collapsing of `..` against earlier segments, no
 * lowercasing. Each of those is a repair, and a repair is a guess.
 */
export function normalizeUploadPath(candidate: string): { ok: true; path: string } | { ok: false; reason: UploadRejection } {
  if (typeof candidate !== "string") return { ok: false, reason: "empty-path" };

  const trimmed = candidate.trim();
  if (!trimmed) return { ok: false, reason: "empty-path" };
  if (trimmed.length > MAX_PATH_LENGTH) return { ok: false, reason: "too-long" };

  // A NUL truncates a string in any layer that eventually hands it to a
  // syscall, so `a.txt\0../../etc/passwd` can validate as `a.txt` here and
  // mean something else three layers down.
  if (trimmed.includes("\0")) return { ok: false, reason: "unsupported-character" };

  // Control characters have no legitimate place in a project file name and
  // are a reliable sign of a crafted archive rather than a real upload.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: "unsupported-character" };
  }

  // `C:foo` is drive-relative — "foo relative to the cwd on drive C" — and
  // `C:/foo` is absolute. Neither is a path inside the folder somebody chose.
  if (/^[A-Za-z]:/.test(trimmed)) return { ok: false, reason: "drive-relative" };

  const slashed = trimmed.replace(/\\/g, "/");
  if (slashed.startsWith("/")) return { ok: false, reason: "absolute-path" };

  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    // Empty segments come from `a//b` and from a trailing slash. Skipped
    // rather than refused: they are a formatting artefact of how the browser
    // reports a directory, not an attempt at anything.
    if (segment === "" || segment === ".") continue;
    // `..` is refused outright and never resolved against what came before.
    // Resolving it would mean `a/../b` is fine and `../b` is not, which is a
    // rule with an off-by-one in it; refusing every `..` has no edge case.
    if (segment === "..") return { ok: false, reason: "traversal" };
    if (segment.length > MAX_SEGMENT_LENGTH) return { ok: false, reason: "too-long" };
    segments.push(segment);
  }

  if (segments.length === 0) return { ok: false, reason: "empty-path" };
  if (segments.length > MAX_DEPTH) return { ok: false, reason: "too-deep" };

  return { ok: true, path: segments.join("/") };
}

/** Whether any segment of a normalized path is one we deliberately do not upload. */
export function isExcludedPath(normalized: string): boolean {
  return normalized
    .split("/")
    .some((segment) => EXCLUDED_SEGMENTS.includes(segment.toLowerCase()));
}

/**
 * Validates a whole upload.
 *
 * One bad path refuses the entire upload rather than dropping the file. A
 * project missing a file the user believed they sent is a project the agent
 * will reason about wrongly, and they would have no way of knowing. An
 * *excluded* path is different — it is a rule the product applies on purpose
 * — so those are dropped and named in the result.
 */
export function validateUpload(entries: readonly UploadEntry[]): UploadResult {
  if (entries.length === 0) return { ok: false, reason: "no-files" };
  if (entries.length > REMOTE_LIMITS.maxUploadFiles) {
    return { ok: false, reason: "too-many-files" };
  }

  const files: SandboxFile[] = [];
  const excluded: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const entry of entries) {
    const normalized = normalizeUploadPath(entry.path);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };

    if (isExcludedPath(normalized.path)) {
      excluded.push(normalized.path);
      continue;
    }

    if (entry.content.byteLength > REMOTE_LIMITS.maxUploadFileBytes) {
      return { ok: false, reason: "file-too-large" };
    }

    // Checked as we go rather than summed first, so an upload that is going
    // to be refused is refused before the whole of it is held in memory.
    total += entry.content.byteLength;
    if (total > REMOTE_LIMITS.maxUploadBytes) return { ok: false, reason: "upload-too-large" };

    // Two entries normalizing to one path is ambiguous about which wins, and
    // the ambiguity is exactly what a crafted archive exploits — write a
    // benign file, then overwrite it. Refused rather than last-wins.
    if (seen.has(normalized.path)) return { ok: false, reason: "duplicate-path" };
    seen.add(normalized.path);

    files.push({ path: normalized.path, content: entry.content });
  }

  if (files.length === 0) return { ok: false, reason: "no-files" };
  return { ok: true, files, excluded };
}
