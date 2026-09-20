import { beforeEach, describe, expect, it } from "vitest";
import {
  T0,
  withAgent,
  withArtifact,
  withEventId,
  withEvidence,
  withRun,
  withTabLink,
  withWorkItem,
} from "./intelligence/__fixtures__/domain";
import { AGENT_STORAGE_KEY, loadAgentState, saveAgentState } from "./persistence";
import { AGENT_STATE_VERSION, emptyAgentState } from "./types";
import type { AgentState } from "./types";

/**
 * Task-level evidence, across a reload.
 *
 * Two claims. Evidence survives a round trip intact, and evidence that no
 * longer makes sense does not survive at all: the load path re-checks every
 * end of every row, because stored state is not a trust boundary. The
 * hand-written records below are states the domain would never produce and
 * a hand-edited or partially-restored store can.
 */

function seeded() {
  const base = withAgent();
  const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" }, T0);
  const item = withWorkItem(run.state, { runId: run.runId, title: "Task A" }, T0);

  let state: AgentState = withTabLink(
    item.state,
    { runId: run.runId, tabId: "tab-1", role: "context" },
    T0
  );
  const filed = withArtifact(state, { runId: run.runId, path: "src/a.ts", role: "edited" }, T0);
  const evented = withEventId(filed.state, { runId: run.runId, summary: "Edited" }, T0);
  state = evented.state;

  state = withEvidence(state, { workItemId: item.workItemId, kind: "tab", targetId: "tab-1" });
  state = withEvidence(state, {
    workItemId: item.workItemId,
    kind: "artifact",
    targetId: filed.artifactId,
  });
  state = withEvidence(state, {
    workItemId: item.workItemId,
    kind: "event",
    targetId: evented.eventId,
  });

  return { state, runId: run.runId, workItemId: item.workItemId, eventId: evented.eventId };
}

/** Writes a raw record, bypassing the write path, to test the read path. */
function writeRaw(record: unknown) {
  window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(record));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("round trip", () => {
  it("keeps every evidence row", () => {
    const s = seeded();
    expect(saveAgentState(s.state)).toBe(true);

    const loaded = loadAgentState();
    expect(loaded.status).toBe("loaded");
    expect(loaded.state.workItemEvidence).toHaveLength(3);
    expect(new Set(loaded.state.workItemEvidence.map((row) => row.kind))).toEqual(
      new Set(["tab", "artifact", "event"])
    );
  });

  it("loads state written before evidence existed, rather than rejecting it", () => {
    const s = seeded();
    // The upgrade is additive: an older build's record simply has no key.
    const withoutEvidence: Record<string, unknown> = { ...s.state };
    delete withoutEvidence.workItemEvidence;
    writeRaw(withoutEvidence);

    const loaded = loadAgentState();
    expect(loaded.status).toBe("loaded");
    expect(loaded.state.workItemEvidence).toEqual([]);
    // Nothing else was lost to the missing key.
    expect(loaded.state.workItems).toHaveLength(1);
    expect(loaded.state.runs).toHaveLength(1);
  });

  it("starts empty on a fresh domain", () => {
    expect(emptyAgentState().workItemEvidence).toEqual([]);
  });
});

describe("the load path re-checks every end", () => {
  it("drops a row whose work item is gone", () => {
    const s = seeded();
    writeRaw({ ...s.state, workItems: [] });
    expect(loadAgentState().state.workItemEvidence).toEqual([]);
  });

  it("drops a row whose tab link the run no longer holds", () => {
    const s = seeded();
    writeRaw({ ...s.state, links: [] });

    const rows = loadAgentState().state.workItemEvidence;
    expect(rows.some((row) => row.kind === "tab")).toBe(false);
    // The other two kinds are untouched — the check is per row, not per file.
    expect(rows).toHaveLength(2);
  });

  it("drops a row whose event is gone", () => {
    const s = seeded();
    writeRaw({ ...s.state, events: [] });

    const rows = loadAgentState().state.workItemEvidence;
    expect(rows.some((row) => row.kind === "event")).toBe(false);
    expect(rows).toHaveLength(2);
  });

  it("drops a row whose artifact link is gone", () => {
    const s = seeded();
    writeRaw({ ...s.state, artifactLinks: [] });

    const rows = loadAgentState().state.workItemEvidence;
    expect(rows.some((row) => row.kind === "artifact")).toBe(false);
    expect(rows).toHaveLength(2);
  });

  it("drops a row that disagrees with its work item about the run", () => {
    const s = seeded();
    const tampered = s.state.workItemEvidence.map((row) => ({ ...row, runId: "some-other-run" }));
    writeRaw({ ...s.state, workItemEvidence: tampered });
    expect(loadAgentState().state.workItemEvidence).toEqual([]);
  });

  it("drops a row that disagrees about the workspace", () => {
    const s = seeded();
    const tampered = s.state.workItemEvidence.map((row) => ({ ...row, workspaceId: "elsewhere" }));
    writeRaw({ ...s.state, workItemEvidence: tampered });
    expect(loadAgentState().state.workItemEvidence).toEqual([]);
  });

  it("drops malformed rows without failing the whole load", () => {
    const s = seeded();
    writeRaw({
      ...s.state,
      workItemEvidence: [
        ...s.state.workItemEvidence,
        null,
        "not an object",
        { id: "x" },
        { ...s.state.workItemEvidence[0], kind: "workspace" },
        { ...s.state.workItemEvidence[0], createdAt: "yesterday" },
      ],
    });

    const loaded = loadAgentState();
    expect(loaded.status).toBe("loaded");
    expect(loaded.state.workItemEvidence).toHaveLength(3);
  });

  it("de-duplicates rows sharing an id", () => {
    const s = seeded();
    writeRaw({
      ...s.state,
      workItemEvidence: [...s.state.workItemEvidence, ...s.state.workItemEvidence],
    });
    expect(loadAgentState().state.workItemEvidence).toHaveLength(3);
  });

  it("refuses a record from a newer build without discarding it", () => {
    const s = seeded();
    writeRaw({ ...s.state, version: AGENT_STATE_VERSION + 1 });

    const loaded = loadAgentState();
    expect(loaded.status).toBe("unsupported");
    expect(loaded.state.workItemEvidence).toEqual([]);
  });
});
