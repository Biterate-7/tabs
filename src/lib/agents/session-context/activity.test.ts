// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { measureContextAnswer, measureAnswerPayload } from "./activity";
import { STUDENT, bind, call, closeServers, harness, until } from "./__fixtures__/harness";
import type { ContextActivity } from "./activity";
import type { SessionContextBinding } from "./registry";

/**
 * The context server measuring its own answers — the real loopback server,
 * session MCP server, registry and official MCP client. What the timeline
 * says ("Found 14 relevant tabs") must be what the agent was actually told,
 * so each assertion compares the reported count with the answer itself.
 */

afterEach(closeServers);

function listen(h: ReturnType<typeof harness>) {
  const heard: { sessionId: string; binding: SessionContextBinding; activity: ContextActivity }[] = [];
  h.registry.setActivityListener((sessionId, binding, activity) => heard.push({ sessionId, binding, activity }));
  return heard;
}

describe("each read reports what its answer held", () => {
  it("the summary: the workspace's tabs and collections", async () => {
    const h = harness();
    const heard = listen(h);
    const client = await bind(h);
    const answer = (await call(client, "get_workspace_summary")).json();
    await until(() => heard.length === 1);
    expect(heard[0]).toMatchObject({
      sessionId: "s1",
      activity: { tool: "get_workspace_summary", ok: true, tabs: answer.tabs.total, collections: answer.collections.total },
    });
    expect(heard[0]!.activity.tabs).toBe(STUDENT.workspace.tabs.length);
    expect(heard[0]!.binding.workspaceId).toBe("ws-student");
  });

  it("a search: its own total, not the page it returned", async () => {
    const h = harness();
    const heard = listen(h);
    const client = await bind(h);
    const answer = (await call(client, "search_tabs", { query: "physics", maxResults: 1 })).json();
    await until(() => heard.length === 1);
    expect(answer.totalMatches).toBeGreaterThan(1);
    expect(heard[0]!.activity).toMatchObject({ tool: "search_tabs", ok: true, matches: answer.totalMatches, tabs: 1 });
  });

  it("a page of tabs: the tabs on the page", async () => {
    const h = harness();
    const heard = listen(h);
    const client = await bind(h);
    const answer = (await call(client, "list_tabs", { limit: 3 })).json();
    await until(() => heard.length === 1);
    expect(heard[0]!.activity.tabs).toBe(answer.items.filter((item: { sourceType: string }) => item.sourceType === "tab").length);
    expect(heard[0]!.activity.tabs).toBe(3);
  });

  it("topics and duplicates: the groups found", async () => {
    const h = harness();
    const heard = listen(h);
    const client = await bind(h);
    const topics = (await call(client, "analyze_topics")).json();
    const duplicates = (await call(client, "find_duplicate_tabs")).json();
    await until(() => heard.length === 2);
    expect(heard[0]!.activity).toMatchObject({ tool: "analyze_topics", groups: topics.groups.length + (topics.moreGroups ?? 0), tabs: topics.tabsConsidered });
    expect(heard[1]!.activity).toMatchObject({ tool: "find_duplicate_tabs", groups: duplicates.totalGroups });
  });

  it("a refused read is reported as not answered", async () => {
    const h = harness();
    const heard = listen(h);
    const client = await bind(h);
    expect((await call(client, "get_workspace", { workspaceId: "ws-private" })).isError).toBe(true);
    await until(() => heard.length === 1);
    expect(heard[0]!.activity).toEqual({ tool: "get_workspace", ok: false });
  });
});

describe("what is never reported", () => {
  it("a proposal: the approval says it, not a read", async () => {
    const h = harness();
    const heard = listen(h);
    const client = await bind(h);
    const proposal = call(client, "create_collection", { name: "Mechanics", tabIds: ["p1"] });
    await until(() => h.asked.length === 1);
    h.answer("denied");
    await proposal;
    expect(heard).toEqual([]);
  });

  it("anything about another session's workspace", async () => {
    const h = harness();
    const heard = listen(h);
    const client = await bind(h);
    await call(client, "search_tabs", { query: "bank" });
    await until(() => heard.length === 1);
    expect(heard.every((entry) => entry.sessionId === "s1" && entry.binding.workspaceId === "ws-student")).toBe(true);
  });

  it("anything once the session's credential is released", async () => {
    const h = harness();
    const heard = listen(h);
    const client = await bind(h);
    h.registry.release("s1");
    await call(client, "get_workspace_summary").catch(() => undefined);
    expect(heard).toEqual([]);
  });

  it("titles, URLs, ids or query words — only counts and the tool's name", async () => {
    const h = harness();
    const heard = listen(h);
    const client = await bind(h);
    await call(client, "search_tabs", { query: "physics" });
    await call(client, "get_tabs", { tabIds: ["p1"] });
    await until(() => heard.length === 2);
    for (const { activity } of heard) {
      for (const [key, value] of Object.entries(activity)) {
        if (key === "tool") continue;
        expect(["number", "boolean"]).toContain(typeof value);
      }
    }
  });
});

describe("observational", () => {
  it("an answer reaches the agent unchanged even when the listener throws", async () => {
    const h = harness();
    h.registry.setActivityListener(() => {
      throw new Error("timeline storage is down");
    });
    const client = await bind(h);
    const answer = await call(client, "get_workspace_summary");
    expect(answer.isError).toBe(false);
    expect(answer.json().tabs.total).toBe(STUDENT.workspace.tabs.length);
  });

  it("an answer it cannot read is measured as answered, with no counts", () => {
    expect(measureContextAnswer("get_tabs", { content: [{ type: "text", text: "not json" }] })).toEqual({ tool: "get_tabs", ok: true });
    expect(measureContextAnswer("get_tabs", undefined)).toEqual({ tool: "get_tabs", ok: false });
    expect(measureContextAnswer("not_a_tool", { content: [] })).toBeUndefined();
    expect(measureContextAnswer("propose_workspace_plan", { content: [] })).toBeUndefined();
    expect(measureAnswerPayload({ totalMatches: -3, items: "x", groups: 4 })).toEqual({});
  });
});
