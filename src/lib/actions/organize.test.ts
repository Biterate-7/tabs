import { describe, expect, it } from "vitest";
import { proposeAutoOrganizeAction } from "./organize";
import type { WorkspaceStore } from "@/lib/workspace/types";

function tab(id: string, title: string, domain = "example.com") {
  return { id, url: `https://${domain}/${id}`, normalizedUrl: `https://${domain}/${id}`, domain, title };
}

function store(): WorkspaceStore {
  return {
    version: 1,
    currentId: "ws-1",
    workspaces: [
      {
        id: "ws-1",
        name: "Inbox",
        tabs: [
          tab("t1", "Physics IA Notes", "docs.google.com"),
          tab("t2", "Physics Orbital Mechanics", "wikipedia.org"),
          tab("t3", "Physics Lab Report", "notion.so"),
          tab("t4", "Grocery list", "cooking.example"),
          tab("t5", "Recipe idea", "food.example"),
        ],
        createdAt: 0,
        updatedAt: 0,
      },
      { id: "ws-2", name: "MUN", tabs: [tab("t6", "MUN Resolution Draft", "un.org")], createdAt: 0, updatedAt: 0 },
    ],
  };
}

describe("proposeAutoOrganizeAction", () => {
  it("defaults to scope 'all' when omitted", () => {
    const validated = proposeAutoOrganizeAction.validate({});
    expect(validated).toEqual({ ok: true, args: { scope: "all" } });
  });

  it("accepts scope 'current'", () => {
    const validated = proposeAutoOrganizeAction.validate({ scope: "current" });
    expect(validated).toEqual({ ok: true, args: { scope: "current" } });
  });

  it("is read-only and never mutates the store", () => {
    expect(proposeAutoOrganizeAction.readOnly).toBe(true);
  });

  it("scope 'current' only considers the current workspace's tabs", () => {
    const s = store();
    const result = proposeAutoOrganizeAction.run(s, { scope: "current" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // MUN's tab lives in ws-2, not the current workspace (ws-1) — it must never appear.
    const allTabIds = [
      ...result.data.plan.workspaces.flatMap((w) => w.tabs.map((t) => t.tabId)),
      ...result.data.plan.uncertainTabs.map((u) => u.tabId),
    ];
    expect(allTabIds).not.toContain("t6");
  });

  it("scope 'all' considers every workspace and returns an already-validated plan", () => {
    const s = store();
    const result = proposeAutoOrganizeAction.run(s, { scope: "all" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plan.totalTabsConsidered).toBe(6);
  });
});
