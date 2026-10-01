import nodePath from "node:path";

/**
 * The Codex settings folder Hubble owns (`CODEX_HOME` for every Codex process
 * Hubble starts). See docs/codex-app-server.md.
 *
 * ## Why not the user's own `~/.codex`
 *
 * Verified against Codex 0.159.0: in the user's own folder,
 *
 *   - a `rules/*.rules` entry with `decision = "allow"` makes Codex run a
 *     matching command **without asking**, whatever approval policy Hubble
 *     sends on the thread;
 *   - an `[mcp_servers.*]` entry is started — a program launched — even when
 *     Hubble overrides `mcp_servers` on the command line, because Codex merges
 *     configuration layers rather than replacing them.
 *
 * Either would let something the user configured for their terminal
 * undermine the approval Hubble puts in front of every command. So Hubble
 * runs Codex against a folder of its own, where it controls the settings.
 *
 * ## What that costs, said plainly
 *
 * The user signs in to Codex once for Hubble — through Codex's own sign-in
 * (`codex login`), which stores the login in this folder. Hubble never copies
 * a login from `~/.codex`: that would be moving another application's
 * credential, which Hubble does not do.
 *
 * ## What Hubble does to the folder
 *
 *   - `config.toml` is rewritten with Hubble's own (empty) settings on every
 *     launch, so anything added to it — an MCP server, a trusted project, a
 *     sandbox setting — is gone before Codex reads it.
 *   - A `rules` folder with anything in it refuses the launch. A rules file is
 *     the one thing that can approve a command unasked, and deleting a file
 *     somebody put there on purpose is not Hubble's decision either.
 *
 * Everything else in the folder is Codex's own (its login, its logs, its
 * state) and is left alone.
 */

export const CODEX_HOME_CONFIG = [
  "# Managed by Hubble.",
  "#",
  "# Hubble starts Codex with this folder as CODEX_HOME, instead of ~/.codex, so",
  "# that no rule, MCP server, hook or plugin set up for your terminal can change",
  "# how Codex asks for approval inside Hubble. This file is rewritten every time",
  "# Hubble starts Codex; changes made here are discarded.",
  "",
].join("\n");

export type CodexHomeFs = {
  /** Creates a directory and its parents. Throws when it cannot. */
  makeDirectory(directory: string): void;
  readText(file: string): string | undefined;
  /** Throws when it cannot. */
  writeText(file: string, text: string): void;
  /** Entries of a directory, or `undefined` when there is no such directory. */
  list(directory: string): readonly string[] | undefined;
};

/**
 * Where Hubble's Codex folder lives on this machine, from the standard
 * per-user application-data location. `undefined` when the environment names
 * none — a launch is then refused rather than guessed at.
 */
export function hubbleCodexHome(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): string | undefined {
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const absolute = (value: string | undefined) => (value && path.isAbsolute(value) ? value : undefined);

  if (platform === "win32") {
    const base = absolute(env.LOCALAPPDATA);
    return base ? path.join(base, "Hubble", "codex") : undefined;
  }
  const home = absolute(env.HOME);
  if (platform === "darwin") return home ? path.join(home, "Library", "Application Support", "Hubble", "codex") : undefined;
  const state = absolute(env.XDG_STATE_HOME) ?? (home ? path.join(home, ".local", "state") : undefined);
  return state ? path.join(state, "hubble", "codex") : undefined;
}

export type CodexHomePreparation = { ok: true } | { ok: false; reason: "unwritable" | "has-rules" };

/** Makes the folder ready for a launch, or says why it is not. */
export function prepareCodexHome(
  home: string,
  fs: CodexHomeFs,
  platform: NodeJS.Platform
): CodexHomePreparation {
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix;
  try {
    fs.makeDirectory(home);
    const config = path.join(home, "config.toml");
    if (fs.readText(config) !== CODEX_HOME_CONFIG) fs.writeText(config, CODEX_HOME_CONFIG);
  } catch {
    return { ok: false, reason: "unwritable" };
  }

  const rules = fs.list(path.join(home, "rules"));
  if (rules && rules.length > 0) return { ok: false, reason: "has-rules" };
  return { ok: true };
}
