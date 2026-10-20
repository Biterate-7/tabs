import { describe, expect, it } from "vitest";
import { readConversationCapture } from "./capture";
import { findSavedConversation } from "./lookup";
import { applyConversationSave, planConversationSave } from "./save";
import { applyIngestion, planIngestion } from "@/lib/resources/ingest";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ConversationInput } from "./types";
import type { WorkspaceStore } from "@/lib/workspace/types";

/**
 * Regression: saving one conversation from an AI app must never make a
 * second conversation from the same app look saved, or stop it being saved.
 * Conversations are told apart by provider and conversation id — the same
 * rule for a save from the page, "Add this tab", "Add selected tabs" and the
 * popup's "already saved" answer — for every provider Hubble supports.
 */

const NOW = 1_800_000_000_000;
const MATHS = "maths";
const PHYSICS = "physics";

function store(): WorkspaceStore {
  return {
    version: 1,
    currentId: MATHS,
    workspaces: [
      { id: MATHS, name: "Mathematics AA HL", tabs: [], createdAt: 1, updatedAt: 1 },
      { id: PHYSICS, name: "Physics", tabs: [], createdAt: 1, updatedAt: 1 },
    ],
  };
}

let ids = 0;
const newId = () => `id-${++ids}`;

/** Two different conversations of each provider, as Hubble for Chrome sends them (the address Chrome reports). */
const PROVIDERS: readonly { provider: AiProviderId; a: string; b: string; variantOfA: string }[] = [
  { provider: "chatgpt", a: "https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666", b: "https://chatgpt.com/c/68f0c3d4-aaaa-bbbb-cccc-ddddeeeeffff", variantOfA: "https://chat.openai.com/c/6720a1b2-1111-2222-3333-444455556666/?model=gpt-4o" },
  { provider: "claude", a: "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb-cccc-111122223333", b: "https://claude.ai/chat/7e8f9a0b-aaaa-bbbb-cccc-111122223333", variantOfA: "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb-cccc-111122223333/#reply" },
  { provider: "gemini", a: "https://gemini.google.com/app/1a2b3c4d5e6f7a8b", b: "https://gemini.google.com/app/9f8e7d6c5b4a3f2e", variantOfA: "https://gemini.google.com/app/1a2b3c4d5e6f7a8b?hl=en-GB" },
  { provider: "perplexity", a: "https://www.perplexity.ai/search/integration-by-parts-Xq3k9aT1", b: "https://www.perplexity.ai/search/integration-by-parts-Lm8n2pQ4", variantOfA: "https://perplexity.ai/search/integration-by-parts-Xq3k9aT1?s=u" },
];

/** A capture as the page would read it, through the same validation a real save takes. */
function captured(url: string, question: string, title = "Integration by parts"): ConversationInput {
  const read = readConversationCapture({ url, title, turns: [{ role: "user", text: question }, { role: "assistant", text: `An answer to: ${question}` }] });
  if (!read.ok) throw new Error(`capture refused: ${read.reason}`);
  return read.conversation;
}

/** Plan and apply, the way the shell's saveConversations does. */
function save(into: WorkspaceStore, workspaceId: string, input: ConversationInput) {
  const plan = planConversationSave(into, workspaceId, input, NOW, newId)!;
  return { plan, store: applyConversationSave(into, plan, NOW) };
}

const sources = (s: WorkspaceStore, workspaceId: string) => s.workspaces.find((ws) => ws.id === workspaceId)!.tabs.filter((tab) => tab.resource);

describe.each(PROVIDERS)("$provider: one conversation never stands in for another", ({ provider, a, b, variantOfA }) => {
  it("saves A, then B separately into the same project, and recognises A again", () => {
    const first = save(store(), MATHS, captured(a, "Integrate x e^x"));
    expect(first.plan.outcome).toBe("added");

    const second = save(first.store, MATHS, captured(b, "Integrate x sin x"));
    expect(second.plan.outcome).toBe("added");
    expect(second.plan.id).not.toBe(first.plan.id);
    expect(sources(second.store, MATHS)).toHaveLength(2);
    expect(sources(second.store, MATHS).map((tab) => tab.resource!.meta!.provider)).toEqual([provider, provider]);

    // Back on A: the same conversation, the same text — already saved, nothing written.
    const again = save(second.store, MATHS, captured(a, "Integrate x e^x"));
    expect(again.plan).toMatchObject({ outcome: "unchanged", id: first.plan.id });
    expect(again.store).toBe(second.store);
  });

  it("saves two conversations with the same title as two items", () => {
    const first = save(store(), MATHS, captured(a, "Integrate x e^x", "Calculus help"));
    const second = save(first.store, MATHS, captured(b, "Integrate ln x", "Calculus help"));
    expect(second.plan.outcome).toBe("added");
    expect(sources(second.store, MATHS).map((tab) => tab.title)).toEqual(["Calculus help", "Calculus help"]);
  });

  it("recognises A at a harmless variant of its address, and updates it in place when it grew", () => {
    const first = save(store(), MATHS, captured(a, "Integrate x e^x"));
    expect(save(first.store, MATHS, captured(variantOfA, "Integrate x e^x")).plan).toMatchObject({ outcome: "unchanged", id: first.plan.id });

    const grown = captured(variantOfA, "Integrate x e^x");
    grown.turns = [...grown.turns, { role: "user", text: "Now with limits 0 to 1" }];
    const update = save(first.store, MATHS, grown);
    expect(update.plan).toMatchObject({ outcome: "updated", id: first.plan.id });
    expect(sources(update.store, MATHS)).toHaveLength(1);
  });

  it("saves the same conversation into a second project as that project's own item, leaving the first alone", () => {
    const first = save(store(), MATHS, captured(a, "Integrate x e^x"));
    const other = save(first.store, PHYSICS, captured(a, "Integrate x e^x"));
    expect(other.plan.outcome).toBe("added");
    expect(sources(other.store, MATHS)).toEqual(sources(first.store, MATHS));
    expect(sources(other.store, PHYSICS)).toHaveLength(1);
  });

  it("answers 'already saved' for A only — never for B because A is saved", () => {
    const saved = save(store(), MATHS, captured(a, "Integrate x e^x")).store;
    expect(findSavedConversation(saved, a)).toEqual([expect.objectContaining({ workspaceId: MATHS, hasText: true })]);
    expect(findSavedConversation(saved, variantOfA)).toHaveLength(1);
    expect(findSavedConversation(saved, b)).toEqual([]);
  });

  it("keeps one copy when two saves of the same conversation race (two clicks, or Chrome and Hubble Desktop)", () => {
    const empty = store();
    // Both planned against the same store, before either landed — as two saves writing their text at once are.
    const one = planConversationSave(empty, MATHS, captured(a, "Integrate x e^x"), NOW, newId)!;
    const two = planConversationSave(empty, MATHS, captured(a, "Integrate x e^x"), NOW, newId)!;
    expect(one.id).not.toBe(two.id);
    const afterOne = applyConversationSave(empty, one, NOW);
    expect(applyConversationSave(afterOne, two, NOW)).toBe(afterOne);
    expect(sources(afterOne, MATHS)).toHaveLength(1);
    // Different conversations racing both land.
    const three = planConversationSave(empty, MATHS, captured(b, "Integrate x sin x"), NOW, newId)!;
    expect(sources(applyConversationSave(afterOne, three, NOW), MATHS)).toHaveLength(2);
  });

  it("adds two of its conversations with 'Add selected tabs' as two sources, and then sees each as a duplicate of itself only", () => {
    const plan = planIngestion({ workspace: store().workspaces[0]!, inputs: [{ url: a }, { url: b }], origin: "extension", now: NOW });
    expect(plan.outcomes.map((outcome) => outcome.status)).toEqual(["added", "added"]);
    const withBoth = applyIngestion(store(), plan, "extension", NOW);

    const again = planIngestion({ workspace: withBoth.workspaces[0]!, inputs: [{ url: variantOfA }], origin: "extension", now: NOW });
    expect(again.outcomes).toEqual([expect.objectContaining({ status: "duplicate", tabId: plan.added[0]!.id })]);
  });

  it("fills in a conversation added by 'Add this tab' when it is then saved from the page, instead of adding a second item", () => {
    const linked = applyIngestion(store(), planIngestion({ workspace: store().workspaces[0]!, inputs: [{ url: variantOfA }], origin: "extension", now: NOW }), "extension", NOW);
    const linkId = sources(linked, MATHS)[0]!.id;
    expect(findSavedConversation(linked, a)).toEqual([expect.objectContaining({ tabId: linkId, hasText: false })]);

    const filled = save(linked, MATHS, captured(a, "Integrate x e^x"));
    expect(filled.plan).toMatchObject({ outcome: "updated", id: linkId });
    expect(sources(filled.store, MATHS)).toHaveLength(1);
    expect(sources(filled.store, MATHS)[0]!.resource).toMatchObject({ kind: "conversation", status: "ready" });
  });
});

describe("conversations from different apps", () => {
  it("stay independent, even with the same id string and title", () => {
    const chatgpt = save(store(), MATHS, captured("https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666", "Integrate x e^x", "Calculus"));
    const claude = save(chatgpt.store, MATHS, captured("https://claude.ai/chat/6720a1b2-1111-2222-3333-444455556666", "Integrate x e^x", "Calculus"));
    expect(claude.plan.outcome).toBe("added");
    expect(sources(claude.store, MATHS).map((tab) => tab.resource!.meta!.provider)).toEqual(["chatgpt", "claude"]);
  });

  it("answers nothing for an app's home page: it names no conversation, so nothing saved is claimed for it", () => {
    const saved = save(store(), MATHS, captured("https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666", "Integrate x e^x")).store;
    for (const page of ["https://chatgpt.com/", "https://chatgpt.com/?model=gpt-4o", "https://claude.ai/new", "https://gemini.google.com/app", "https://www.perplexity.ai/"]) {
      expect(findSavedConversation(saved, page), page).toBeUndefined();
    }
  });
});
