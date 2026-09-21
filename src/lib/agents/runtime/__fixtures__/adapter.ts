import { capabilitySet } from "@/lib/agents/control/capabilities";
import { createUnimplementedControlAdapter } from "@/lib/agents/control/unimplemented";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AdapterApprovalDetails } from "@/lib/agents/control/approval-details";
import type { AgentCapabilitySet } from "@/lib/agents/control/capabilities";
import type { AgentMessageInput } from "@/lib/agents/control/context";
import type { AgentControlEvent } from "@/lib/agents/control/events";
import type {
  AgentControlAdapter,
  ControlEventListener,
  ControlResult,
  ControlStatus,
  CreateSessionRequest,
  ResumeSessionRequest,
  SessionHandle,
} from "@/lib/agents/control/types";

/**
 * A scriptable control adapter.
 *
 * ## Why this rather than a mock
 *
 * It is a real implementation of the real `AgentControlAdapter` contract,
 * including the two optional accessors the runtime uses for correlation. That
 * matters more here than in most fixtures: the host's whole job is to drive
 * *some* adapter correctly, and a `vi.mock` of one would prove the host works
 * against a shape nothing else has. Everything below behaves the way the
 * Claude adapter behaves — it captures a provider session id, it holds an
 * approval open until answered, it emits through a subscription — so a
 * lifecycle exercised here is a lifecycle the production path also has.
 *
 * It spawns nothing, touches no filesystem and needs no authentication.
 */

export const FIXTURE_CAPABILITIES: AgentCapabilitySet = capabilitySet(
  "message",
  "create_session",
  "resume_session",
  "cancel_run",
  "stream_events",
  "read_files",
  "write_files",
  "run_commands",
  "approvals",
  "working_directory"
);

export type ScriptedAdapter = AgentControlAdapter & {
  /** Every operation that reached the adapter, in order. */
  calls: string[];
  /** Emits an event as if the provider had produced it. */
  emit(event: Partial<AgentControlEvent> & { sessionId: string; kind: AgentControlEvent["kind"] }): void;
  /** Sets the provider's own id for a live session, as the first frame would. */
  revealProviderSession(sessionId: string, providerSessionId: string): void;
  /** Stages the detail the adapter will report for the next approval it raises. */
  stageApproval(approvalId: string, details: AdapterApprovalDetails): void;
  /** How an approval was answered, once the service has told the adapter. */
  answered(approvalId: string): "granted" | "denied" | undefined;
  /** Run ids the adapter has been bound to, by session. */
  boundRun(sessionId: string): string | undefined;
  /** Sessions the adapter still holds. Empty after a clean teardown. */
  live(): string[];
  /** The last message that reached the adapter, for asserting what was actually said. */
  lastMessage(): AgentMessageInput | undefined;
};

export type ScriptedAdapterOptions = {
  provider?: AgentProviderId;
  capabilities?: AgentCapabilitySet;
  /** Makes `createSession` fail, for the startup-error path. */
  failCreate?: ControlResult<SessionHandle>;
  /** Reports a provider session id the moment a session is created, as a resume does. */
  providerSessionIdOnCreate?: string;
  now?: () => number;
};

export function createScriptedAdapter(options: ScriptedAdapterOptions = {}): ScriptedAdapter {
  const provider = options.provider ?? "claude-code";
  const now = options.now ?? (() => 1_700_000_000_000);

  const calls: string[] = [];
  const listeners = new Set<ControlEventListener>();
  const sessions = new Map<string, { providerSessionId?: string; runId?: string }>();
  const staged = new Map<string, AdapterApprovalDetails>();
  let lastMessage: AgentMessageInput | undefined;
  const answers = new Map<string, "granted" | "denied">();

  const base = createUnimplementedControlAdapter({ provider, detail: "fixture" });
  let status: ControlStatus = { kind: "connected", since: now() };

  function fire(event: AgentControlEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  const adapter: ScriptedAdapter = {
    ...base,
    calls,

    getCapabilities: () => options.capabilities ?? FIXTURE_CAPABILITIES,
    getConnectionStatus: () => status,

    async connect() {
      calls.push("connect");
      status = { kind: "connected", since: now() };
      return { ok: true, value: status };
    },

    async disconnect() {
      calls.push("disconnect");
      sessions.clear();
      status = { kind: "disconnected", since: now() };
    },

    async createSession(request: CreateSessionRequest) {
      calls.push("createSession");
      if (options.failCreate) return options.failCreate;

      sessions.set(request.sessionId, {
        ...(options.providerSessionIdOnCreate
          ? { providerSessionId: options.providerSessionIdOnCreate }
          : {}),
      });

      const handle: SessionHandle = { sessionId: request.sessionId, status: "ready" };
      if (options.providerSessionIdOnCreate) {
        handle.providerSessionId = options.providerSessionIdOnCreate;
      }
      return { ok: true, value: handle };
    },

    async resumeSession(request: ResumeSessionRequest) {
      calls.push("resumeSession");
      sessions.set(request.sessionId, { providerSessionId: request.providerSessionId });
      return {
        ok: true,
        value: {
          sessionId: request.sessionId,
          providerSessionId: request.providerSessionId,
          status: "ready",
        },
      };
    },

    async sendMessage(message) {
      calls.push("sendMessage");
      lastMessage = message;
      return sessions.has(message.sessionId)
        ? { ok: true, value: undefined }
        : { ok: false, error: { code: "invalid-session", message: "no session" } };
    },

    async cancelRun(sessionId) {
      calls.push("cancelRun");
      if (!sessions.has(sessionId)) {
        return { ok: false, error: { code: "invalid-session", message: "no session" } };
      }
      // Reaches the "provider": the session stops being live here, which is
      // what a caller checking `live()` after a cancel is asserting about.
      sessions.delete(sessionId);
      return { ok: true, value: undefined };
    },

    async respondToApproval(approvalId, decision) {
      calls.push("respondToApproval");
      answers.set(approvalId, decision);
      staged.delete(approvalId);
      return { ok: true, value: undefined };
    },

    subscribeToEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      calls.push("dispose");
      sessions.clear();
      listeners.clear();
    },

    emit(partial) {
      fire({
        id: `e-${calls.length}-${Math.random().toString(36).slice(2, 8)}`,
        provider,
        timestamp: now(),
        summary: "event",
        ...partial,
      } as AgentControlEvent);
    },

    revealProviderSession(sessionId, providerSessionId) {
      const session = sessions.get(sessionId);
      if (session) session.providerSessionId = providerSessionId;
    },

    stageApproval(approvalId, details) {
      staged.set(approvalId, details);
    },

    answered: (approvalId) => answers.get(approvalId),

    boundRun: (sessionId) => sessions.get(sessionId)?.runId,

    live: () => [...sessions.keys()],

    lastMessage: () => lastMessage,

    // The two optional accessors the runtime correlates through, and the
    // approval detail accessor the service mints broker records from.
    takeApprovalDetails: (approvalId: string) => staged.get(approvalId),
    providerSessionIdFor: (sessionId: string) => sessions.get(sessionId)?.providerSessionId,
    bindRun: (sessionId: string, runId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.runId = runId;
    },
  } as ScriptedAdapter;

  return adapter;
}
