/**
 * The environment an agent process is given: an allowlist, never the host's.
 *
 * ## Why an allowlist rather than stripping known secrets
 *
 * The server's environment holds TabDump's own secrets — the database URL,
 * the credential encryption key, whatever an operator added — and any
 * provider key a developer exported in their shell. A denylist has to know
 * every one of those names; an allowlist has to know only what an agent needs
 * to find its own login and run: where home is, where temporary files go,
 * and PATH so its own tools resolve.
 *
 * In particular no `*_API_KEY` passes. The agent signs in with its own native
 * login — the thing the user set up in that agent — or it does not sign in.
 * That is the same "no fallback to a key in the environment" rule the
 * provider-connection layer enforces, applied to processes TabDump starts.
 */
export const AGENT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const;

export function agentEnvironment(
  source: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of AGENT_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  // Agents that would otherwise decorate their output for a terminal.
  env.NO_COLOR = "1";
  return env;
}
