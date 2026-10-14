// What the popup says after Save to Hubble, and how it re-reads what the
// Hubble page sends back. Pure parts of ai-panel.js; no chrome.* needed.
import { describe, expect, it } from "vitest";
import { captureError, describeCapture, readHits, readPanelProjects } from "./ai-panel.js";

describe("describeCapture", () => {
  it("says what a save did, in words", () => {
    expect(describeCapture({ outcome: "added", turns: 14 }, "History IA")).toBe("Saved to History IA · 14 turns");
    expect(describeCapture({ outcome: "updated", turns: 1, truncated: true }, "History IA")).toBe("Updated the saved copy in History IA · 1 turn · very long, so only the first part was kept");
    expect(describeCapture({ outcome: "unchanged" }, "History IA")).toBe("Already saved in History IA — nothing new since.");
  });

  it("explains a kept longer copy, and how to save the whole thread", () => {
    expect(describeCapture({ outcome: "kept", turns: 2 }, "History IA")).toMatch(/already has more of this conversation .* kept\. Scroll to the top/);
  });
});

describe("what the popup accepts from the page", () => {
  it("keeps well-formed projects and hits only", () => {
    expect(readPanelProjects([{ id: "a", name: "History IA" }, { id: 3 }, null, { id: "b", name: "" }])).toEqual([
      { id: "a", name: "History IA" },
      { id: "b", name: "Untitled project" },
    ]);
    expect(readHits([{ workspaceId: "a", ref: { kind: "source", tabId: "t" }, title: "T", type: "conversation", provider: "claude", hasText: true }, { ref: { kind: "evil" }, title: "x", workspaceId: "a" }])).toEqual([
      { workspaceId: "a", ref: { kind: "source", tabId: "t" }, title: "T", type: "conversation", provider: "claude", snippet: "", hasText: true },
    ]);
  });

  it("falls back to a generic message for an unknown reason", () => {
    expect(captureError("not-a-conversation")).toMatch(/isn't one/);
    expect(captureError("something-new")).toBe("Something went wrong. Try again.");
  });
});
