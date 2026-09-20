import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { recordArtifactWork } from "@/lib/agents/artifacts";
import { appendRunEvent } from "@/lib/agents/events";
import { addRunLink } from "@/lib/agents/links";
import { createAgent } from "@/lib/agents/registry";
import { createRun, transitionRunStatus } from "@/lib/agents/runs";
import { RECENT_RUN_WINDOW_MS } from "@/lib/agents/spatial/types";
import { emptyAgentState } from "@/lib/agents/types";
import { recordWorkItemEvidence } from "@/lib/agents/work-item-evidence";
import { createWorkItem, transitionWorkItem } from "@/lib/agents/work-items";
import type { AgentState, AgentWorkItemEvidenceKind } from "@/lib/agents/types";

/**
 * Generates the deterministic state used for live browser verification.
 *
 * Not a test of behaviour - it asserts nothing. It is here, as a vitest
 * file, for one reason: this is the only runner in the repo that resolves
 * the `@/` alias and TypeScript, so it is the only way to build the seed
 * through the **real domain operations** rather than by hand-writing JSON.
 *
 * That distinction is what makes the seed trustworthy. Artifact ids are
 * derived from (workspace, project, path) and work item ids are minted; a
 * hand-written fixture would get them subtly wrong, and the domain index
 * fails closed - so the app would silently render an emptier world than the
 * seed claimed, and the verification would be of nothing.
 *
 * Skipped by default so it never runs in CI. Run it deliberately:
 *
 *     TABDUMP_SEED_OUT=seed.json npx vitest run src/lib/agents/__seed__
 */

const OUT = process.env.TABDUMP_SEED_OUT ?? "";

/**
 * The instant the seed is built backwards from.
 *
 * Read from the clock rather than pinned to a literal, and the reason is
 * the opposite of what it looks like. Every offset below is fixed, so the
 * *shape* of the seed - which run is inside the world's window and which is
 * far outside it - is identical on every generation. A pinned literal date
 * would instead drift: once real time passes it, every "recent" run becomes
 * future-dated, the world stops drawing them, and the verification would be
 * of a state no user can ever be in.
 */
const NOW = Date.now();
const HOUR = 3_600_000;

/** Well outside the world's six-hour window - the run this phase exists for. */
const OLD = NOW - RECENT_RUN_WINDOW_MS - 20 * HOUR;

function tab(id: string, url: string, title: string, at: number) {
  const parsed = new URL(url);
  return {
    id,
    url,
    normalizedUrl: url,
    domain: parsed.hostname.replace(/^www\./, ""),
    title,
    createdAt: at,
    updatedAt: at,
  };
}

describe.runIf(Boolean(OUT))("qa seed", () => {
  it("writes a deterministic agent + workspace state", () => {
    let state: AgentState = emptyAgentState();

    const mk = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
      if (!result.ok) throw new Error(`seed: ${JSON.stringify(result)}`);
      return result as Extract<T, { ok: true }>;
    };

    // --- agents -----------------------------------------------------------
    const claude = mk(createAgent(state, { provider: "claude-code", name: "Claude Code" }, OLD));
    state = claude.state;
    const cursor = mk(createAgent(state, { provider: "cursor", name: "Cursor" }, OLD));
    state = cursor.state;
    const acme = mk(createAgent(state, { provider: "custom:acme", name: "Acme Agent" }, OLD));
    state = acme.state;

    const run = (agentId: string, workspaceId: string, title: string, at: number) => {
      const created = mk(createRun(state, { agentId, workspaceId, title }, at));
      state = created.state;
      return created.run.id;
    };

    const item = (
      runId: string,
      title: string,
      status: "pending" | "active" | "completed",
      at: number,
      summary?: string
    ) => {
      const created = mk(
        createWorkItem(state, { runId, title, ...(summary ? { summary } : {}) }, at)
      );
      state = created.state;
      const steps = status === "completed" ? ["active", "completed"] : status === "active" ? ["active"] : [];
      for (const step of steps) {
        state = mk(transitionWorkItem(state, created.workItem.id, step as never, at + 1)).state;
      }
      return created.workItem.id;
    };

    const link = (runId: string, tabId: string, workspaceId: string, at: number) => {
      state = mk(
        addRunLink(state, { runId, tabId, role: "context", tabWorkspaceId: workspaceId }, at)
      ).state;
      return tabId;
    };

    const file = (runId: string, projectPath: string, path: string, role: "edited" | "inspected", at: number) => {
      const done = mk(recordArtifactWork(state, { runId, projectPath, path, role }, at));
      state = done.state;
      return done.artifact.id;
    };

    const event = (runId: string, summary: string, at: number) => {
      const done = mk(appendRunEvent(state, { runId, kind: "activity", summary, timestamp: at }));
      state = done.state;
      return done.event.id;
    };

    const evidence = (workItemId: string, kind: AgentWorkItemEvidenceKind, targetId: string, at: number) => {
      state = mk(recordWorkItemEvidence(state, { workItemId, kind, targetId }, at)).state;
    };

    // --- 1. THE OLD RUN: three tasks, disjoint evidence, one with none -----
    const oldRun = run(claude.agent.id, "ws-dev", "Fix parser import handling", OLD);

    const taskA = item(oldRun, "Research inflation", "completed", OLD, "Gathered the source data");
    const taskB = item(oldRun, "Draft conclusion", "completed", OLD + 60_000);
    item(oldRun, "Unrecorded task", "pending", OLD + 120_000);

    link(oldRun, "tab-infl", "ws-dev", OLD);
    link(oldRun, "tab-draft", "ws-dev", OLD);
    link(oldRun, "tab-loose", "ws-dev", OLD);

    const fileA = file(oldRun, "/projects/tabdump", "src/parser.ts", "edited", OLD);
    const fileB = file(oldRun, "/projects/tabdump", "docs/notes.md", "inspected", OLD);

    const eventA = event(oldRun, "Edited src/parser.ts", OLD + 1000);
    const eventB = event(oldRun, "Read docs/notes.md", OLD + 2000);
    event(oldRun, "Ran the test suite", OLD + 3000);

    evidence(taskA, "tab", "tab-infl", OLD);
    evidence(taskA, "artifact", fileA, OLD);
    evidence(taskA, "event", eventA, OLD);

    evidence(taskB, "tab", "tab-draft", OLD);
    evidence(taskB, "artifact", fileB, OLD);
    evidence(taskB, "event", eventB, OLD);

    state = mk(transitionRunStatus(state, oldRun, "completed", OLD + 10_000)).state;

    // --- 2. AN ACTIVE RUN --------------------------------------------------
    const liveRun = run(cursor.agent.id, "ws-research", "Review the pricing model", NOW - 5 * 60_000);
    item(liveRun, "Read the current sheet", "active", NOW - 5 * 60_000);
    link(liveRun, "tab-pricing", "ws-research", NOW - 5 * 60_000);
    event(liveRun, "Opened the pricing sheet", NOW - 4 * 60_000);

    // --- 3. A RECENTLY COMPLETED RUN ---------------------------------------
    const recentRun = run(claude.agent.id, "ws-dev", "Tidy the test helpers", NOW - 2 * HOUR);
    item(recentRun, "Remove the duplicate fixture", "completed", NOW - 2 * HOUR);
    file(recentRun, "/projects/tabdump", "test/helpers.ts", "edited", NOW - 2 * HOUR);
    event(recentRun, "Edited test/helpers.ts", NOW - 2 * HOUR);
    state = mk(transitionRunStatus(state, recentRun, "completed", NOW - 90 * 60_000)).state;

    // --- 4. A CUSTOM-AGENT RUN, older than the window, with no title -------
    const customRun = mk(
      createRun(state, { agentId: acme.agent.id, workspaceId: "ws-ops" }, OLD + HOUR)
    );
    state = customRun.state;
    const customTask = item(customRun.run.id, "Rotate the signing keys", "completed", OLD + HOUR);
    link(customRun.run.id, "tab-runbook", "ws-ops", OLD + HOUR);
    const customFile = file(customRun.run.id, "/projects/ops", "runbooks/keys.md", "edited", OLD + HOUR);
    const customEvent = event(customRun.run.id, "Edited runbooks/keys.md", OLD + HOUR);
    evidence(customTask, "tab", "tab-runbook", OLD + HOUR);
    evidence(customTask, "artifact", customFile, OLD + HOUR);
    evidence(customTask, "event", customEvent, OLD + HOUR);
    state = mk(transitionRunStatus(state, customRun.run.id, "completed", OLD + HOUR + 5000)).state;

    // --- workspaces --------------------------------------------------------
    // `tab-loose` is deliberately absent: the Session View must render it as
    // a stale tab rather than fabricating a replacement.
    const workspaces = {
      version: 1,
      currentId: "ws-dev",
      workspaces: [
        {
          id: "ws-dev",
          name: "Development",
          createdAt: OLD,
          updatedAt: NOW,
          tabs: [
            tab("tab-infl", "https://example.com/inflation-data", "Inflation data 2024", OLD),
            tab("tab-draft", "https://example.com/draft", "Draft document", OLD),
          ],
        },
        {
          id: "ws-research",
          name: "Research",
          createdAt: OLD,
          updatedAt: NOW,
          tabs: [tab("tab-pricing", "https://example.com/pricing", "Pricing model sheet", NOW)],
        },
        {
          id: "ws-ops",
          name: "Operations",
          createdAt: OLD,
          updatedAt: NOW,
          tabs: [tab("tab-runbook", "https://example.com/runbook", "Key rotation runbook", OLD)],
        },
      ],
    };

    const payload = {
      "tabdump:agents:v1": state,
      "tabdump:workspaces:v1": workspaces,
    };

    if (OUT) writeFileSync(OUT, JSON.stringify(payload, null, 2));
    else console.log(JSON.stringify(payload));
  });
});
