import { describe, expect, it } from "vitest";
import { buildKnowledgeGraph, itemNodeId } from "./build";
import { layoutKnowledgeGraph } from "./layout";
import { EDGE_LABEL, INFERRED_EDGE_KINDS } from "./types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * Conversations Hubble found to be about the same work appear in the graph
 * as an inferred, labelled relationship — with its evidence — and never move
 * anything: the galaxy is laid out from the records alone.
 */

const T = 1_700_000_000_000;

function chat(id: string, url: string, title: string): Tab {
  return { id, url, normalizedUrl: url, domain: new URL(url).hostname, title, resource: { kind: "conversation", origin: "extension", status: "ready", addedAt: T, updatedAt: T, content: { chars: 100, extractedAt: T } } };
}

const projects: Workspace[] = [
  { id: "a", name: "Web", tabs: [chat("c1", "https://chatgpt.com/c/aaaaaaaa-1111", "Sync bug")], createdAt: T, updatedAt: T },
  { id: "b", name: "Desktop", tabs: [chat("c2", "https://claude.ai/chat/bbbbbbbb-2222", "Storage adapter")], createdAt: T, updatedAt: T },
  { id: "c", name: "Biology", tabs: [chat("c3", "https://gemini.google.com/app/cccccccc3333", "Photosynthesis")], createdAt: T, updatedAt: T },
  { id: "d", name: "Essay", tabs: [chat("c4", "https://chatgpt.com/c/dddddddd-4444", "Outline")], createdAt: T, updatedAt: T },
];
const link = { a: { workspaceId: "a", key: "s:c1" }, b: { workspaceId: "b", key: "s:c2" }, score: 0.4, shared: ["indexeddb", "adapter"] };

describe("inferred conversation links", () => {
  it("draws a labelled, evidenced relationship between two saved conversations", () => {
    const graph = buildKnowledgeGraph({ workspaces: projects, conversationLinks: [link] });
    const edge = graph.edges.find((entry) => entry.kind === "related")!;
    expect([edge.source, edge.target].sort()).toEqual([itemNodeId("a", "s:c1"), itemNodeId("b", "s:c2")].sort());
    expect(edge.evidence).toEqual({ score: 0.4, shared: ["indexeddb", "adapter"] });
    expect(EDGE_LABEL.related).toMatch(/inferred/);
    expect(INFERRED_EDGE_KINDS.has("related")).toBe(true);
  });

  it("draws nothing for a conversation that is not on the graph", () => {
    const graph = buildKnowledgeGraph({ workspaces: projects, conversationLinks: [{ ...link, b: { workspaceId: "b", key: "s:gone" } }] });
    expect(graph.edges.some((entry) => entry.kind === "related")).toBe(false);
  });

  it("never moves a project", () => {
    const without = layoutKnowledgeGraph(buildKnowledgeGraph({ workspaces: projects }));
    const linked = layoutKnowledgeGraph(
      buildKnowledgeGraph({ workspaces: projects, conversationLinks: [link, { a: { workspaceId: "c", key: "s:c3" }, b: { workspaceId: "d", key: "s:c4" }, score: 0.9, shared: ["x", "y"] }] })
    );
    expect(linked).toEqual(without);
  });
});
