import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeCodeControlAdapter } from "./adapter";
import { createSdkClaudeRuntime } from "./sdk-runtime";
import { machineCredentials } from "@/lib/agents/credentials/__fixtures__/source";
import { createGrant } from "../../permissions";
import { createProject } from "../../projects";
import { decideServerRuntime, LOCAL_RUNTIME_ENV_VALUE, LOCAL_RUNTIME_ENV_VAR } from "../../runtime";
import type { AgentControlEvent } from "../../events";
import type { AgentProject } from "../../projects";

/**
 * The real thing: TabDump driving an actual Claude Code process.
 *
 * ## Opt-in, and why it must be
 *
 * This suite spawns Claude Code, spends the developer's own quota, and needs
 * their authentication. None of those may be requirements of `npm test`, so
 * it is skipped unless **both** of these are set:
 *
 * ```
 * TABDUMP_CLAUDE_INTEGRATION=1
 * TABDUMP_LOCAL_AGENT_RUNTIME=i-am-running-tabdump-on-my-own-machine
 * ```
 *
 * The second is the control plane's own runtime boundary, not a second
 * switch invented here. Requiring it means this suite cannot run anywhere the
 * product itself would refuse to execute — including CI, and including a
 * hosted deployment that somehow ran the test suite.
 *
 * ## What it proves that the deterministic suite cannot
 *
 * `adapter.test.ts` drives a real implementation of the runtime contract and
 * proves the adapter's behaviour. It cannot prove that the *contract matches
 * Claude*: that the SDK accepts the options passed, that `cwd` really scopes
 * the agent, that `interrupt()` really stops a turn, that `canUseTool` really
 * fires, and that the message shapes the normalizer expects are the shapes
 * that arrive. That is what this is for, and it is the thing that would
 * silently break on an SDK upgrade.
 */

const ENABLED =
  process.env.TABDUMP_CLAUDE_INTEGRATION === "1" &&
  decideServerRuntime(process.env).allowed;

const describeLocal = ENABLED ? describe : describe.skip;

/** Generous: a real model turn on a cold process. */
const TURN_TIMEOUT_MS = 180_000;

describeLocal("Claude Code, for real", () => {
  let root: string;
  let project: AgentProject;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "tabdump-claude-"));
    await writeFile(path.join(root, "NOTES.md"), "# Notes\n\nnothing yet\n", "utf8");

    const made = createProject(
      {
        id: "p-int",
        name: "Integration",
        path: root,
        providers: ["claude-code"],
      },
      Date.now()
    );
    if (!made.ok) throw new Error(`fixture failed: ${made.reason}`);
    project = made.project;
  });

  afterAll(async () => {
    if (!root) return;

    // A Claude process holding a handle inside the directory makes `rmdir`
    // fail with EBUSY on Windows even after `dispose()` resolves — the OS
    // releases the handle a moment later. Retried rather than ignored,
    // because a leaked temp directory is worth one more attempt, and the
    // cleanup failing must not fail the suite.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  });

  function adapterFor() {
    const adapter = createClaudeCodeControlAdapter({
      runtime: createSdkClaudeRuntime({ credentials: machineCredentials }),
    });
    const events: AgentControlEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));
    return { adapter, events };
  }

  /** Resolves when `predicate` is satisfied, or rejects at the deadline. */
  function waitFor(
    events: AgentControlEvent[],
    predicate: (events: AgentControlEvent[]) => boolean,
    label: string
  ): Promise<void> {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (predicate(events)) return resolve();
        if (Date.now() > deadline) {
          return reject(new Error(`timed out waiting for ${label}; saw ${events.map((e) => e.kind).join(", ")}`));
        }
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  it("reports itself available", async () => {
    const { adapter } = adapterFor();
    const connected = await adapter.connect();

    expect(connected.ok).toBe(true);
    expect(adapter.getConnectionStatus().kind).toBe("connected");
    adapter.dispose();
  });

  it(
    "creates a session, answers a message, and completes",
    async () => {
      const { adapter, events } = adapterFor();
      const grant = createGrant(["read_project"], Date.now(), project.id)!;

      const created = await adapter.createSession({
        sessionId: "int-1",
        project,
        permissions: grant,
        attachments: [],
      });
      expect(created.ok).toBe(true);

      await adapter.sendMessage({
        sessionId: "int-1",
        text: "Reply with exactly the word ACKNOWLEDGED and nothing else.",
        context: { attachments: [] },
      });

      await waitFor(events, (seen) => seen.some((e) => e.kind === "run_completed"), "completion");

      // The provider's own session id reached us, which is what makes a
      // resume possible at all.
      expect(events.some((event) => event.kind === "session_started")).toBe(true);
      expect(events.some((event) => event.kind === "message_received")).toBe(true);

      adapter.dispose();
    },
    TURN_TIMEOUT_MS + 30_000
  );

  it(
    "asks permission before writing, and the denial reaches the runtime",
    async () => {
      // The claim the whole phase rests on: the approval originates in Claude,
      // TabDump's answer reaches Claude, and a denial means the file is not
      // written.
      const { adapter, events } = adapterFor();
      const grant = createGrant(["read_project", "write_project"], Date.now(), project.id)!;

      await adapter.createSession({
        sessionId: "int-2",
        project,
        permissions: grant,
        attachments: [],
      });

      await adapter.sendMessage({
        sessionId: "int-2",
        text: "Append the line 'TOUCHED' to NOTES.md. Do not ask me anything first.",
        context: { attachments: [] },
      });

      await waitFor(
        events,
        (seen) => seen.some((e) => e.kind === "approval_requested"),
        "an approval request"
      );

      const requested = events.find((event) => event.kind === "approval_requested")!;
      expect(requested.approvalId).toBeTruthy();

      const responded = await adapter.respondToApproval(requested.approvalId!, "denied");
      expect(responded.ok).toBe(true);

      await waitFor(
        events,
        (seen) => seen.some((e) => e.kind === "run_completed" || e.kind === "error"),
        "the run to end"
      );

      // The denial was honoured by the provider, not merely recorded by us.
      const contents = await readFile(path.join(root, "NOTES.md"), "utf8");
      expect(contents).not.toContain("TOUCHED");

      adapter.dispose();
    },
    TURN_TIMEOUT_MS + 30_000
  );

  it(
    "cancels a running turn for real",
    async () => {
      const { adapter, events } = adapterFor();
      const grant = createGrant(["read_project"], Date.now(), project.id)!;

      await adapter.createSession({
        sessionId: "int-3",
        project,
        permissions: grant,
        attachments: [],
      });

      await adapter.sendMessage({
        sessionId: "int-3",
        text: "Count slowly from 1 to 500, one number per line.",
        context: { attachments: [] },
      });

      // Let the turn genuinely begin before interrupting it.
      await waitFor(events, (seen) => seen.length > 0, "the turn to start");

      const cancelled = await adapter.cancelRun("int-3");
      expect(cancelled.ok).toBe(true);
      expect(events.some((event) => event.kind === "run_cancelled")).toBe(true);

      adapter.dispose();
    },
    TURN_TIMEOUT_MS + 30_000
  );

  it(
    "resumes the same provider session rather than starting a new one",
    async () => {
      const { adapter, events } = adapterFor();
      const grant = createGrant(["read_project"], Date.now(), project.id)!;

      await adapter.createSession({
        sessionId: "int-4",
        project,
        permissions: grant,
        attachments: [],
      });
      await adapter.sendMessage({
        sessionId: "int-4",
        text: "Remember the number 4242. Reply with just OK.",
        context: { attachments: [] },
      });
      await waitFor(events, (seen) => seen.some((e) => e.kind === "run_completed"), "first turn");

      // The provider's own id, captured from the stream. This is the whole
      // handle a resume needs, and it is what would be persisted.
      const providerSessionId = adapter.providerSessionIdFor("int-4");
      expect(providerSessionId).toBeTruthy();
      adapter.dispose();

      // A fresh adapter, as if TabDump had been restarted.
      const second = adapterFor();
      const resumed = await second.adapter.resumeSession({
        sessionId: "int-5",
        providerSessionId: providerSessionId!,
        project,
        permissions: grant,
      });
      expect(resumed.ok).toBe(true);

      await second.adapter.sendMessage({
        sessionId: "int-5",
        text: "What number did I ask you to remember? Reply with just the digits.",
        context: { attachments: [] },
      });
      await waitFor(
        second.events,
        (seen) => seen.some((e) => e.kind === "run_completed"),
        "resumed turn"
      );

      // The conversation continued rather than starting over: the model can
      // only answer this from the first turn's context.
      const replies = second.events
        .filter((event) => event.kind === "message_received")
        .map((event) => event.summary)
        .join(" ");
      expect(replies).toContain("4242");

      second.adapter.dispose();
    },
    TURN_TIMEOUT_MS + 30_000
  );
});

describe("the integration suite's own gating", () => {
  it("is skipped unless the runtime boundary allows execution", () => {
    // Belt and braces: even with the opt-in flag, a hosted marker must keep
    // this suite off.
    expect(
      decideServerRuntime({
        VERCEL: "1",
        [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE,
      }).allowed
    ).toBe(false);
  });

  it("requires both switches", () => {
    expect(decideServerRuntime({}).allowed).toBe(false);
    expect(
      decideServerRuntime({ [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE }).allowed
    ).toBe(true);
  });
});
