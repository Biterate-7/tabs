import { platformProvider } from "./catalog";
import { grantWithinApproval } from "./roster";
import { runtimeFailure } from "@/lib/agents/runtime/protocol";
import type { PlatformProvider } from "./catalog";
import type { AgentIdentity } from "./roster";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentCapability } from "@/lib/agents/control/capabilities";
import type { AgentAttachedContext } from "@/lib/agents/control/context";
import type { AgentPermissionScope } from "@/lib/agents/control/permissions";
import type { RuntimeClient } from "@/lib/agents/runtime/client";
import type {
  ProviderConnectionView,
  ProviderDetection,
  RuntimeProviderStatus,
  RuntimeResult,
  RuntimeSessionView,
} from "@/lib/agents/runtime/protocol";

/**
 * The provider-neutral agent connector (Phase J).
 *
 * ## Why this is not called `AgentConnector`
 *
 * That name belongs to the observation plane (../connectors/types.ts): the
 * read-only interface whose guard suites fail the build if it grows a verb.
 * This one has verbs — connect, sign in, start a session, send a message — so
 * it is a different interface with a different name, and the two cannot be
 * confused in an import.
 *
 * ## One implementation, every provider
 *
 * `createPlatformConnector` is the *only* implementation. It speaks to the
 * runtime through the typed command client, and the runtime holds the
 * provider adapters — Claude's SDK adapter, the one ACP adapter that drives
 * Gemini, Codex and Grok. So "a provider adapter" is a server-side control
 * adapter plus a catalogue entry, and this file never changes when one is
 * added. There is no Claude connector, Codex connector or Gemini connector.
 *
 * ## What it cannot do
 *
 * Name a binary, a path, an argument or a credential. Every method maps to one
 * command in `runtime/protocol.ts`, whose parser drops anything the closed
 * union does not name. A connector for the custom MCP provider has nothing to
 * connect to in the runtime at all — TabDump never starts that agent — and
 * every runtime method on it answers `unsupported`.
 */
export interface AgentPlatformConnector {
  readonly provider: PlatformProvider;

  /** Is it installed on this machine? `undefined` when the runtime cannot say (not local). */
  detect(): Promise<ProviderDetection | undefined>;

  /** Reaches the agent and learns how it signs in. Starts no session. */
  connect(): Promise<RuntimeResult<ProviderConnectionView>>;

  /** Runs the agent's own sign-in for one method it advertised. */
  authenticate(methodId: string): Promise<RuntimeResult<ProviderConnectionView>>;

  /** Starts a session, associated with a workspace, in an authorized project. */
  createSession(input: {
    agent: AgentIdentity;
    projectId?: string;
    /** The project's granted scopes, checked against what the agent was approved for. */
    projectScopes?: readonly AgentPermissionScope[];
    workspaceId?: string;
    title?: string;
    context?: AgentAttachedContext;
  }): Promise<RuntimeResult<RuntimeSessionView>>;

  sendMessage(
    sessionId: string,
    text: string,
    context?: AgentAttachedContext
  ): Promise<RuntimeResult<RuntimeSessionView>>;

  /** The runtime's current report on this provider. */
  status(): Promise<RuntimeProviderStatus | undefined>;

  /** What the provider's adapter declares it implements today. */
  capabilities(): Promise<readonly AgentCapability[]>;

  /** Ends this user's sessions with the agent and releases the connection. */
  disconnect(): Promise<RuntimeResult<ProviderConnectionView>>;
}

export function createPlatformConnector(
  provider: AgentProviderId,
  client: RuntimeClient
): AgentPlatformConnector {
  const spec = platformProvider(provider);
  if (!spec) throw new Error("unknown provider");

  /** TabDump never starts an MCP client, so nothing in the runtime is its to call. */
  const runtimeReachable = spec.transport !== "mcp";

  async function status(): Promise<RuntimeProviderStatus | undefined> {
    if (!runtimeReachable) return undefined;
    const reply = await client.status();
    return reply.ok ? reply.value.providers.find((entry) => entry.provider === provider) : undefined;
  }

  return {
    provider: spec,

    async detect() {
      if (!runtimeReachable) return undefined;
      const reply = await client.send({ name: "detect_providers" });
      if (!reply.ok || !reply.value.thisMachine) return undefined;
      return reply.value.detections.find((entry) => entry.provider === provider);
    },

    connect() {
      if (!runtimeReachable) return Promise.resolve(runtimeFailure("unsupported"));
      return client.send({ name: "connect_provider", provider });
    },

    authenticate(methodId) {
      if (!runtimeReachable) return Promise.resolve(runtimeFailure("unsupported"));
      return client.send({ name: "authenticate_provider", provider, methodId });
    },

    async createSession(input) {
      if (!runtimeReachable || !spec.chat) return runtimeFailure("unsupported");
      // The agent must be the one this connector is for, and must not be
      // started somewhere that grants more than the user approved it for.
      if (input.agent.provider !== provider) return runtimeFailure("invalid_request");
      if (input.projectScopes && !grantWithinApproval(input.agent, input.projectScopes)) {
        return runtimeFailure("permission_denied");
      }
      return client.send({
        name: "create_session",
        provider,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.context ? { context: input.context } : {}),
      });
    },

    sendMessage(sessionId, text, context) {
      if (!runtimeReachable) return Promise.resolve(runtimeFailure("unsupported"));
      return client.send({ name: "send_message", sessionId, text, ...(context ? { context } : {}) });
    },

    status,

    async capabilities() {
      return (await status())?.capabilities ?? [];
    },

    disconnect() {
      if (!runtimeReachable) return Promise.resolve(runtimeFailure("unsupported"));
      return client.send({ name: "disconnect_provider", provider });
    },
  };
}
