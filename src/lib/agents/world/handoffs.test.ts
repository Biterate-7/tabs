import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_HANDOFFS, deriveHandoffs } from "./handoffs";
import type {
  AgentRunArtifactLink,
  AgentRunLink,
  WorkArtifact,
} from "@/lib/agents/types";

const T0 = 1_700_000_000_000;

function artifact(id: string, relativePath: string): WorkArtifact {
  return {
    id,
    workspaceId: "wA",
    projectPath: "C:\\repo\\project",
    relativePath,
    kind: "file",
    createdAt: T0,
    updatedAt: T0,
  };
}

function touch(runId: string, artifactId: string, at: number): AgentRunArtifactLink {
  return { id: `${runId}:${artifactId}:${at}`, runId, artifactId, role: "edited", createdAt: at };
}

function tabLink(
  runId: string,
  tabId: string,
  role: AgentRunLink["role"],
  at: number
): AgentRunLink {
  return { id: `${runId}:${tabId}:${role}`, runId, tabId, role, createdAt: at };
}

const BASE = {
  artifacts: [artifact("a1", "src/app/page.tsx")],
  artifactLinks: [] as AgentRunArtifactLink[],
  runLinks: [] as AgentRunLink[],
};

describe("a workspace where nothing was shared", () => {
  it("finds no handoffs at all", () => {
    // The picture for one agent working alone is no lines, and that is the
    // correct picture — not an absence to be filled in.
    expect(deriveHandoffs({ ...BASE, visibleRunIds: ["r1", "r2"] })).toEqual([]);
  });

  it("finds nothing when there is only one run to draw", () => {
    expect(
      deriveHandoffs({
        ...BASE,
        visibleRunIds: ["r1"],
        artifactLinks: [touch("r1", "a1", T0)],
      })
    ).toEqual([]);
  });

  it("does not treat one run touching a file twice as a handoff with itself", () => {
    const handoffs = deriveHandoffs({
      ...BASE,
      visibleRunIds: ["r1", "r2"],
      artifactLinks: [touch("r1", "a1", T0), touch("r1", "a1", T0 + 5000)],
    });
    expect(handoffs).toEqual([]);
  });
});

describe("a file two runs both worked on", () => {
  it("records a transfer, in the order they touched it", () => {
    const handoffs = deriveHandoffs({
      ...BASE,
      visibleRunIds: ["r1", "r2"],
      artifactLinks: [touch("r2", "a1", T0 + 5000), touch("r1", "a1", T0)],
    });

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].fromRunId).toBe("r1");
    expect(handoffs[0].toRunId).toBe("r2");
    expect(handoffs[0].via).toBe("file");
  });

  it("names the file, project-relative", () => {
    const handoffs = deriveHandoffs({
      ...BASE,
      visibleRunIds: ["r1", "r2"],
      artifactLinks: [touch("r1", "a1", T0), touch("r2", "a1", T0 + 1)],
    });
    expect(handoffs[0].label).toBe("shared src/app/page.tsx");
    // Never the absolute project root — see lib/agents/paths.ts.
    expect(handoffs[0].label).not.toContain("C:\\");
  });

  it("survives an artifact it cannot name", () => {
    const handoffs = deriveHandoffs({
      ...BASE,
      artifacts: [],
      visibleRunIds: ["r1", "r2"],
      artifactLinks: [touch("r1", "a1", T0), touch("r2", "a1", T0 + 1)],
    });
    // The transfer is real whether or not the path resolved; dropping it
    // would lose a relationship over a label.
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].label).toBe("shared a file");
  });

  it("chains six runs rather than pairing them", () => {
    // Six runs that all touched package.json have fifteen pairs between them.
    // Drawing all fifteen would bury the picture under a file every project
    // touches.
    const visibleRunIds = ["r1", "r2", "r3", "r4", "r5", "r6"];
    const artifactLinks = visibleRunIds.map((runId, index) =>
      touch(runId, "a1", T0 + index * 1000)
    );

    const handoffs = deriveHandoffs({ ...BASE, visibleRunIds, artifactLinks });
    expect(handoffs).toHaveLength(5);

    for (const handoff of handoffs) {
      const from = visibleRunIds.indexOf(handoff.fromRunId);
      const to = visibleRunIds.indexOf(handoff.toRunId);
      expect(to - from).toBe(1);
    }
  });

  it("counts a run that inspected then edited a file once", () => {
    const handoffs = deriveHandoffs({
      ...BASE,
      visibleRunIds: ["r1", "r2"],
      artifactLinks: [
        touch("r1", "a1", T0),
        touch("r1", "a1", T0 + 9000),
        touch("r2", "a1", T0 + 4000),
      ],
    });
    // r1 joined the chain at its earliest touch, so it is still first.
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].fromRunId).toBe("r1");
  });
});

describe("a tab one run produced and another read", () => {
  it("records a transfer in the direction the roles name", () => {
    const handoffs = deriveHandoffs({
      ...BASE,
      visibleRunIds: ["r1", "r2"],
      runLinks: [
        tabLink("r1", "t1", "produced", T0),
        tabLink("r2", "t1", "context", T0 + 1000),
      ],
    });

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ fromRunId: "r1", toRunId: "r2", via: "tab" });
  });

  it("names the tab when a title is available", () => {
    const handoffs = deriveHandoffs({
      ...BASE,
      visibleRunIds: ["r1", "r2"],
      runLinks: [
        tabLink("r1", "t1", "produced", T0),
        tabLink("r2", "t1", "context", T0 + 1000),
      ],
      tabTitles: new Map([["t1", "Release notes"]]),
    });
    expect(handoffs[0].label).toBe("passed Release notes");
  });

  it("refuses a tab that was read before it was produced", () => {
    // Two runs that happened to touch the same page is not a transfer.
    const handoffs = deriveHandoffs({
      ...BASE,
      visibleRunIds: ["r1", "r2"],
      runLinks: [
        tabLink("r1", "t1", "produced", T0 + 5000),
        tabLink("r2", "t1", "context", T0),
      ],
    });
    expect(handoffs).toEqual([]);
  });

  it("does not have a run hand a tab to itself", () => {
    const handoffs = deriveHandoffs({
      ...BASE,
      visibleRunIds: ["r1", "r2"],
      runLinks: [
        tabLink("r1", "t1", "produced", T0),
        tabLink("r1", "t1", "context", T0 + 1000),
      ],
    });
    expect(handoffs).toEqual([]);
  });
});

describe("only what is on stage", () => {
  it("ignores a run that is not being drawn", () => {
    // The world never draws a line to something it is not also drawing.
    const handoffs = deriveHandoffs({
      ...BASE,
      visibleRunIds: ["r1"],
      artifactLinks: [touch("r1", "a1", T0), touch("r-hidden", "a1", T0 + 1000)],
    });
    expect(handoffs).toEqual([]);
  });
});

describe("folding and bounding", () => {
  it("keeps one edge per ordered pair", () => {
    const handoffs = deriveHandoffs({
      artifacts: [artifact("a1", "one.ts"), artifact("a2", "two.ts")],
      visibleRunIds: ["r1", "r2"],
      artifactLinks: [
        touch("r1", "a1", T0),
        touch("r2", "a1", T0 + 1000),
        touch("r1", "a2", T0 + 2000),
        touch("r2", "a2", T0 + 3000),
      ],
      runLinks: [],
    });

    expect(handoffs).toHaveLength(1);
    // The most recent evidence wins — that is the transfer someone watching
    // would have just seen.
    expect(handoffs[0].label).toBe("shared two.ts");
  });

  it("keeps both directions between the same two runs", () => {
    const handoffs = deriveHandoffs({
      artifacts: [artifact("a1", "one.ts"), artifact("a2", "two.ts")],
      visibleRunIds: ["r1", "r2"],
      artifactLinks: [
        touch("r1", "a1", T0),
        touch("r2", "a1", T0 + 1000),
        touch("r2", "a2", T0 + 2000),
        touch("r1", "a2", T0 + 3000),
      ],
      runLinks: [],
    });

    expect(handoffs).toHaveLength(2);
    expect(new Set(handoffs.map((h) => `${h.fromRunId}->${h.toRunId}`))).toEqual(
      new Set(["r1->r2", "r2->r1"])
    );
  });

  it("caps the picture and keeps the most recent", () => {
    // Past about a dozen connections the world stops being a picture.
    const visibleRunIds = Array.from({ length: 40 }, (_, i) => `r${i}`);
    const artifactLinks = visibleRunIds.map((runId, index) =>
      touch(runId, "a1", T0 + index * 1000)
    );

    const handoffs = deriveHandoffs({ ...BASE, visibleRunIds, artifactLinks });
    expect(handoffs).toHaveLength(DEFAULT_MAX_HANDOFFS);
    expect(handoffs[0].at).toBeGreaterThan(handoffs[handoffs.length - 1].at);
  });

  it("is deterministic", () => {
    const input = {
      ...BASE,
      visibleRunIds: ["r1", "r2", "r3"],
      artifactLinks: [touch("r1", "a1", T0), touch("r2", "a1", T0), touch("r3", "a1", T0)],
    };
    expect(deriveHandoffs(input)).toEqual(deriveHandoffs(input));
  });
});
