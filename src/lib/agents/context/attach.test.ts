import { describe, expect, it } from "vitest";
import { isAttachableSnapshot, snapshotToAttachments, snapshotToMessageContext } from "./attach";
import { resolveContext } from "./resolve";
import { DEFAULT_CONTEXT_LIMITS, MAX_CONTEXT_LIMITS } from "./limits";
import { describeSnapshot, diffSnapshots, refreshContext } from "./snapshot";
import {
  AGENT_CONTEXT_KINDS,
  isWellFormedContext,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@/lib/agents/control/context";
import { AGENT_CONTEXT_SOURCE_TYPES } from "./types";
import { fixtureWorld, largeWorld, scopeA, scopeAWithProject, T0 } from "./__fixtures__/world";
import type { AgentContextRequest, AgentContextSnapshot } from "./types";
import type { AgentContextWorld } from "./world";

function resolve(
  request: AgentContextRequest,
  world: AgentContextWorld = fixtureWorld(),
  localRuntimeAllowed = false
): AgentContextSnapshot {
  const result = resolveContext(request, world, {
    now: () => T0,
    createSnapshotId: () => "snap",
    localRuntimeAllowed,
  });
  if (!result.ok) throw new Error(`expected resolution, got ${result.reason}`);
  return result.snapshot;
}

const EVERYTHING: AgentContextRequest = {
  scope: scopeAWithProject(),
  sources: [...AGENT_CONTEXT_SOURCE_TYPES],
  workspaceIds: ["ws-a"],
  collectionIds: ["col-a1"],
  projectIds: ["proj-a"],
  graph: { centerTabIds: ["a1"], depth: 2 },
};

describe("projection into the control plane", () => {
  it("every source type has an attachment kind", () => {
    // If a source type were added without a kind, this is where it shows up
    // rather than as a dropped attachment at runtime.
    const snapshot = resolve(EVERYTHING, fixtureWorld(), true);
    const kinds = new Set(snapshotToAttachments(snapshot).map((a) => a.kind));

    for (const kind of kinds) {
      expect(AGENT_CONTEXT_KINDS).toContain(kind);
    }
    expect(kinds.size).toBe(AGENT_CONTEXT_SOURCE_TYPES.length);
  });

  it("produces a well-formed control-plane context", () => {
    const snapshot = resolve(EVERYTHING, fixtureWorld(), true);
    expect(isAttachableSnapshot(snapshot)).toBe(true);
    expect(isWellFormedContext(snapshotToMessageContext(snapshot))).toBe(true);
  });

  it("loses the scope and the omission list on the way across", () => {
    // An adapter has no business knowing which workspaces the user
    // authorized, nor which entities they deliberately left out.
    const snapshot = resolve(EVERYTHING, fixtureWorld(), true);
    const serialized = JSON.stringify(snapshotToAttachments(snapshot));

    expect(serialized).not.toContain("ownerId");
    expect(serialized).not.toContain("omission");
    expect(serialized).not.toContain("workspaceIds");
    expect(serialized).not.toContain("limits");
  });

  it("names the workspace only when the scope has exactly one", () => {
    const single = snapshotToMessageContext(
      resolve({ scope: scopeA(), sources: ["tab"], workspaceIds: ["ws-a"] })
    );
    expect(single.workspaceId).toBe("ws-a");

    const multi = snapshotToMessageContext(
      resolve({
        scope: { ownerId: "user-1", workspaceIds: ["ws-a", "ws-b"], projectIds: [] },
        sources: ["tab"],
        workspaceIds: ["ws-a", "ws-b"],
      })
    );
    expect(multi.workspaceId).toBeUndefined();
  });

  it("says a project's path is unavailable rather than looking pathless", () => {
    const hosted = snapshotToAttachments(
      resolve(
        { scope: scopeAWithProject(), sources: ["project"], projectIds: ["proj-a"] },
        fixtureWorld(),
        false
      )
    );
    expect(hosted[0].detail).toBe("path not available here");

    const local = snapshotToAttachments(
      resolve(
        { scope: scopeAWithProject(), sources: ["project"], projectIds: ["proj-a"] },
        fixtureWorld(),
        true
      )
    );
    expect(local[0].detail).toBe("C:/work/api");
  });
});

describe("the two caps cannot drift", () => {
  it("the bridge cannot resolve more items than the control plane will carry", () => {
    // If these disagree, a snapshot that satisfied every one of its own
    // limits gets cut a second time at the boundary — and that second cut
    // produces no omission record, which is exactly the silent truncation
    // the omission model exists to prevent.
    expect(DEFAULT_CONTEXT_LIMITS.maxItems).toBeLessThanOrEqual(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(MAX_CONTEXT_LIMITS.maxItems).toBeGreaterThanOrEqual(MAX_ATTACHMENTS_PER_MESSAGE);
  });

  it("a snapshot resolved at the default cap projects without loss", () => {
    const snapshot = resolve(
      {
        scope: { ownerId: "user-1", workspaceIds: ["ws-big"], projectIds: [] },
        sources: ["tab"],
        workspaceIds: ["ws-big"],
        limits: { maxTabs: DEFAULT_CONTEXT_LIMITS.maxItems, maxCharacters: 500_000 },
      },
      largeWorld(300)
    );

    expect(snapshotToAttachments(snapshot)).toHaveLength(snapshot.items.length);
  });
});

describe("auditability", () => {
  it("explains what was asked for, what arrived and what was cut", () => {
    const snapshot = resolve(
      {
        scope: { ownerId: "user-1", workspaceIds: ["ws-big"], projectIds: [] },
        sources: ["tab"],
        workspaceIds: ["ws-big"],
        limits: { maxTabs: 10 },
      },
      largeWorld(25)
    );

    expect(describeSnapshot(snapshot)).toMatchObject({
      snapshotId: "snap",
      capturedAt: T0,
      requestedSources: ["tab"],
      includedBySource: { tab: 10 },
      omittedBySource: { tab: 15 },
      reasons: ["tab: limit-tabs (15)"],
    });
  });

  it("records the chain when a snapshot came from a refresh", () => {
    const request: AgentContextRequest = {
      scope: scopeA(),
      sources: ["tab"],
      workspaceIds: ["ws-a"],
    };
    const first = resolve(request);
    const second = refreshContext(first, request, fixtureWorld(), {
      now: () => T0 + 1,
      createSnapshotId: () => "snap-2",
    });

    expect(second.ok && describeSnapshot(second.snapshot).previousSnapshotId).toBe("snap");
  });
});

describe("staleness", () => {
  it("distinguishes an added entity from a changed one", () => {
    const request: AgentContextRequest = {
      scope: scopeA(),
      sources: ["tab"],
      workspaceIds: ["ws-a"],
    };
    const before = resolve(request);

    const world = fixtureWorld();
    const after = resolve(request, {
      ...world,
      workspaces: world.workspaces.map((w) =>
        w.id !== "ws-a"
          ? w
          : {
              ...w,
              tabs: [
                // a1 retitled, a5 removed, a6 added.
                ...w.tabs
                  .filter((t) => t.id !== "a5")
                  .map((t) => (t.id === "a1" ? { ...t, title: "Renamed guide" } : t)),
                {
                  id: "a6",
                  url: "https://new.example.com/",
                  normalizedUrl: "https://new.example.com/",
                  domain: "new.example.com",
                  title: "Brand new",
                },
              ],
            }
      ),
    });

    expect(diffSnapshots(before, after)).toEqual({
      addedSourceIds: ["a6"],
      removedSourceIds: ["a5"],
      changedSourceIds: ["a1"],
    });
  });
});
