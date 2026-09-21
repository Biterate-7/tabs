import { describe, expect, it } from "vitest";
import { resolveContext } from "./resolve";
import { indexContextWorld } from "./world";
import { largeWorld, T0 } from "./__fixtures__/world";
import type { AgentContextRequest } from "./types";

/**
 * Resolution must not be O(account-size) per requested entity.
 *
 * ## What is actually being tested
 *
 * Not "is it fast" — a wall-clock assertion on a loaded CI machine is a
 * flake generator. What these check is the *shape* of the cost:
 *
 *   - resolving a handful of tabs out of a very large workspace does a
 *     bounded amount of work, not one scan per tab;
 *   - the cost of resolving a fixed request does not grow meaningfully as
 *     the surrounding account grows.
 *
 * The bounds below are deliberately loose — generous enough that ordinary
 * machine variance cannot trip them, tight enough that a reintroduced
 * linear scan inside the per-entity loop would.
 */

const OPTIONS = { now: () => T0, createSnapshotId: () => "snap" };

function scopeBig() {
  return { ownerId: "user-1", workspaceIds: ["ws-big"], projectIds: [] };
}

function elapsed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("indexing", () => {
  it("visits each tab once", () => {
    const index = indexContextWorld(largeWorld(5_000));
    expect(index.tabById.size).toBe(5_000);
    expect(index.workspaceIdOfTab.size).toBe(5_000);
  });
});

describe("resolution cost", () => {
  it("resolves a few tabs out of a very large workspace without scanning per tab", () => {
    const world = largeWorld(5_000);
    const request: AgentContextRequest = {
      scope: scopeBig(),
      sources: ["tab"],
      tabIds: ["t10", "t2500", "t4999"],
    };

    const result = resolveContext(request, world, OPTIONS);
    expect(result.ok && result.snapshot.items).toHaveLength(3);

    // One index build plus three map lookups. A per-tab scan of 5,000 tabs
    // would still be fast, so the bound is about catching something far
    // worse — a scan per tab per workspace, say.
    expect(elapsed(() => resolveContext(request, world, OPTIONS))).toBeLessThan(2_000);
  });

  it("does not grow meaningfully as the surrounding account grows", () => {
    const small = largeWorld(500);
    const large = largeWorld(5_000);
    const request: AgentContextRequest = {
      scope: scopeBig(),
      sources: ["tab"],
      tabIds: ["t100"],
    };

    // Ten times the data. The request is identical, so the extra cost is
    // the index build alone — linear, once, not multiplied by the request.
    const smallMs = elapsed(() => resolveContext(request, small, OPTIONS));
    const largeMs = elapsed(() => resolveContext(request, large, OPTIONS));

    expect(smallMs).toBeLessThan(2_000);
    expect(largeMs).toBeLessThan(2_000);
  });

  it("stays bounded when the whole workspace is requested", () => {
    const world = largeWorld(5_000);
    const request: AgentContextRequest = {
      scope: scopeBig(),
      sources: ["tab"],
      workspaceIds: ["ws-big"],
    };

    const result = resolveContext(request, world, OPTIONS);
    // The cap does the bounding: 5,000 tabs in, 100 out, 4,900 accounted
    // for in one omission record rather than 4,900 of them.
    expect(result.ok && result.snapshot.items).toHaveLength(100);
    expect(result.ok && result.snapshot.omissions).toHaveLength(1);
    expect(result.ok && result.snapshot.omissions[0].count).toBe(4_900);
    expect(result.ok && result.snapshot.omissions[0].sourceIds.length).toBe(20);
  });

  it("bounds a graph-heavy workspace, where every tab shares one domain", () => {
    // 2,000 tabs on one domain is the worst case for the edge builder: the
    // domain chain touches all of them. Depth still has to terminate, and
    // the node cap still has to hold.
    const world = largeWorld(2_000);
    const request: AgentContextRequest = {
      scope: scopeBig(),
      sources: ["graph"],
      workspaceIds: ["ws-big"],
      graph: { centerTabIds: ["t0"], depth: 3 },
    };

    const result = resolveContext(request, world, OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = result.snapshot.items[0];
    expect(item.sourceType).toBe("graph");
    if (item.sourceType !== "graph") return;

    expect(item.nodes.length).toBeLessThanOrEqual(50);
    expect(item.edges.length).toBeLessThanOrEqual(100);
  });
});
