import { scrubSecretShapes } from "@/lib/secret-shapes";

/**
 * Project checks (Hubble 1.6): the closed set of things a person can ask
 * Hubble to run to verify an agent's work.
 *
 * ## Why a closed set and not "run a command"
 *
 * Hubble never runs arbitrary commands, and an agent can never make it run
 * one: a check is named by id, the runtime re-reads what that id means from
 * the project itself at the moment it runs, and there is no field anywhere
 * in the protocol a command line could travel in. The person sees exactly
 * what will run before they run it (`command`), because a project's own
 * scripts are code — including code an agent may just have edited.
 *
 * ## What a check is, per id
 *
 *   - `typecheck` / `lint` / `test` / `build` — the project's own npm script
 *     of that name (`npm run <script>`), when it declares one;
 *   - `git_status` — `git status`, read-only, when the project is a Git
 *     repository.
 */

export type ProjectCheckId = "typecheck" | "lint" | "test" | "build" | "git_status";

export const PROJECT_CHECK_IDS: readonly ProjectCheckId[] = ["typecheck", "lint", "test", "build", "git_status"] as const;

export function isProjectCheckId(value: unknown): value is ProjectCheckId {
  return typeof value === "string" && (PROJECT_CHECK_IDS as readonly string[]).includes(value);
}

export const PROJECT_CHECK_LABELS: Record<ProjectCheckId, string> = {
  typecheck: "Typecheck",
  lint: "Lint",
  test: "Tests",
  build: "Build",
  git_status: "Git status",
};

/** A check this project can run, and exactly what running it does. */
export type ProjectCheck = {
  id: ProjectCheckId;
  /** What the person reads before running it: `npm run test — vitest run`. Bounded and scrubbed. */
  command: string;
};

/** Which npm scripts stand for which check, in order of preference. */
export const CHECK_SCRIPT_NAMES: Record<Exclude<ProjectCheckId, "git_status">, readonly string[]> = {
  typecheck: ["typecheck", "type-check", "types", "check-types", "tsc"],
  lint: ["lint"],
  test: ["test"],
  build: ["build"],
};

/** `npm init`'s placeholder test script, which only ever fails. */
const PLACEHOLDER_TEST = /no test specified/i;

const MAX_SCRIPT_NAME = 64;
const MAX_COMMAND_TEXT = 200;

/** A script name that can be passed to `npm run` as a single literal argument. */
export function isSafeScriptName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SCRIPT_NAME && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(name);
}

function bounded(text: string): string {
  const collapsed = scrubSecretShapes(text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim());
  return collapsed.length > MAX_COMMAND_TEXT ? `${collapsed.slice(0, MAX_COMMAND_TEXT - 1)}…` : collapsed;
}

/** The npm script a check runs, or `undefined` when this manifest has none. */
export function scriptForCheck(manifest: unknown, check: Exclude<ProjectCheckId, "git_status">): { name: string; body: string } | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return undefined;
  for (const name of CHECK_SCRIPT_NAMES[check]) {
    const body = (scripts as Record<string, unknown>)[name];
    if (typeof body !== "string" || !body.trim() || !isSafeScriptName(name)) continue;
    if (check === "test" && PLACEHOLDER_TEST.test(body)) continue;
    return { name, body };
  }
  return undefined;
}

/** Every check a project offers, in canonical order, from its manifest and whether it is a Git repository. */
export function checksFromProject(input: { manifest?: unknown; git: boolean }): ProjectCheck[] {
  const out: ProjectCheck[] = [];
  for (const id of ["typecheck", "lint", "test", "build"] as const) {
    const script = scriptForCheck(input.manifest, id);
    if (script) out.push({ id, command: bounded(`npm run ${script.name} — ${script.body}`) });
  }
  if (input.git) out.push({ id: "git_status", command: "git status" });
  return out;
}

/* ------------------------------------------------------------------ *
 * Outcomes
 * ------------------------------------------------------------------ */

/**
 * How a check ended. `passed` / `failed` are the project's answer; the other
 * three are Hubble's, and never read as either — a check that could not run
 * says nothing about the project.
 */
export type VerificationOutcome = "running" | "passed" | "failed" | "timed_out" | "unavailable" | "error";

export const VERIFICATION_OUTCOMES: readonly VerificationOutcome[] = [
  "running",
  "passed",
  "failed",
  "timed_out",
  "unavailable",
  "error",
] as const;

export function isVerificationOutcome(value: unknown): value is VerificationOutcome {
  return typeof value === "string" && (VERIFICATION_OUTCOMES as readonly string[]).includes(value);
}

/** What `git status` found. Counts only — never a file name. */
export type GitStatusCounts = { modified: number; added: number; deleted: number; untracked: number; renamed: number };

/** "Typecheck passed", "Tests failed", "Running build…". One sentence per outcome, used everywhere. */
export function verificationTitle(check: ProjectCheckId, outcome: VerificationOutcome): string {
  const label = PROJECT_CHECK_LABELS[check];
  const plural = check === "test";
  switch (outcome) {
    case "running":
      return check === "git_status" ? "Reading Git status…" : `Running ${label.toLowerCase()}…`;
    case "passed":
      return check === "git_status" ? "Read Git status" : `${label} passed`;
    case "failed":
      return check === "git_status" ? "Couldn't read Git status" : `${label} failed`;
    case "timed_out":
      return `${label} took too long and was stopped`;
    case "unavailable":
      return `${label} ${plural ? "aren't" : "isn't"} available here`;
    case "error":
      return `${label} couldn't run`;
  }
}

/** The quieter line under a check's title. Never output — Hubble keeps none. */
export function verificationDetail(input: {
  outcome: VerificationOutcome;
  exitCode?: number;
  durationMs?: number;
  git?: GitStatusCounts;
}): string | undefined {
  if (input.git && input.outcome === "passed") return gitCountsLine(input.git);
  const parts: string[] = [];
  if (input.outcome === "failed" && input.exitCode !== undefined) parts.push(`Exit code ${input.exitCode}`);
  if (input.outcome === "timed_out") parts.push("Nothing about the project was decided");
  if (input.outcome === "error") parts.push("Hubble couldn't start it on this machine");
  if (input.outcome === "unavailable") parts.push("This project doesn't define it, or this runtime can't run it");
  if (input.durationMs !== undefined && (input.outcome === "passed" || input.outcome === "failed")) parts.push(formatDuration(input.durationMs));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return "under a second";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

const countOf = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/** "3 modified · 1 untracked", or "No uncommitted changes". */
export function gitCountsLine(counts: GitStatusCounts): string {
  const parts: string[] = [];
  if (counts.modified) parts.push(`${counts.modified} modified`);
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.deleted) parts.push(`${counts.deleted} deleted`);
  if (counts.renamed) parts.push(`${countOf(counts.renamed, "rename", "renames")}`);
  if (counts.untracked) parts.push(`${counts.untracked} untracked`);
  return parts.length > 0 ? parts.join(" · ") : "No uncommitted changes";
}

const MAX_COUNT = 1_000_000;

export function readGitStatusCounts(value: unknown): GitStatusCounts | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const out: Partial<GitStatusCounts> = {};
  for (const key of ["modified", "added", "deleted", "untracked", "renamed"] as const) {
    const count = record[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_COUNT) return undefined;
    out[key] = count;
  }
  return out as GitStatusCounts;
}

/**
 * Counts from `git status --porcelain=v1`. Names are read only to be
 * counted, and are not returned.
 */
export function parseGitStatusPorcelain(text: string): GitStatusCounts {
  const counts: GitStatusCounts = { modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 3 || line.startsWith("## ")) continue;
    const code = line.slice(0, 2);
    if (code === "??") counts.untracked += 1;
    else if (code.includes("R")) counts.renamed += 1;
    else if (code.includes("A")) counts.added += 1;
    else if (code.includes("D")) counts.deleted += 1;
    else if (code.trim()) counts.modified += 1;
  }
  return counts;
}
