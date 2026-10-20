import { describe, expect, it } from "vitest";
import { AI_PROVIDER_IDS, AI_PROVIDERS, aiProviderName, conversationKeyOf, conversationRefOf, conversationUrlFor, isAiProviderId, isNewChatUrl, providerOfUrl } from "./registry";

/**
 * The provider registry is what Hubble claims about each AI app. These tests
 * keep the claims honest: nothing is marked as syncing automatically, and
 * every "supported" capability says how it was checked.
 */

describe("conversation addresses", () => {
  it.each([
    ["https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666", "chatgpt", "6720a1b2-1111-2222-3333-444455556666", "chat"],
    ["https://chatgpt.com/g/g-abc-tutor/c/6720a1b2-1111-2222", "chatgpt", "6720a1b2-1111-2222", "chat"],
    ["https://chatgpt.com/uc/6720a1b2-1111-2222", "chatgpt", "6720a1b2-1111-2222", "signed-out"],
    ["https://chat.openai.com/share/6720a1b2-9999", "chatgpt", "6720a1b2-9999", "share"],
    ["https://claude.ai/chat/0b6f6d3e-aaaa-bbbb-cccc-111122223333", "claude", "0b6f6d3e-aaaa-bbbb-cccc-111122223333", "chat"],
    ["https://claude.ai/share/0b6f6d3e-aaaa-bbbb", "claude", "0b6f6d3e-aaaa-bbbb", "share"],
    ["https://gemini.google.com/app/1a2b3c4d5e6f", "gemini", "1a2b3c4d5e6f", "chat"],
    ["https://gemini.google.com/gem/study-buddy/1a2b3c4d5e6f", "gemini", "1a2b3c4d5e6f", "chat"],
    ["https://gemini.google.com/share/9f8e7d6c5b4a", "gemini", "9f8e7d6c5b4a", "share"],
    ["https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3", "perplexity", "why-is-the-sky-blue-x1y2z3", "chat"],
  ] as const)("%s names one %s conversation", (url, provider, conversationId, kind) => {
    expect(conversationRefOf(url)).toEqual({ provider, conversationId, url, key: `${provider}:${kind}:${conversationId}` });
    expect(conversationKeyOf(url)).toBe(`${provider}:${kind}:${conversationId}`);
  });

  it("drops the query and fragment, which is what a saved conversation is keyed on", () => {
    expect(conversationRefOf("https://claude.ai/chat/0b6f6d3e-aaaa-bbbb?ref=x#end")!.url).toBe("https://claude.ai/chat/0b6f6d3e-aaaa-bbbb");
  });

  it.each(["https://chatgpt.com/", "https://claude.ai/new", "https://gemini.google.com/app", "https://www.perplexity.ai/", "https://example.com/c/6720a1b2-1111", "javascript:alert(1)", "not a url"])(
    "%s is not a conversation",
    (url) => {
      expect(conversationRefOf(url)).toBeUndefined();
    }
  );

  it("knows an AI app's pages that are not conversations", () => {
    expect(providerOfUrl("https://claude.ai/settings")).toBe("claude");
    expect(providerOfUrl("https://claude.ai.evil.example/chat/x")).toBeUndefined();
  });

  it("builds a conversation's address from an export id only when the id is plausible", () => {
    expect(conversationUrlFor("chatgpt", "6720a1b2-1111")).toBe("https://chatgpt.com/c/6720a1b2-1111");
    expect(conversationUrlFor("claude", "../../etc")).toBeUndefined();
    expect(conversationUrlFor("perplexity", "abcdef123")).toBeUndefined();
  });
});

/**
 * Which conversation an address names — the identity every save, duplicate
 * check and "already saved" answer uses. Regression: a second chat from the
 * same app must never be taken for the first.
 */
describe("conversation identity", () => {
  // Two different conversations of each provider, on the address shapes the registry supports.
  const PAIRS: readonly [string, string, string][] = [
    ["chatgpt", "https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666", "https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556667"],
    ["claude", "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb-cccc-111122223333", "https://claude.ai/chat/9c8d7e6f-aaaa-bbbb-cccc-111122223333"],
    ["gemini", "https://gemini.google.com/app/1a2b3c4d5e6f", "https://gemini.google.com/app/6f5e4d3c2b1a"],
    ["perplexity", "https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3", "https://www.perplexity.ai/search/why-is-the-sky-blue-q9r8s7"],
  ];

  it.each(PAIRS)("two %s conversations are two identities", (_provider, a, b) => {
    expect(conversationKeyOf(a)).toBeDefined();
    expect(conversationKeyOf(b)).toBeDefined();
    expect(conversationKeyOf(a)).not.toBe(conversationKeyOf(b));
  });

  it.each([
    ["https://chatgpt.com/c/6720a1b2-1111-2222", ["https://chatgpt.com/c/6720a1b2-1111-2222/", "https://chatgpt.com/c/6720a1b2-1111-2222?model=gpt-4o", "https://chatgpt.com/c/6720a1b2-1111-2222#reply", "https://chat.openai.com/c/6720a1b2-1111-2222", "https://chatgpt.com/g/g-abc-tutor/c/6720a1b2-1111-2222"]],
    ["https://claude.ai/chat/0b6f6d3e-aaaa-bbbb", ["https://claude.ai/chat/0b6f6d3e-aaaa-bbbb/", "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb?ref=sidebar", "http://claude.ai/chat/0b6f6d3e-aaaa-bbbb"]],
    ["https://gemini.google.com/app/1a2b3c4d5e6f", ["https://gemini.google.com/app/1a2b3c4d5e6f/", "https://gemini.google.com/app/1a2b3c4d5e6f?hl=en", "https://gemini.google.com/gem/study-buddy/1a2b3c4d5e6f"]],
    ["https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3", ["https://perplexity.ai/search/why-is-the-sky-blue-x1y2z3", "https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3/?s=u", "https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3#0"]],
  ] as const)("harmless differences in %s's address are the same conversation", (canonical, variants) => {
    for (const variant of variants) expect(conversationKeyOf(variant), variant).toBe(conversationKeyOf(canonical));
  });

  it("never conflates ids that only look alike", () => {
    const base = "https://chatgpt.com/c/6720a1b2-1111-2222";
    for (const other of ["https://chatgpt.com/c/6720A1B2-1111-2222", "https://chatgpt.com/c/6720a1b2-1111-22222", "https://chatgpt.com/c/6720a1b2-1111-222"]) {
      expect(conversationKeyOf(other), other).not.toBe(conversationKeyOf(base));
    }
  });

  it("keeps a share link and a signed-out chat apart from a chat with the same id string, and providers apart from each other", () => {
    expect(conversationKeyOf("https://chatgpt.com/share/6720a1b2-1111-2222")).not.toBe(conversationKeyOf("https://chatgpt.com/c/6720a1b2-1111-2222"));
    expect(conversationKeyOf("https://chatgpt.com/uc/6720a1b2-1111-2222")).not.toBe(conversationKeyOf("https://chatgpt.com/c/6720a1b2-1111-2222"));
    expect(conversationKeyOf("https://claude.ai/share/0b6f6d3e-aaaa-bbbb")).not.toBe(conversationKeyOf("https://claude.ai/chat/0b6f6d3e-aaaa-bbbb"));
    expect(conversationKeyOf("https://claude.ai/chat/6720a1b2-1111-2222")).not.toBe(conversationKeyOf("https://chatgpt.com/c/6720a1b2-1111-2222"));
  });

  it.each([
    "https://chatgpt.com/",
    "https://chatgpt.com/?model=gpt-4o",
    "https://chatgpt.com/c/",
    "https://chatgpt.com/c/short",
    "https://chatgpt.com/gpts",
    "https://chatgpt.com/c/6720a1b2-1111-2222/extra",
    "https://claude.ai/new",
    "https://claude.ai/recents",
    "https://gemini.google.com/app",
    "https://www.perplexity.ai/",
    "https://www.perplexity.ai/library",
    "https://claude.ai.evil.example/chat/0b6f6d3e-aaaa-bbbb",
    "not a url",
  ])("%s names no conversation, so nothing is ever matched against it", (url) => {
    expect(conversationKeyOf(url)).toBeUndefined();
  });
});

describe("capabilities", () => {
  it("claims no automatic sync for any AI app", () => {
    for (const id of AI_PROVIDER_IDS) expect(AI_PROVIDERS[id].capabilities.autoSync.supported).toBe(false);
  });

  it("says how every supported capability was checked, and explains every one", () => {
    for (const id of AI_PROVIDER_IDS) {
      for (const [name, capability] of Object.entries(AI_PROVIDERS[id].capabilities)) {
        expect(capability.note.length, `${id}.${name}`).toBeGreaterThan(10);
        if (capability.supported) expect(capability.verified, `${id}.${name}`).not.toBe("none");
      }
    }
  });

  it("reads exports only where Hubble has a parser for them", () => {
    expect(AI_PROVIDER_IDS.filter((id) => AI_PROVIDERS[id].capabilities.exportImport.supported)).toEqual(["chatgpt", "claude"]);
  });

  it("names providers, and nothing else", () => {
    expect(aiProviderName("gemini")).toBe("Gemini");
    expect(aiProviderName("grok")).toBe("AI");
    expect(isAiProviderId("perplexity")).toBe(true);
    expect(isAiProviderId("claude-code")).toBe(false);
  });
});

describe("Use in AI targets", () => {
  it.each([
    ["chatgpt", "https://chatgpt.com/"],
    ["claude", "https://claude.ai/new"],
    ["gemini", "https://gemini.google.com/app"],
    ["perplexity", "https://www.perplexity.ai/"],
  ] as const)("%s starts a new chat at its official address, %s", (id, url) => {
    expect(AI_PROVIDERS[id].homeUrl).toBe(url);
    expect(isNewChatUrl(id, url)).toBe(true);
    expect(providerOfUrl(url)).toBe(id);
  });

  it("never takes a conversation, another provider's page, or plain http as a new chat", () => {
    expect(isNewChatUrl("chatgpt", "https://chatgpt.com/c/6720a1b2-1111")).toBe(false);
    expect(isNewChatUrl("claude", "https://chatgpt.com/")).toBe(false);
    expect(isNewChatUrl("claude", "http://claude.ai/new")).toBe(false);
    expect(isNewChatUrl("gemini", "https://gemini.google.com/app/1a2b3c4d5e6f")).toBe(false);
  });

  it("keeps every message limit within what the extension accepts, and says how transfer claims were checked", () => {
    for (const id of AI_PROVIDER_IDS) {
      const provider = AI_PROVIDERS[id];
      expect(provider.transfer.messageChars).toBeLessThanOrEqual(200_000);
      expect(provider.transfer.maxFiles).toBeGreaterThan(0);
      for (const capability of [provider.capabilities.insert, provider.capabilities.attachFiles, provider.capabilities.autoSubmit]) {
        expect(capability.verified).not.toBe("none");
      }
    }
  });
});
