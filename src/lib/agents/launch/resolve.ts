import nodePath from "node:path";

/** The path flavour of the platform being resolved for — which tests choose explicitly. */
function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/**
 * Finds an allowlisted executable on PATH without running anything.
 *
 * ## Why this does not shell out to `which` / `where`
 *
 * Because that would be executing a program to decide whether to execute a
 * program. Resolution is a pure walk of PATH with a `stat` per candidate,
 * against a filesystem that is injected so the whole thing is tested without
 * touching the real one.
 *
 * ## The Windows npm shim
 *
 * `npm install -g` on Windows produces `gemini.cmd`, a batch file. Node will
 * not spawn a batch file without `shell: true` (CVE-2024-27980), and TabDump
 * never spawns through a shell. So a `.cmd`/`.bat` hit is followed to the
 * package it wraps — `<shim dir>/node_modules/<package>/package.json`, for a
 * package named in the allowlist and no other — and resolved to that
 * package's own JavaScript `bin`, which is then run by this Node binary. A
 * shim with no allowlisted package behind it is not launched.
 */

export type ResolverFs = {
  isFile(candidate: string): boolean;
  readText(candidate: string): string | undefined;
};

export type ResolvedExecutable =
  | { kind: "native"; file: string }
  | { kind: "node-script"; script: string };

export type ResolveOptions = {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  fs: ResolverFs;
  npmPackages?: readonly string[];
};

function pathEntries(env: ResolveOptions["env"], platform: NodeJS.Platform): string[] {
  const path = pathFor(platform);
  const raw = env.PATH ?? env.Path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  return raw
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}

function extensions(env: ResolveOptions["env"], platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [""];
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  // Only the kinds this module knows how to start without a shell.
  return raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext === ".exe" || ext === ".cmd" || ext === ".bat");
}

/** Resolves an npm shim to the JavaScript entry of an allowlisted package behind it. */
function scriptBehindShim(
  shimDirectory: string,
  name: string,
  options: ResolveOptions
): string | undefined {
  const path = pathFor(options.platform);
  for (const pkg of options.npmPackages ?? []) {
    const root = path.join(shimDirectory, "node_modules", ...pkg.split("/"));
    const manifest = options.fs.readText(path.join(root, "package.json"));
    if (!manifest) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest);
    } catch {
      continue;
    }
    const bin = (parsed as { bin?: unknown }).bin;
    const relative =
      typeof bin === "string"
        ? bin
        : bin && typeof bin === "object"
          ? (bin as Record<string, unknown>)[name]
          : undefined;
    if (typeof relative !== "string") continue;

    const script = path.resolve(root, relative);
    // The entry must stay inside the package it came from.
    if (!script.startsWith(root + path.sep)) continue;
    if (options.fs.isFile(script)) return script;
  }
  return undefined;
}

export function resolveExecutable(
  name: string,
  options: ResolveOptions
): ResolvedExecutable | undefined {
  const path = pathFor(options.platform);
  // A name, never a path. The allowlist holds names; anything else is refused.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return undefined;

  for (const directory of pathEntries(options.env, options.platform)) {
    for (const ext of extensions(options.env, options.platform)) {
      const candidate = path.join(directory, name + ext);
      if (!options.fs.isFile(candidate)) continue;

      if (ext === ".cmd" || ext === ".bat") {
        const script = scriptBehindShim(directory, name, options);
        if (script) return { kind: "node-script", script };
        // A shim for something TabDump did not allowlist. Keep looking.
        continue;
      }
      return { kind: "native", file: candidate };
    }
  }
  return undefined;
}

/** Whether an executable is present at all, shim or not. For detection only. */
export function isOnPath(name: string, options: Omit<ResolveOptions, "npmPackages">): boolean {
  const path = pathFor(options.platform);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return false;
  const exts =
    options.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  return pathEntries(options.env, options.platform).some((directory) =>
    exts.some((ext) => options.fs.isFile(path.join(directory, name + ext)))
  );
}
