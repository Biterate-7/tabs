import { describe, expect, it } from "vitest";
import { AI_PROVIDER_IDS, AI_PROVIDERS, aiProviderName, conversationRefOf, conversationUrlFor, isAiProviderId, isNewChatUrl, providerOfUrl } from "./registry";

/**
 * The provider registry is what Hubble claims about each AI app. These tests
 * keep the claims honest: nothing is marked as syncing automatically, and
 * every "supported" capability says how it was checked.
 */

describe("conversation addresses", () => {
  it.each([
    ["https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666", "chatgpt", "6720a1b2-1111-2222-3333-444455556666"],
    ["https://chatgpt.com/g/g-abc-tutor/c/6720a1b2-1111-2222", "chatgpt", "6720a1b2-1111-2222"],
    ["https://chat.openai.com/share/6720a1b2-9999", "chatgpt", "6720a1b2-9999"],
    ["https://claude.ai/chat/0b6f6d3e-aaaa-bbbb-cccc-111122223333", "claude", "0b6f6d3e-aaaa-bbbb-cccc-111122223333"],
    ["https://gemini.google.com/app/1a2b3c4d5e6f", "gemini", "1a2b3c4d5e6f"],
    ["https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3", "perplexity", "why-is-the-sky-blue-x1y2z3"],
  ] as const)("%s names one %s conversation", (url, provider, conversationId) => {
    expect(conversationRefOf(url)).toEqual({ provider, conversationId, url });
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
