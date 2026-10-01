import "server-only";
import { createCodexControlAdapter } from "@/lib/agents/control/providers/codex-app-server/adapter";
import { launchEntryFor } from "./allowlist";
import { createAppServerProcessLauncher, runAppServerLogin } from "./process";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AppServerLauncher, AppServerLogin } from "@/lib/agents/control/providers/codex-app-server/launcher";
import type { CodexControlAdapter } from "@/lib/agents/control/providers/codex-app-server/adapter";

/** A person is signing in in a browser. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The control adapter for an app-server agent (Codex), wired to the real
 * launcher — one definition for the web's local runtime and the desktop
 * sidecar alike. Everything provider-specific comes from the allowlist entry:
 * the launch, the sign-in methods, the platforms Hubble verified, and the
 * oldest version it verified.
 */
export function createLocalAppServerAdapter(
  provider: AgentProviderId,
  options: {
    env: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
    now?: () => number;
    /* Seams for tests. Production passes neither. */
    launch?: AppServerLauncher;
    login?: AppServerLogin;
  }
): CodexControlAdapter | undefined {
  const entry = launchEntryFor(provider)?.appServer;
  if (!entry) return undefined;
  const platform = options.platform ?? process.platform;
  return createCodexControlAdapter({
    provider,
    launch: options.launch ?? createAppServerProcessLauncher({ provider, env: options.env, platform }),
    login:
      options.login ??
      ((methodId) => runAppServerLogin(provider, methodId, { provider, env: options.env, platform, timeoutMs: LOGIN_TIMEOUT_MS })),
    loginMethods: Object.entries(entry.loginLabels).map(([id, name]) => ({ id, name })),
    platformVerified: entry.verifiedPlatforms.includes(platform),
    minimumVersion: entry.minimumVersion,
    ...(options.now ? { now: options.now } : {}),
  });
}
