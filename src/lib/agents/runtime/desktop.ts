import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createClaudeCodeControlAdapter } from "@/lib/agents/control/providers/claude-code/adapter";
import { createSdkClaudeRuntime } from "@/lib/agents/control/providers/claude-code/sdk-runtime";
import { ACP_PROVIDERS, launchEntryFor } from "@/lib/agents/launch/allowlist";
import { agentEnvironment } from "@/lib/agents/launch/env";
import {
  createNativeLoginSource,
  createNativeLoginState,
  withNativeAuthentication,
} from "@/lib/agents/launch/native-auth";
import {
  createAcpProcessLauncher,
  detectLocalProviders,
  resolveNativeExecutable,
  runNativeOperation,
} from "@/lib/agents/launch/process";
import { createSessionContextServer } from "@/lib/agents/session-context/http";
import { createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { allowDesktopExecution } from "./gate";
import { createRuntimeHost, LOCAL_ACTOR } from "./host";
import { isHandshakeCommand, parseRuntimeRequest, runtimeFailure } from "./protocol";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AcpLauncher } from "@/lib/agents/control/providers/acp/launcher";
import type { AgentControlAdapter } from "@/lib/agents/control/types";
import type { NativeLoginState } from "@/lib/agents/launch/native-auth";
import type { RuntimeHost } from "./host";
import type { ProviderDetection } from "./protocol";

/**
 * The packaged desktop app's agent runtime (Phase J.1).
 *
 * ## What this is
 *
 * The same `RuntimeHost` the web's local runtime uses, with the same control
 * service, broker, adapters and launch allowlist — wired for a process that is
 * not a web server. The Tauri shell starts it as a sidecar and talks to it
 * over its stdin/stdout, one JSON line per request, relaying for the webview.
 * No port is opened, so nothing on the machine or the network can reach it
 * except the app that started it.
 *
 * ## What differs from `server.ts`, and why
 *
 *   - **The gate is the desktop decision.** The process exists only because
 *     the desktop shell started it; see `allowDesktopExecution`.
 *   - **One actor.** A desktop app is one person's; there is no account
 *     partitioning to preserve between requests.
 *   - **Claude signs in with its own login.** No database, so no stored key:
 *     the user's installed Claude Code runs with its own login, which
 *     `claude auth login` establishes. See `launch/native-auth.ts`.
 *   - **Workspace context (Phase J.3).** An agent session started from a
 *     workspace queries it through TabDump's session MCP server, which this
 *     process serves on the loopback interface from the bounded snapshot the
 *     Command Centre sends — no account store needed. Closed with the runtime.
 *
 * `env` is passed in, never read here: the desktop entry reads the process
 * environment once and hands it over, which is what keeps "reads the real
 * environment in exactly one place" true of this directory.
 */

export type DesktopRuntimeOptions = {
  env: Readonly<Record<string, string | undefined>>;
  /** The Claude Agent SDK, imported by the entry so the bundler includes it. */
  loadClaudeSdk?: () => Promise<unknown>;
  runtimeId?: string;
  /* Seams for tests. Production passes none of these. */
  claudeLogin?: NativeLoginState;
  claudeExecutable?: string | null;
  acpLauncher?: (provider: AgentProviderId) => AcpLauncher;
  detect?: () => readonly ProviderDetection[];
  now?: () => number;
};

export type DesktopRuntime = {
  host: RuntimeHost;
  /** Parses and runs one request line, exactly as the web route does. */
  handle(request: unknown): Promise<unknown>;
  /** Ends every session and releases every agent process. Idempotent. */
  dispose(): Promise<void>;
};

const PROVIDERS: readonly AgentProviderId[] = ["claude-code", ...ACP_PROVIDERS];

export function createDesktopRuntime(options: DesktopRuntimeOptions): DesktopRuntime {
  const adapters = new Map<AgentProviderId, AgentControlAdapter>();

  function claudeAdapter(): AgentControlAdapter | undefined {
    const executable =
      options.claudeExecutable === undefined
        ? resolveNativeExecutable("claude-code", options.env)
        : options.claudeExecutable;
    if (!executable) return undefined;

    const login =
      options.claudeLogin ??
      createNativeLoginState({
        run: (operation, timeoutMs) =>
          runNativeOperation("claude-code", operation, { env: options.env, timeoutMs }),
      });

    const adapter = createClaudeCodeControlAdapter({
      runtime: createSdkClaudeRuntime({
        credentials: createNativeLoginSource(login),
        executablePath: executable,
        // Allowlisted: home, temp, PATH. No key of any kind.
        baseEnv: agentEnvironment(options.env),
        ...(options.loadClaudeSdk ? { loadModule: options.loadClaudeSdk } : {}),
      }),
      ...(options.now ? { now: options.now } : {}),
    });
    return withNativeAuthentication(adapter, "claude-code", login);
  }

  function acpAdapter(provider: AgentProviderId): AgentControlAdapter | undefined {
    const entry = launchEntryFor(provider)?.acp;
    if (!entry) return undefined;
    return createAcpControlAdapter({
      provider,
      launch: options.acpLauncher
        ? options.acpLauncher(provider)
        : createAcpProcessLauncher({ provider, env: options.env }),
      approval: entry.approval,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  function resolveAdapter(provider: AgentProviderId): AgentControlAdapter | undefined {
    const existing = adapters.get(provider);
    if (existing) return existing;
    const built = provider === "claude-code" ? claudeAdapter() : acpAdapter(provider);
    if (built) adapters.set(provider, built);
    return built;
  }

  const contextRegistry = createSessionContextRegistry({});
  const contextServer = createSessionContextServer({ registry: contextRegistry });

  const host = createRuntimeHost({
    gate: allowDesktopExecution(),
    sessionContext: { registry: contextRegistry, url: () => contextServer.url() },
    resolveAdapter: (provider) => resolveAdapter(provider),
    providers: PROVIDERS,
    detect: options.detect ?? (() => detectLocalProviders(options.env)),
    ...(options.runtimeId ? { runtimeId: options.runtimeId } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  let disposed: Promise<void> | undefined;

  return {
    host,

    async handle(request) {
      // The same three steps as the web route (app/api/agents/control):
      // parse strictly, check the caller is talking to *this* process, run.
      const parsed = parseRuntimeRequest(request);
      if (!parsed) return runtimeFailure("invalid_request");
      if (!isHandshakeCommand(parsed.command.name) && parsed.runtimeId !== host.runtimeId) {
        return runtimeFailure("runtime_disconnected");
      }
      return host.execute(LOCAL_ACTOR, parsed.command);
    },

    dispose() {
      disposed ??= (async () => {
        await host.dispose();
        // Every credential was revoked by the host; the listener goes too.
        await contextServer.close();
        for (const adapter of adapters.values()) adapter.dispose();
        adapters.clear();
      })();
      return disposed;
    },
  };
}
