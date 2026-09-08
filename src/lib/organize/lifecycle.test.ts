import { describe, expect, it } from "vitest";
import {
  advanceOrganization,
  beginOrganization,
  beginSettling,
  completeOrganization,
  describeOrganizationStage,
  dismissOrganizationError,
  failOrganization,
  idleOrganizationState,
  isGraphAvailable,
  startOrganization,
} from "./lifecycle";

/** The full happy path for one dump, returned at every step so a test can assert on the middle of it. */
function runToStage(tabCount: number) {
  const idle = idleOrganizationState();
  const receiving = beginOrganization(idle, tabCount);
  const generation = receiving.generation;
  const classifying = advanceOrganization(receiving, generation, "classifying");
  const grouping = advanceOrganization(classifying, generation, "grouping");
  const other = advanceOrganization(grouping, generation, "other");
  const arranging = beginSettling(other, generation);
  const settling = beginSettling(arranging, generation, "settling");
  const ready = completeOrganization(settling, generation);
  return { idle, receiving, classifying, grouping, other, arranging, settling, ready, generation };
}

describe("organization lifecycle", () => {
  it("keeps the graph unavailable through every stage of a large dump, and opens it only at the end", () => {
    const run = runToStage(283);

    expect(isGraphAvailable(run.receiving)).toBe(false);
    expect(isGraphAvailable(run.classifying)).toBe(false);
    expect(isGraphAvailable(run.grouping)).toBe(false);
    expect(isGraphAvailable(run.other)).toBe(false);
    expect(isGraphAvailable(run.arranging)).toBe(false);
    expect(isGraphAvailable(run.settling)).toBe(false);
    expect(isGraphAvailable(run.ready)).toBe(true);
  });

  it("runs a one-tab dump through the identical lifecycle — nothing is skipped because it is small", () => {
    const run = runToStage(1);

    expect(run.receiving.status).toBe("organizing");
    expect(run.other.stage).toBe("other");
    expect(run.settling.status).toBe("settling");
    expect(isGraphAvailable(run.settling)).toBe(false);
    expect(isGraphAvailable(run.ready)).toBe(true);
  });

  it("cannot become ready while the pipeline is still processing the leftover \"Other\" tabs", () => {
    const run = runToStage(300);

    // Reaching "ready" requires the transition that the pipeline only makes
    // once its promise resolves — Stage F included. There is no path from the
    // "other" stage to an available graph that does not go through it.
    expect(isGraphAvailable(run.other)).toBe(false);
    expect(describeOrganizationStage(run.other)).toBe('Organizing "Other" tabs…');

    const stillOther = advanceOrganization(run.other, run.generation, "other");
    expect(isGraphAvailable(stillOther)).toBe(false);
  });

  it("keeps the graph unavailable while physics is still settling, after all data organization is done", () => {
    const run = runToStage(120);

    expect(run.settling.stage).toBe("settling");
    expect(describeOrganizationStage(run.settling)).toBe("Finalizing layout…");
    expect(isGraphAvailable(run.settling)).toBe(false);
  });

  it("ignores a superseded dump's completion — only the latest generation can unlock the graph", () => {
    const first = beginOrganization(idleOrganizationState(), 10);
    const second = beginOrganization(first, 300);

    // Generation 1's pipeline finally resolves, long after generation 2 started.
    const afterStaleSettle = beginSettling(second, first.generation);
    const afterStaleComplete = completeOrganization(afterStaleSettle, first.generation);

    expect(afterStaleComplete).toBe(second);
    expect(afterStaleComplete.generation).toBe(second.generation);
    expect(isGraphAvailable(afterStaleComplete)).toBe(false);

    // ...and the live generation still completes normally.
    const ready = completeOrganization(beginSettling(second, second.generation), second.generation);
    expect(isGraphAvailable(ready)).toBe(true);
  });

  it("ignores a stale failure too — an old dump's error cannot break a newer one", () => {
    const first = beginOrganization(idleOrganizationState(), 10);
    const second = beginOrganization(first, 20);

    const afterStaleFailure = failOrganization(second, first.generation, "boom");

    expect(afterStaleFailure).toBe(second);
    expect(afterStaleFailure.status).toBe("organizing");
  });

  it("does not become ready when organization fails, and exposes a reachable error state", () => {
    const organizing = beginOrganization(idleOrganizationState(), 42);
    const failed = failOrganization(organizing, organizing.generation, "Couldn't finish organizing your tabs.");

    expect(failed.status).toBe("error");
    expect(isGraphAvailable(failed)).toBe(false);
    expect(describeOrganizationStage(failed)).toBe("Couldn't finish organizing your tabs.");

    // A failed run is finished: a late transition from that same generation
    // cannot quietly turn the failure into a ready graph.
    expect(completeOrganization(failed, organizing.generation)).toBe(failed);

    // Dismissing returns to idle — the graph becomes accessible the way it is
    // for a workspace with no dump in flight, never labelled as "ready".
    const dismissed = dismissOrganizationError(failed);
    expect(dismissed.status).toBe("idle");
    expect(isGraphAvailable(dismissed)).toBe(true);
  });

  it("leaves the graph accessible when no dump is in flight", () => {
    expect(isGraphAvailable(idleOrganizationState())).toBe(true);
  });

  it("refuses transitions for a run that already completed", () => {
    const run = runToStage(5);

    expect(advanceOrganization(run.ready, run.generation, "other")).toBe(run.ready);
    expect(beginSettling(run.ready, run.generation)).toBe(run.ready);
    expect(failOrganization(run.ready, run.generation, "late")).toBe(run.ready);
  });

  it("labels each stage from real state, with the tab count and no invented percentage", () => {
    const generation = 7;
    const receiving = startOrganization(generation, 283);

    expect(describeOrganizationStage(receiving)).toBe("Receiving 283 tabs…");
    expect(describeOrganizationStage(advanceOrganization(receiving, generation, "classifying"))).toBe(
      "Organizing 283 tabs…"
    );
    expect(describeOrganizationStage(advanceOrganization(receiving, generation, "grouping"))).toBe("Building groups…");
    expect(describeOrganizationStage(beginSettling(receiving, generation))).toBe("Arranging tabs…");
    expect(describeOrganizationStage(completeOrganization(beginSettling(receiving, generation), generation))).toBe(
      "Ready"
    );
    expect(describeOrganizationStage(startOrganization(generation, 1))).toBe("Receiving 1 tab…");
  });
});
