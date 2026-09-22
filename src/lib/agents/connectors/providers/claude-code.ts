import { createClaudeCodeAdapter } from "@/lib/agents/claude-code/adapter";
import {
  CLAUDE_CODE_AGENT_NAME,
  CLAUDE_CODE_PROVIDER,
  CLAUDE_POLL_INTERVAL_MS,
} from "@/lib/agents/claude-code/types";
import { attemptKind, createConnectorCore } from "../base";
import { connectorError, NO_CAPABILITIES } from "../types";
import type { ClaudeCodeAdapter, ClaudeCodeAdapterOptions } from "@/lib/agents/claude-code/adapter";
import type { ClaudeDiscoveredSession } from "@/lib/agents/claude-code/types";
import type { ConnectorUnsubscribe } from "../types";
import type { AgentConnector, ProviderDescriptor } from "../types";

/**
 * Claude Code as a connector.
 *
 * This is a **wrapper, not a second integration**. Discovery, transcript
 * parsing, normalisation, path handling, the cursor and the poll loop all
 * remain in `src/lib/agents/claude-code/`, exactly where Phase 12 put them,
 * and this file adds only what the connector layer is for: identity,
 * capabilities, connection state and lifecycle. If observing Claude Code ever
 * needs to change, it changes there and this file does not move.
 *
 * The capability declaration below is the honest one, verified against what
 * the existing pipeline actually produces rather than against what Claude
 * Code could theoretically report:
 *
 *   runs         session registry entries become runs
 *   events       tool invocations become bounded activity summaries
 *   files        structured `file_path` inputs become project-relative paths
 *   artifacts    those files ARE the artifacts — Phase 13's WorkArtifact
 *   workItems    TaskCreate/TaskUpdate become work items
 *   liveUpdates  a poll loop, not a socket, but genuinely live
 *
 * `liveUpdates` is true for polling on purpose: the capability asks whether a
 * consumer will learn about a run while it is still going, and it will. The
 * only push channel Claude Code exposes is its messaging socket, which is a
 * *control* channel and is dropped at the reader precisely so that nothing
 * downstream can reach it.
 */

export const CLAUDE_CODE_DESCRIPTOR: ProviderDescriptor = {
  provider: "claude-code",
  displayName: CLAUDE_CODE_AGENT_NAME,
  /**
   * Both planes, named as two things because they are two things.
   *
   * The previous sentence — "Observes Claude Code sessions running on this
   * machine" — described this connector exactly, and still does: everything
   * below it is observation, and observation genuinely cannot act. What made
   * it misleading after Phase I is not that it was wrong but that it was the
   * *only* thing the page said, so a reader concluded observation was all
   * TabDump could do with Claude Code.
   *
   * So the summary names the control plane without claiming this object
   * implements it. Whether control is actually available here is a runtime
   * question with a real answer — `get_status` — and the command centre is
   * where it is answered; a connector descriptor is a static string and must
   * not pretend to know.
   */
  summary:
    "Watches Claude Code sessions on this machine, and runs Claude Code in TabDump project environments.",
  capabilities: {
    ...NO_CAPABILITIES,
    runs: true,
    events: true,
    files: true,
    artifacts: true,
    workItems: true,
    liveUpdates: true,
  },
};

/**
 * The sentence shown when no local installation is visible.
 *
 * Says what is true and what would change it. A hosted deployment reads
 * `~/.claude` on the server — which is either absent or belongs to the
 * deployment, not to the person looking at the page — so the honest answer
 * there is the same as on a machine that has never run Claude Code.
 */
const UNAVAILABLE_DETAIL =
  "No local Claude Code installation is visible from here. TabDump watches Claude Code by reading the session files it writes on your own machine — and can still run Claude Code for you in a TabDump project environment, which needs nothing installed.";

export type ClaudeCodeConnector = AgentConnector & {
  /** Sessions seen on the most recent poll, for the project-mapping UI. */
  getSessions(): ClaudeDiscoveredSession[];
  /** Polls immediately rather than waiting for the next tick. */
  refresh(): Promise<void>;
  /** How often this connector expects to deliver, for health derivation. */
  readonly expectedIntervalMs: number;
};

export type ClaudeCodeConnectorOptions = {
  /** Passed through to the Phase 12 adapter. Tests inject a fetch and a scheduler here. */
  adapterOptions?: ClaudeCodeAdapterOptions;
  now?: () => number;
};

export function createClaudeCodeConnector(
  options: ClaudeCodeConnectorOptions = {}
): ClaudeCodeConnector {
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.adapterOptions?.intervalMs ?? CLAUDE_POLL_INTERVAL_MS;

  const core = createConnectorCore({
    provider: CLAUDE_CODE_PROVIDER,
    initialKind: "disconnected",
    now,
  });

  let sessions: ClaudeDiscoveredSession[] = [];

  /**
   * The adapter subscription, held so it can be torn down.
   *
   * Non-null exactly while this connector is connected, which makes it the
   * single source of truth for "are we running" — there is no second boolean
   * that could disagree with it.
   */
  let subscription: ConnectorUnsubscribe | null = null;

  /**
   * Resolved by the first poll after a connect, so `connect()` settles into a
   * real state instead of handing back "Connecting…".
   *
   * Needed because the adapter's own `refresh()` is a no-op while a poll is
   * already in flight — and one always is, since subscribing starts one. So
   * the connect path waits for the poll that subscribing kicked off rather
   * than trying to force another.
   */
  let awaitingFirstPoll: (() => void) | null = null;

  /**
   * The adapter is built once, when the connector is, but it does nothing
   * until something subscribes — that is where its poll loop starts. So
   * construction is free, and a connector that is listed in settings but
   * never connected costs one object and no timers.
   */
  const adapter: ClaudeCodeAdapter = createClaudeCodeAdapter({
    ...options.adapterOptions,
    onPoll: (polled) => {
      sessions = polled.sessions;

      // The poll result is the connection's own health signal: the same
      // request that looks for sessions is the one that proves the local
      // installation is readable. A separate probe would be a second read of
      // the user's machine to learn something this one already knows.
      if (!core.isDisposed() && (subscription || awaitingFirstPoll)) {
        if (polled.available) {
          core.setStatus("connected", { error: null, detail: null });
        } else {
          // Not an error. "No Claude Code here" is a correct, stable answer
          // for a hosted deployment or a machine that has never run it, and
          // reporting it as a failure would send the user looking for a fault
          // that does not exist.
          core.setStatus("unavailable", { error: null, detail: UNAVAILABLE_DETAIL });
        }
      }

      awaitingFirstPoll?.();
      awaitingFirstPoll = null;

      options.adapterOptions?.onPoll?.(polled);
    },
  });

  return {
    provider: "claude-code",
    descriptor: CLAUDE_CODE_DESCRIPTOR,
    expectedIntervalMs: intervalMs,

    getStatus: () => core.getStatus(),
    getSessions: () => sessions,

    async connect() {
      if (core.isDisposed()) return core.getStatus();

      // Already running. Connecting twice must not start a second poll loop
      // against the user's machine.
      if (subscription) return core.getStatus();

      core.setStatus(attemptKind(core), { error: null, detail: null });

      // Ordered deliberately: the waiter is armed before subscribing, because
      // subscribing starts a poll immediately and that poll is the one being
      // waited for.
      const settled = new Promise<void>((resolve) => {
        awaitingFirstPoll = resolve;
      });

      try {
        subscription = adapter.subscribe((observations) => core.emit(observations));
        await settled;
      } catch {
        // The adapter swallows its own fetch failures and reports them
        // through `onPoll`; reaching here means something unexpected. The
        // code is all that is recorded — never the caught value, which could
        // carry provider text.
        awaitingFirstPoll = null;
        core.setStatus("error", { error: connectorError("unreachable") });
      }

      return core.getStatus();
    },

    disconnect() {
      // Dropping the subscription is what stops the timer: the adapter runs
      // its loop only while it has subscribers, so there is no separate
      // "stop" to forget to call.
      subscription?.();
      subscription = null;
      // Releases a connect() still waiting on a poll, so disconnecting during
      // a slow connect cannot leave a promise pending forever.
      awaitingFirstPoll?.();
      awaitingFirstPoll = null;
      sessions = [];
      core.setStatus("disconnected", { error: null, detail: null });
    },

    subscribe: (observer) => core.subscribe(observer),
    watchStatus: (listener) => core.watchStatus(listener),
    refresh: () => adapter.refresh(),

    dispose() {
      subscription?.();
      subscription = null;
      awaitingFirstPoll?.();
      awaitingFirstPoll = null;
      sessions = [];
      core.dispose();
    },
  };
}
