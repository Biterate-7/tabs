import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchResultsCard } from "./search-results-card";
import type { SearchResult } from "@/lib/ai/types";

const openTabMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser/open-tab", () => ({ openTab: openTabMock }));

function makeResult(over: Partial<SearchResult> & { tabId: string }): SearchResult {
  return {
    source: "tabdump",
    title: "Untitled",
    url: "https://example.com",
    domain: "example.com",
    workspaceId: "ws-1",
    workspaceName: "Physics IA",
    score: 4,
    matchReason: "title",
    ...over,
  };
}

describe("SearchResultsCard", () => {
  it("renders nothing for an empty result list", () => {
    const { container } = render(<SearchResultsCard results={[]} />);
    expect(container.textContent).toBe("");
  });

  it("shows the result count for a single-workspace result set", () => {
    render(<SearchResultsCard results={[makeResult({ tabId: "1" }), makeResult({ tabId: "2" })]} />);
    expect(screen.getByText(/2 results/)).toBeTruthy();
    expect(screen.queryByText(/across/)).toBeNull();
  });

  it("shows the workspace count when results span more than one workspace", () => {
    const results = [
      makeResult({ tabId: "1", workspaceId: "a", workspaceName: "Physics IA" }),
      makeResult({ tabId: "2", workspaceId: "b", workspaceName: "Research" }),
      makeResult({ tabId: "3", workspaceId: "c", workspaceName: "Random" }),
    ];
    render(<SearchResultsCard results={results} />);
    expect(screen.getByText(/3 results across 3 workspaces/)).toBeTruthy();
  });

  it("groups results under their workspace name as a heading", () => {
    const results = [
      makeResult({ tabId: "1", workspaceId: "a", workspaceName: "Physics IA", title: "Schwarzschild solution" }),
      makeResult({ tabId: "2", workspaceId: "a", workspaceName: "Physics IA", title: "S2 orbital data" }),
      makeResult({ tabId: "3", workspaceId: "b", workspaceName: "Research", title: "Orbital mechanics reference" }),
    ];
    render(<SearchResultsCard results={results} />);

    expect(screen.getByText("Physics IA")).toBeTruthy();
    expect(screen.getByText("Research")).toBeTruthy();
    expect(screen.getByText("Schwarzschild solution")).toBeTruthy();
    expect(screen.getByText("S2 orbital data")).toBeTruthy();
    expect(screen.getByText("Orbital mechanics reference")).toBeTruthy();
  });

  it("shows the domain and a human-readable match reason for each result", () => {
    render(<SearchResultsCard results={[makeResult({ tabId: "1", domain: "github.com", matchReason: "semantic" })]} />);
    expect(screen.getByText(/github\.com/)).toBeTruthy();
    expect(screen.getByText(/Semantic match/)).toBeTruthy();
  });

  it("wraps a long title instead of clipping or overflowing", () => {
    const longTitle = "A Very Long Page Title That Should Wrap Onto Multiple Lines Instead Of Overflowing The Ask Tabs Panel Width";
    render(<SearchResultsCard results={[makeResult({ tabId: "1", title: longTitle })]} />);
    const titleEl = screen.getByText(longTitle);
    expect(titleEl.className).toContain("break-words");
  });

  it("puts a long URL in the row's title attribute rather than as unwrapped visible text", () => {
    const longUrl = "https://example.com/a/very/long/path/segment/that/would/otherwise/overflow/the/panel/width/if/rendered/as/plain/text";
    render(<SearchResultsCard results={[makeResult({ tabId: "1", url: longUrl })]} />);
    const row = screen.getByRole("button");
    expect(row.getAttribute("title")).toBe(longUrl);
  });

  it("renders many results without errors", () => {
    const results = Array.from({ length: 20 }, (_, i) => makeResult({ tabId: `t${i}`, title: `Result ${i}` }));
    render(<SearchResultsCard results={results} />);
    expect(screen.getAllByRole("button")).toHaveLength(20);
  });

  it("routes the click through the extension-aware openTab, not a raw window.open", async () => {
    const user = userEvent.setup();
    render(<SearchResultsCard results={[makeResult({ tabId: "1", url: "https://example.com/page", title: "Some page" })]} />);

    await user.click(screen.getByRole("button", { name: /some page/i }));

    expect(openTabMock).toHaveBeenCalledWith("https://example.com/page");
  });

  it("shows the group name only when present, without fabricating one", () => {
    render(<SearchResultsCard results={[makeResult({ tabId: "1", domain: "x.com" })]} />);
    expect(screen.queryByText(/·.*·/)).toBeNull(); // no third "· group" segment

    render(<SearchResultsCard results={[makeResult({ tabId: "2", domain: "x.com", groupName: "References" })]} />);
    expect(screen.getByText(/References/)).toBeTruthy();
  });

  it("groups browser-sourced results into a separate 'Currently open in browser' bucket", () => {
    const results = [
      makeResult({ tabId: "1", workspaceId: "a", workspaceName: "Physics IA", title: "Saved tab" }),
      { source: "browser" as const, tabId: "browser:7", title: "Open tab", url: "https://x.com", domain: "x.com", browserTabId: 7, browserWindowId: 1, score: 4, matchReason: "title" as const },
    ];
    render(<SearchResultsCard results={results} />);
    expect(screen.getByText("Physics IA")).toBeTruthy();
    expect(screen.getByText("Currently open in browser")).toBeTruthy();
    expect(screen.getByText("Saved tab")).toBeTruthy();
    expect(screen.getByText("Open tab")).toBeTruthy();
  });

  it("shows only the browser bucket when every result is browser-sourced", () => {
    const results = [
      { source: "browser" as const, tabId: "browser:7", title: "Open tab", url: "https://x.com", domain: "x.com", browserTabId: 7, browserWindowId: 1, score: 4, matchReason: "title" as const },
    ];
    render(<SearchResultsCard results={results} />);
    expect(screen.getByText("Currently open in browser")).toBeTruthy();
    expect(screen.getByText(/1 result\b/)).toBeTruthy();
  });
});
