import { describe, expect, it } from "vitest";
import { buildOrganizePrompt } from "./prompt";
import type { OrganizePromptTab } from "./prompt";
import type { Section } from "../types";

function makeSection(over: Partial<Section> & { id: string }): Section {
  return { parentId: null, name: "Untitled", source: "user", createdAt: 0, updatedAt: 0, ...over };
}

function makeTab(over: Partial<OrganizePromptTab> & { tabId: string }): OrganizePromptTab {
  return { title: "", url: "https://example.com", domain: "example.com", category: "Other", ...over };
}

describe("buildOrganizePrompt", () => {
  it("renders the existing section tree with indentation reflecting depth", () => {
    const root = makeSection({ id: "root", name: "School" });
    const child = makeSection({ id: "child", parentId: "root", name: "Physics" });
    const grandchild = makeSection({ id: "gc", parentId: "child", name: "S2 Orbit Research" });

    const prompt = buildOrganizePrompt([root, child, grandchild], [makeTab({ tabId: "1" })]);

    expect(prompt).toContain("- School");
    expect(prompt).toContain("  - Physics");
    expect(prompt).toContain("    - S2 Orbit Research");
  });

  it("tells the model the tree is empty when there are no sections yet", () => {
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1" })]);
    expect(prompt).toMatch(/empty/i);
  });

  it("includes title, url, domain, existing category, and cluster hint for each tab", () => {
    const prompt = buildOrganizePrompt(
      [],
      [
        makeTab({ tabId: "abc", title: "Schwarzschild metric", url: "https://en.wikipedia.org/wiki/Schwarzschild_metric", domain: "en.wikipedia.org", category: "Research", clusterHint: "sem-0" }),
      ]
    );

    expect(prompt).toContain("id=abc");
    expect(prompt).toContain('title="Schwarzschild metric"');
    expect(prompt).toContain("url=https://en.wikipedia.org/wiki/Schwarzschild_metric");
    expect(prompt).toContain("domain=en.wikipedia.org");
    expect(prompt).toContain("existing_category=Research");
    expect(prompt).toContain("semantic_cluster=sem-0");
  });

  it("omits the semantic_cluster field entirely when a tab has no cluster hint", () => {
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1" })]);
    expect(prompt).not.toContain("semantic_cluster=");
  });

  it("escapes double quotes in a tab title so the prompt stays well-formed", () => {
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1", title: 'The "Best" Course' })]);
    expect(prompt).toContain(`title="The 'Best' Course"`);
  });

  it("caps an overlong title so one tab can't dominate the prompt", () => {
    const longTitle = "x".repeat(500);
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1", title: longTitle })]);
    expect(prompt).not.toContain(longTitle);
  });

  it("gives an explicit multi-step decision procedure, not just a single classification instruction", () => {
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1" })]);
    expect(prompt).toMatch(/DECISION PROCEDURE/i);
    expect(prompt).toMatch(/cross-tab clusters/i);
    expect(prompt).toMatch(/EXISTING category/);
    expect(prompt).toMatch(/EXISTING subsection/);
  });

  it("states an explicit evidence bar against creating a section from a single tab", () => {
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1" })]);
    expect(prompt).toMatch(/EVIDENCE BAR/i);
    expect(prompt).toMatch(/single tab/i);
    expect(prompt).toMatch(/two or more tabs/i);
  });

  it("instructs the model to treat tabs sharing a semantic cluster as strong grouping evidence", () => {
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1" })]);
    expect(prompt).toMatch(/semantic_cluster/);
  });

  it("forbids the model from ever naming a section 'Other'", () => {
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1" })]);
    expect(prompt).toMatch(/never use the name "Other"/i);
  });

  it("asks for a short, user-facing reason and explicitly forbids exposing raw reasoning", () => {
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1" })]);
    expect(prompt).toMatch(/REASON/);
    expect(prompt).toMatch(/never describe your own reasoning process/i);
  });

  it("specifies the exact response schema with tabId, path, confidence, and reason", () => {
    const prompt = buildOrganizePrompt([], [makeTab({ tabId: "1" })]);
    expect(prompt).toContain('"tabId"');
    expect(prompt).toContain('"path"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"high"|"medium"|"low"');
    expect(prompt).toContain('"reason"');
    expect(prompt).toMatch(/only a json array/i);
  });
});
