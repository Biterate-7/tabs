import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeCodeControlAdapter } from "@/lib/agents/control/providers/claude-code/adapter";
import { createSdkClaudeRuntime } from "@/lib/agents/control/providers/claude-code/sdk-runtime";
import { decideServerRuntime } from "@/lib/agents/control/runtime";
import { assertLocalExecutionAllowed } from "./gate";
import { createRuntimeHost } from "./host";
import type { AgentControlAdapter } from "@/lib/agents/control/types";
import type { RuntimeActor, RuntimeHost } from "./host";
import type { AuthorizedProjectInput, SequencedControlEvent } from "./protocol";

/**
 * The whole stack, for real.
 *
 * ## What this covers that nothing else can
 *
 * Every other suite in this module drives the host against a scripted
 * adapter. That proves the *runtime's* behaviour and cannot prove the one
 * thing Phase F is ultimately for: that a command arriving at the local
 * execution surface reaches an actual Claude Code process, and that what
 * comes back is correlated, sequenced and attributable.
 *
 *     command  →  host  →  ControlService  →  Claude adapter  →  SDK  →  Claude
 *
 * The provider's own session id, in particular, is something only a real
 * provider can supply, and correlation is built on it.
 *
 * ## Opt-in, and why it must be
 *
 * This spawns Claude Code, spends the developer's own quota and needs their
 * authentication. It is skipped unless **both** are set:
 *
 * ```
 * TABDUMP_CLAUDE_INTEGRATION=1
 * TABDUMP_LOCAL_AGENT_RUNTIME=i-am-running-tabdump-on-my-own-machine
 * ```
 *
 * The second is the product's own execution gate rather than a switch
 * invented here, so this suite cannot run anywhere TabDump itself would
 * refuse to execute.
 *
 * ## What "verified" means in each test below
 *
 * Kept deliberately separate, because they are different claims:
 *
 *   - **runtime verified** — a Claude process started and the SDK accepted
 *     what TabDump sent it. Provable without a model turn.
 *   - **authenticated model turn verified** — Claude answered. Needs credit
 *     and credentials, and is the only thing that proves the whole path.
 *   - **cancellation verified** — the interrupt reached the provider.
 *
 * Each test's name says which one it is making.
 */

const ENABLED =
  process.env.TABDUMP_CLAUDE_INTEGRATION === "1" && decideServerRuntime(process.env).allowed;

const describeLocal = ENABLED ? describe : describe.skip;

/** Generous: a real model turn on a cold process. */
const TURN_TIMEOUT_MS = 180_000;

const ACTOR: RuntimeActor = { id: "account:integration" };

describeLocal("the local execution surface, against real Claude Code", () => {
  let root: string;
  let project: AuthorizedProjectInput;
  let adapter: AgentControlAdapter;
  let host: RuntimeHost;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "tabdump-runtime-"));
    await writeFile(path.join(root, "NOTES.md"), "# Notes\n\nnothing yet\n", "utf8");

    project = {
      id: "p-int",
      name: "Integration",
      path: root,
      providers: ["claude-code"],
      additionalDirectories: [],
      // Read only. A suite that could write would be a suite that could
      // damage a developer's machine on a bad day, and nothing here needs it.
      permissions: { scopes: ["read_project"], projectId: "p-int", grantedAt: Date.now() },
    };

    adapter = createClaudeCodeControlAdapter({ runtime: createSdkClaudeRuntime() });
    await adapter.connect();
  });

  afterEach(async () => {
    // Between tests, not only at the end: a leaked provider process would
    // otherwise be attributed to whichever test ran next.
    await host?.dispose();
  });

  afterAll(async () => {
    adapter?.dispose();
    if (!root) return;

    // A Claude process holding a handle inside the directory makes `rm` fail
    // with EBUSY on Windows even after dispose resolves. Retried rather than
    // ignored, and a cleanup failure must not fail the suite.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  });

  function build(): RuntimeHost {
    host = createRuntimeHost({
      // The product's own gate, reading the real environment. If this refuses,
      // the suite is not running.
      gate: assertLocalExecutionAllowed(process.env),
      resolveAdapter: (provider) => (provider === "claude-code" ? adapter : undefined),
      providers: ["claude-code"],
    });
    return host;
  }

  async function startSession(runtime: RuntimeHost) {
    const authorized = await runtime.execute(ACTOR, {
      name: "authorize_projects",
      projects: [project],
    });
    expect(authorized.ok && authorized.value.accepted).toEqual(["p-int"]);

    const started = await runtime.execute(ACTOR, {
      name: "create_session",
      provider: "claude-code",
      projectId: "p-int",
      title: "Integration",
    });

    if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
    return started.value;
  }

  /** Waits until the journal holds an event the predicate accepts, or gives up. */
  async function waitFor(
    runtime: RuntimeHost,
    sessionId: string,
    predicate: (event: SequencedControlEvent) => boolean,
    timeoutMs = TURN_TIMEOUT_MS
  ): Promise<SequencedControlEvent> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const read = runtime.journal.read(sessionId);
      const found = read.events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out; saw: ${read.events.map((event) => event.kind).join(", ") || "nothing"}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  it(
    "runtime verified: a command starts a real provider process inside the authorized project",
    async () => {
      const runtime = build();
      const view = await startSession(runtime);

      expect(view.status).toBe("ready");
      expect(view.projectId).toBe("p-int");
      // A run exists the moment the session does, and the adapter was bound
      // to it — which is what makes every event it emits attributable.
      expect(view.activeRunId).toBeTruthy();

      // The path stayed on the server's side. The view names the project by
      // id and carries no directory.
      expect(JSON.stringify(view)).not.toContain(root);
    },
    TURN_TIMEOUT_MS
  );

  it(
    "authenticated model turn verified: a message reaches Claude and comes back sequenced and correlated",
    async () => {
      const runtime = build();
      const view = await startSession(runtime);

      const sent = await runtime.execute(ACTOR, {
        name: "send_message",
        sessionId: view.sessionId,
        text: "Reply with exactly the word ACKNOWLEDGED and nothing else.",
      });
      expect(sent.ok).toBe(true);

      await waitFor(runtime, view.sessionId, (event) => event.kind === "message_received");

      const events = runtime.journal.read(view.sessionId).events;

      // Ordering: assigned by this runtime, contiguous, and starting at 1.
      expect(events.map((event) => event.sequence)).toEqual(
        events.map((_, index) => index + 1)
      );

      // Attribution: every event carries the run the session was bound to.
      expect(events.every((event) => event.runId === view.activeRunId)).toBe(true);

      // Correlation: the provider's own session id arrived on the stream and
      // was recorded on both the session and the registry.
      const session = await runtime.execute(ACTOR, {
        name: "get_session",
        sessionId: view.sessionId,
      });
      const providerSessionId = session.ok
        ? session.value.session.providerSessionId
        : undefined;

      expect(providerSessionId).toBeTruthy();
      expect(runtime.correlations.controlRunFor("claude-code", providerSessionId!)).toBe(
        view.activeRunId
      );

      // And with a provider identity plus an adapter that can resume, the
      // session reports itself resumable — the claim a reconnecting UI acts on.
      expect(session.ok && session.value.session.resumable).toBe(true);
    },
    TURN_TIMEOUT_MS
  );

  it(
    "cancellation verified: an interrupt reaches the provider rather than only the record",
    async () => {
      const runtime = build();
      const view = await startSession(runtime);

      await runtime.execute(ACTOR, {
        name: "send_message",
        sessionId: view.sessionId,
        // Long enough that the turn is genuinely in flight when the interrupt
        // lands. The point is the interrupt, not the essay.
        text: "Count slowly from 1 to 200, writing each number on its own line.",
      });

      await waitFor(
        runtime,
        view.sessionId,
        (event) => event.kind === "thinking" || event.kind === "message_received",
        60_000
      );

      const cancelled = await runtime.execute(ACTOR, {
        name: "cancel_run",
        sessionId: view.sessionId,
      });

      expect(cancelled.ok).toBe(true);
      expect(cancelled.ok && cancelled.value.status).toBe("cancelled");
      expect(cancelled.ok && cancelled.value.activeRunId).toBeUndefined();

      // The provider stopped talking. If the interrupt had only changed a
      // status, events would keep arriving.
      const after = runtime.journal.read(view.sessionId).latestSequence;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(runtime.journal.read(view.sessionId).latestSequence).toBe(after);
    },
    TURN_TIMEOUT_MS
  );

  it(
    "runtime verified: two simultaneous sessions do not cross-contaminate",
    async () => {
      const runtime = build();

      await runtime.execute(ACTOR, { name: "authorize_projects", projects: [project] });

      const a = await runtime.execute(ACTOR, {
        name: "create_session",
        provider: "claude-code",
        projectId: "p-int",
      });
      const b = await runtime.execute(ACTOR, {
        name: "create_session",
        provider: "claude-code",
        projectId: "p-int",
      });
      if (!a.ok || !b.ok) throw new Error("start failed");

      expect(a.value.sessionId).not.toBe(b.value.sessionId);
      expect(a.value.activeRunId).not.toBe(b.value.activeRunId);

      await runtime.execute(ACTOR, {
        name: "send_message",
        sessionId: a.value.sessionId,
        text: "Reply with exactly the word ALPHA.",
      });

      await waitFor(runtime, a.value.sessionId, (event) => event.kind === "message_received");

      // B was never spoken to, so nothing of A's turn may appear on its
      // stream. Two real provider processes, two separate journals.
      expect(runtime.journal.read(b.value.sessionId).events).toEqual([]);
      expect(
        runtime.journal
          .read(a.value.sessionId)
          .events.every((event) => event.sessionId === a.value.sessionId)
      ).toBe(true);
    },
    TURN_TIMEOUT_MS
  );

  it(
    "cleanup verified: disposing the host leaves no provider session behind",
    async () => {
      const runtime = build();
      const view = await startSession(runtime);

      await runtime.dispose();

      // The session is gone from the runtime's own view, and the adapter was
      // told to cancel before it was forgotten.
      const listed = await runtime.execute(ACTOR, { name: "list_sessions" });
      expect(listed.ok && listed.value.sessions).toEqual([]);
      expect(runtime.journal.read(view.sessionId).events).toEqual([]);
    },
    TURN_TIMEOUT_MS
  );
});
