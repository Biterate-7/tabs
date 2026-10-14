import { describe, expect, it } from "vitest";
import { parseConversationText } from "./parse-text";
import { parseConversationExport } from "./exports";
import { readConversationCapture } from "./capture";
import { applyConversationSave, planConversationSave } from "./save";
import { IMPORT_FILE_MESSAGES, readImportFile } from "./import-file";
import { contentHash } from "./hash";
import { CONVERSATION_LIMITS } from "./types";
import type { ConversationInput } from "./types";
import type { WorkspaceStore } from "@/lib/workspace/types";

/**
 * Every way an AI conversation gets into Hubble — a paste, an AI app's own
 * export, the page Hubble for Chrome read — and the one save they share.
 */

const NOW = 1_800_000_000_000;

function store(): WorkspaceStore {
  return {
    version: 1,
    currentId: "a",
    workspaces: [
      { id: "a", name: "History IA", tabs: [], createdAt: 1, updatedAt: 1 },
      { id: "b", name: "Physics", tabs: [], createdAt: 1, updatedAt: 1 },
    ],
  };
}

let ids = 0;
const newId = () => `note-${++ids}`;

function conversation(over: Partial<ConversationInput> = {}): ConversationInput {
  return {
    provider: "chatgpt",
    title: "Causes of WW1",
    url: "https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666",
    conversationId: "6720a1b2-1111-2222-3333-444455556666",
    turns: [
      { role: "user", text: "What caused the First World War?" },
      { role: "assistant", text: "Historians point to militarism, alliances, imperialism and nationalism." },
    ],
    method: "page",
    ...over,
  };
}

/* ------------------------------------------------------------------ */

describe("parseConversationText (a paste)", () => {
  it("splits ChatGPT's own copied text into turns", () => {
    const parsed = parseConversationText("You said:\nWhat caused WW1?\n\nChatGPT said:\nSeveral long-term causes.\n\nYou said:\nWhich mattered most?\n\nChatGPT said:\nMost historians stress the alliance system.");
    expect(parsed.structured).toBe(true);
    expect(parsed.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(parsed.turns[3]!.text).toBe("Most historians stress the alliance system.");
  });

  it("splits Markdown and Q/A labels the same way", () => {
    expect(parseConversationText("## User\nHello there\n\n## Assistant\nHi!").turns).toEqual([
      { role: "user", text: "Hello there" },
      { role: "assistant", text: "Hi!" },
    ]);
    expect(parseConversationText("**Q:** Why?\n**A:** Because.").turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  it("does not guess: unlabelled or one-sided text is kept whole", () => {
    const plain = parseConversationText("Some notes I copied out of a chat.\n\nNo labels anywhere.");
    expect(plain).toEqual({ turns: [], text: "Some notes I copied out of a chat.\n\nNo labels anywhere.", structured: false });
    const oneSided = parseConversationText("User: one\n\nUser: two");
    expect(oneSided.structured).toBe(false);
    expect(oneSided.text).toContain("User: one");
  });

  it("keeps text before the first label with the first turn rather than losing it", () => {
    const parsed = parseConversationText("Context I pasted first.\nUser: question\nAssistant: answer");
    expect(parsed.turns[0]!.text).toBe("Context I pasted first.\n\nquestion");
  });

  it("strips characters that hide or reorder text, and treats an empty paste as nothing", () => {
    const parsed = parseConversationText("User: pay‮attention​\nAssistant: ok");
    expect(parsed.turns[0]!.text).toBe("payattention");
    expect(parseConversationText("   \n\n ")).toEqual({ turns: [], structured: false });
  });
});

/* ------------------------------------------------------------------ */

const CHATGPT_EXPORT = [
  {
    title: "Causes of WW1",
    create_time: 1_700_000_000,
    update_time: 1_700_000_500,
    conversation_id: "6720a1b2-1111-2222-3333-444455556666",
    current_node: "n4",
    mapping: {
      root: { message: null, parent: null },
      n0: { parent: "root", message: { author: { role: "system" }, content: { content_type: "text", parts: ["You are ChatGPT."] } } },
      n1: { parent: "n0", message: { author: { role: "user" }, create_time: 1_700_000_001, content: { content_type: "text", parts: ["What caused WW1?"] } } },
      // A tool call, addressed to a tool: never shown as a turn.
      n2: { parent: "n1", message: { author: { role: "assistant" }, recipient: "browser", content: { content_type: "code", text: "search('ww1')" } } },
      // An abandoned branch (edited prompt) is not on the visible thread.
      nX: { parent: "n1", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Old answer"] } } },
      n3: { parent: "n2", message: { author: { role: "assistant" }, metadata: { is_visually_hidden_from_conversation: true }, content: { content_type: "text", parts: ["hidden"] } } },
      n4: { parent: "n3", message: { author: { role: "assistant" }, create_time: 1_700_000_002, content: { content_type: "text", parts: ["Militarism, alliances, imperialism and nationalism."] } } },
    },
  },
  { title: "Empty", mapping: { root: { message: null, parent: null } }, current_node: "root" },
];

const CLAUDE_EXPORT = [
  {
    uuid: "0b6f6d3e-aaaa-bbbb-cccc-111122223333",
    name: "Thesis feedback",
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:05:00Z",
    chat_messages: [
      { sender: "human", text: "Is my thesis arguable?", created_at: "2026-10-01T10:00:00Z" },
      { sender: "assistant", content: [{ type: "text", text: "Yes, but narrow the time frame." }, { type: "tool_use" }] },
    ],
  },
];

describe("parseConversationExport (an AI app's own export)", () => {
  it("reads ChatGPT's conversations.json along the visible thread only", () => {
    const parsed = parseConversationExport(JSON.stringify(CHATGPT_EXPORT));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.format).toBe("chatgpt");
    expect(parsed.skipped).toBe(1);
    const [first] = parsed.conversations;
    expect(first!.turns).toEqual([
      { role: "user", text: "What caused WW1?", at: 1_700_000_001_000 },
      { role: "assistant", text: "Militarism, alliances, imperialism and nationalism.", at: 1_700_000_002_000 },
    ]);
    expect(first!.url).toBe("https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666");
    expect(first!.method).toBe("export");
    expect(first!.createdAt).toBe(1_700_000_000_000);
  });

  it("reads Claude's conversations.json, text blocks only", () => {
    const parsed = parseConversationExport(JSON.stringify({ conversations: CLAUDE_EXPORT }));
    expect(parsed.ok && parsed.format).toBe("claude");
    if (!parsed.ok) return;
    expect(parsed.conversations[0]).toMatchObject({
      provider: "claude",
      title: "Thesis feedback",
      url: "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb-cccc-111122223333",
      turns: [
        { role: "user", text: "Is my thesis arguable?" },
        { role: "assistant", text: "Yes, but narrow the time frame." },
      ],
    });
  });

  it("refuses what it cannot read, with a reason — never a silent empty import", () => {
    expect(parseConversationExport("{not json")).toEqual({ ok: false, reason: "malformed-json" });
    expect(parseConversationExport(JSON.stringify({ hello: "world" }))).toEqual({ ok: false, reason: "unknown-format" });
    expect(parseConversationExport(JSON.stringify([{ some: "thing" }]))).toEqual({ ok: false, reason: "unknown-format" });
    expect(parseConversationExport("[]")).toEqual({ ok: false, reason: "empty" });
    expect(parseConversationExport(JSON.stringify([CHATGPT_EXPORT[1]]))).toEqual({ ok: false, reason: "empty" });
  });

  it("titles an untitled conversation from its first words", () => {
    const parsed = parseConversationExport(JSON.stringify([{ ...CLAUDE_EXPORT[0], name: "" }]));
    expect(parsed.ok && parsed.conversations[0]!.title).toBe("Is my thesis arguable?");
  });
});

describe("readImportFile", () => {
  const file = (name: string, text: string, size = text.length) => ({ name, size, text: async () => text });

  it("recognises an export, and text files for paste-like import", async () => {
    expect(await readImportFile(file("conversations.json", JSON.stringify(CLAUDE_EXPORT)))).toMatchObject({ ok: true, kind: "export", provider: "claude" });
    expect(await readImportFile(file("thread.md", "# Perplexity thread"))).toEqual({ ok: true, kind: "text", text: "# Perplexity thread", fileName: "thread.md" });
  });

  it("refuses a zip, an unsupported type and a file past the size bound before reading it", async () => {
    let read = false;
    const spy = (name: string, size: number) => ({ name, size, text: async () => ((read = true), "") });
    expect(await readImportFile(spy("export.zip", 10))).toEqual({ ok: false, reason: "zip" });
    expect(await readImportFile(spy("photo.png", 10))).toEqual({ ok: false, reason: "unsupported-type" });
    expect(await readImportFile(spy("conversations.json", CONVERSATION_LIMITS.importBytes + 1))).toEqual({ ok: false, reason: "too-large" });
    expect(read).toBe(false);
    expect(IMPORT_FILE_MESSAGES.zip).toMatch(/Unzip it first/);
  });

  it("says why a JSON that is not an export was refused", async () => {
    expect(await readImportFile(file("data.json", "{}"))).toEqual({ ok: false, reason: "unknown-format" });
    expect(await readImportFile({ name: "x.txt", size: 1, text: async () => Promise.reject(new Error("gone")) })).toEqual({ ok: false, reason: "unreadable" });
  });
});

/* ------------------------------------------------------------------ */

describe("readConversationCapture (from Hubble for Chrome)", () => {
  it("decides the AI app from the address, never from the payload", () => {
    const read = readConversationCapture({ url: "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb-cccc-111122223333?x=1", provider: "chatgpt", title: "Thesis feedback - Claude", turns: [{ role: "user", text: "hi" }] });
    expect(read).toMatchObject({ ok: true, conversation: { provider: "claude", title: "Thesis feedback", url: "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb-cccc-111122223333", method: "page" } });
  });

  it("refuses an address that is not one conversation, and a malformed payload", () => {
    expect(readConversationCapture({ url: "https://chatgpt.com/", turns: [{ role: "user", text: "x" }] })).toEqual({ ok: false, reason: "not-a-conversation" });
    expect(readConversationCapture({ url: "https://evil.example/c/12345678", turns: [{ role: "user", text: "x" }] })).toEqual({ ok: false, reason: "not-a-conversation" });
    expect(readConversationCapture({ url: 42 })).toEqual({ ok: false, reason: "invalid" });
    expect(readConversationCapture({ url: "https://chatgpt.com/c/6720a1b2-1111", turns: [{ role: "system", text: "x" }] })).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a capture with no readable turns rather than saving an empty conversation", () => {
    expect(readConversationCapture({ url: "https://gemini.google.com/app/abc123def", turns: [{ role: "user", text: "  ​ " }] })).toEqual({ ok: false, reason: "empty" });
  });

  it("never titles a conversation with the app's own site title", () => {
    // Live 2026-10-14: a signed-out ChatGPT conversation keeps the site title.
    const read = readConversationCapture({ url: "https://chatgpt.com/uc/6acf1856-995c-83ea-9eae-31d150d62bcd", title: "ChatGPT: Chat, Work, Create & Code with AI", turns: [{ role: "user", text: "What role did the Schlieffen Plan play?" }, { role: "assistant", text: "A large one." }] });
    expect(read.ok && read.conversation.title).toBe("What role did the Schlieffen Plan play?");
    expect(read.ok && read.conversation.provider).toBe("chatgpt");
  });

  it("titles a generic page title from the first question", () => {
    const read = readConversationCapture({ url: "https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3", title: "Perplexity", turns: [{ role: "user", text: "Why is the sky blue?" }, { role: "assistant", text: "Rayleigh scattering." }] });
    expect(read.ok && read.conversation.title).toBe("Why is the sky blue?");
    expect(read.ok && read.conversation.provider).toBe("perplexity");
  });
});

/* ------------------------------------------------------------------ */

describe("planConversationSave / applyConversationSave", () => {
  it("adds a conversation with an address as a ready conversation source", () => {
    const plan = planConversationSave(store(), "a", conversation(), NOW, newId)!;
    expect(plan).toMatchObject({ target: "source", outcome: "added" });
    const next = applyConversationSave(store(), plan, NOW);
    const tab = next.workspaces[0]!.tabs[0]!;
    expect(tab.resource).toMatchObject({ kind: "conversation", status: "ready", origin: "extension", meta: { provider: "chatgpt", turnCount: 2, capture: "page", contentHash: contentHash(conversation()) } });
    expect(plan.content.turns).toHaveLength(2);
  });

  it("recognises the same conversation saved again: unchanged, then updated in place when it grew", () => {
    const first = planConversationSave(store(), "a", conversation(), NOW, newId)!;
    let saved = applyConversationSave(store(), first, NOW);
    saved = { ...saved, workspaces: saved.workspaces.map((ws) => (ws.id === "a" ? { ...ws, tabs: ws.tabs.map((tab) => ({ ...tab, title: "My renamed chat" })) } : ws)) };

    const again = planConversationSave(saved, "a", conversation(), NOW + 1, newId)!;
    expect(again.outcome).toBe("unchanged");
    expect(applyConversationSave(saved, again, NOW + 1)).toBe(saved);

    const grown = conversation({ turns: [...conversation().turns, { role: "user", text: "And the assassination?" }] });
    const update = planConversationSave(saved, "a", grown, NOW + 2, newId)!;
    expect(update).toMatchObject({ target: "source", outcome: "updated", id: first.id });
    const after = applyConversationSave(saved, update, NOW + 2);
    expect(after.workspaces[0]!.tabs).toHaveLength(1);
    expect(after.workspaces[0]!.tabs[0]!.title).toBe("My renamed chat");
    expect(after.workspaces[0]!.tabs[0]!.resource!.meta!.turnCount).toBe(3);
  });

  it("never replaces a longer saved copy with a shorter capture (a thread not fully loaded, or part of it pasted)", () => {
    const long = conversation({ turns: [...conversation().turns, { role: "user", text: "And Belgium?" }, { role: "assistant", text: "Its neutrality brought Britain in." }] });
    const saved = applyConversationSave(store(), planConversationSave(store(), "a", long, NOW, newId)!, NOW);
    const partial = planConversationSave(saved, "a", conversation({ turns: [conversation().turns[0]!] }), NOW + 1, newId)!;
    expect(partial).toMatchObject({ target: "source", outcome: "kept" });
    expect(applyConversationSave(saved, partial, NOW + 1)).toBe(saved);
    expect(saved.workspaces[0]!.tabs[0]!.resource!.meta!.turnCount).toBe(4);
  });

  it("keeps projects separate: the same conversation in another project is its own item", () => {
    const intoA = applyConversationSave(store(), planConversationSave(store(), "a", conversation(), NOW, newId)!, NOW);
    const plan = planConversationSave(intoA, "b", conversation(), NOW, newId)!;
    expect(plan.outcome).toBe("added");
    const both = applyConversationSave(intoA, plan, NOW);
    expect(both.workspaces.map((ws) => ws.tabs.length)).toEqual([1, 1]);
  });

  it("turns a plain saved tab with the same address into the conversation, keeping its id", () => {
    const withTab: WorkspaceStore = { ...store(), workspaces: [{ ...store().workspaces[0]!, tabs: [{ id: "t1", url: conversation().url!, normalizedUrl: conversation().url!, domain: "chatgpt.com" }] }, store().workspaces[1]!] };
    const plan = planConversationSave(withTab, "a", conversation(), NOW, newId)!;
    expect(plan).toMatchObject({ outcome: "added", id: "t1" });
    expect(applyConversationSave(withTab, plan, NOW).workspaces[0]!.tabs[0]!.title).toBe("Causes of WW1");
  });

  it("saves a paste without an address as a conversation note, and recognises it pasted twice", () => {
    const pasted = conversation({ url: undefined, conversationId: undefined, method: "paste", provider: "gemini" });
    const plan = planConversationSave(store(), "a", pasted, NOW, newId)!;
    expect(plan).toMatchObject({ target: "note", outcome: "added", note: { kind: "conversation", provider: "gemini", origin: "paste", turns: 2 } });
    const saved = applyConversationSave(store(), plan, NOW);
    expect(saved.workspaces[0]!.notes).toHaveLength(1);
    expect(planConversationSave(saved, "a", pasted, NOW, newId)!.outcome).toBe("unchanged");
  });

  it("keeps unsplit text whole, and refuses a project that does not exist", () => {
    const plan = planConversationSave(store(), "a", conversation({ url: undefined, turns: [], text: "One long unlabelled paste.", method: "paste" }), NOW, newId)!;
    expect(plan.content.text).toBe("One long unlabelled paste.");
    expect(plan.content.turns).toBeUndefined();
    expect(planConversationSave(store(), "missing", conversation(), NOW, newId)).toBeUndefined();
  });
});
