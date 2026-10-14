// The AI-page reader and the message-box insert, run against saved page
// fixtures shaped like each app's markup. These are fixtures, not the live
// apps: they hold the code to the structure it was written for, and the
// failure paths (an unrecognised layout, no message box) to an honest
// reason instead of a guess.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_PAGE_HOSTS, aiProviderOf, insertIntoComposer, isConversationUrl, readConversationFromPage } from "./ai-pages.js";
import { AI_PROVIDERS, AI_PROVIDER_IDS, conversationRefOf, providerOfUrl } from "../../src/lib/providers/registry";

function page(html, title = "") {
  const doc = document.implementation.createHTMLDocument(title);
  doc.body.innerHTML = html;
  return doc;
}

afterEach(() => vi.restoreAllMocks());

describe("which pages are AI conversations", () => {
  it("knows the same hosts as the web app's provider registry", () => {
    for (const id of AI_PROVIDER_IDS) expect([...AI_PAGE_HOSTS[id]].sort()).toEqual([...AI_PROVIDERS[id].hosts].sort());
  });

  it.each([
    "https://chatgpt.com/c/6720a1b2-1111-2222",
    "https://chatgpt.com/g/g-abc-tutor/c/6720a1b2-1111-2222",
    "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb",
    "https://gemini.google.com/app/1a2b3c4d5e6f",
    "https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3",
    "https://chatgpt.com/",
    "https://claude.ai/settings",
    "https://example.com/c/6720a1b2-1111",
    "not a url",
  ])("agrees with the web app about %s", (url) => {
    expect(isConversationUrl(url)).toBe(Boolean(conversationRefOf(url)));
    expect(aiProviderOf(url)).toBe(providerOfUrl(url));
  });
});

describe("readConversationFromPage", () => {
  it("reads ChatGPT's messages by author role, leaving the sidebar out", () => {
    const doc = page(
      `<nav><a href="/c/other">Another chat about energy</a></nav>
       <main>
         <div data-message-author-role="user"><div class="whitespace-pre-wrap">What caused WW1?</div></div>
         <div data-message-author-role="assistant"><div class="markdown"><p>Militarism and alliances.</p></div></div>
         <div data-message-author-role="tool"><div>search results</div></div>
       </main>`,
      "Causes of WW1"
    );
    const read = readConversationFromPage(doc, "https://chatgpt.com/c/6720a1b2-1111-2222");
    expect(read).toEqual({
      ok: true,
      provider: "chatgpt",
      url: "https://chatgpt.com/c/6720a1b2-1111-2222",
      title: "Causes of WW1",
      turns: [
        { role: "user", text: "What caused WW1?" },
        { role: "assistant", text: "Militarism and alliances." },
      ],
      truncated: false,
    });
  });

  it("reads Claude's user and response blocks, joining one reply split across nodes", () => {
    const doc = page(
      `<div data-testid="user-message">Is my thesis arguable?</div>
       <div class="font-claude-response"><p>Yes.</p></div>
       <div class="font-claude-response"><p>Narrow the time frame.</p></div>`,
      "Thesis feedback - Claude"
    );
    const read = readConversationFromPage(doc, "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb");
    expect(read.ok).toBe(true);
    expect(read.turns).toEqual([
      { role: "user", text: "Is my thesis arguable?" },
      { role: "assistant", text: "Yes.\n\nNarrow the time frame." },
    ]);
  });

  it("reads Gemini's query and response elements", () => {
    const doc = page(
      `<user-query><div class="query-text">Explain photosynthesis</div></user-query>
       <model-response><message-content><p>Plants turn light into chemical energy.</p></message-content></model-response>`
    );
    const read = readConversationFromPage(doc, "https://gemini.google.com/app/1a2b3c4d5e6f");
    expect(read.provider).toBe("gemini");
    expect(read.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  it("reads Perplexity's query and answer", () => {
    const doc = page(
      `<div data-testid="query-text">Why is the sky blue?</div>
       <div class="prose"><p>Rayleigh scattering.</p></div>`
    );
    const read = readConversationFromPage(doc, "https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3");
    expect(read.turns).toEqual([
      { role: "user", text: "Why is the sky blue?" },
      { role: "assistant", text: "Rayleigh scattering." },
    ]);
  });

  it("says when a page's layout has no messages it recognises, rather than saving nothing", () => {
    const doc = page(`<main><div class="some-new-layout">What caused WW1?</div></main>`);
    expect(readConversationFromPage(doc, "https://chatgpt.com/c/6720a1b2-1111-2222")).toEqual({ ok: false, reason: "no-messages", provider: "chatgpt" });
  });

  it("refuses any other site", () => {
    expect(readConversationFromPage(page(`<div data-message-author-role="user">hi</div>`), "https://evil.example/c/12345678")).toEqual({ ok: false, reason: "not-supported" });
  });
});

describe("live markup, 2026-10-14", () => {
  it("ChatGPT: reads li[data-message-role] messages at a signed-out /uc/ address", () => {
    const doc = page(
      `<nav><a href="/uc/older">An older chat</a></nav>
       <ol aria-label="Conversation" data-conversation-transcript="">
         <li data-message-role="user" id="u1"><div data-submit-message-animation-target=""><div><div data-user-message-bubble=""><p data-user-message-copy="">In two sentences: what role did the Schlieffen Plan play?</p></div></div></div></li>
         <li data-message-role="assistant" id="a1" data-message-complete=""><div><div data-assistant-markdown-root="" data-assistant-markdown=""><section aria-label="DIL content"><p data-d-component="text">It required Germany to invade Belgium to defeat France quickly.</p></section></div></div><button aria-label="Copy">Copy</button></li>
       </ol>
       <form><textarea id="mobile-composer-prompt" name="prompt" aria-label="Chat with ChatGPT"></textarea></form>`,
      "ChatGPT: Chat, Work, Create & Code with AI"
    );
    const url = "https://chatgpt.com/uc/6acf1856-995c-83ea-9eae-31d150d62bcd";
    expect(isConversationUrl(url)).toBe(true);
    expect(readConversationFromPage(doc, url).turns).toEqual([
      { role: "user", text: "In two sentences: what role did the Schlieffen Plan play?" },
      { role: "assistant", text: "It required Germany to invade Belgium to defeat France quickly." },
    ]);
  });

  it("ChatGPT: types into the signed-out composer, a plain textarea named prompt", async () => {
    const doc = page(`<div><textarea id="mobile-composer-prompt" name="prompt"></textarea></div>`);
    expect(await insertIntoComposer("Context from my Hubble project", doc, "https://chatgpt.com/uc/6acf1856-995c")).toEqual({ inserted: true });
    expect(doc.querySelector("textarea").value).toBe("Context from my Hubble project");
  });

  it("Gemini: leaves out the screen-reader 'You said' label, which repeats the question", () => {
    const doc = page(
      `<user-query><span class="user-query-container"><user-query-content class="user-query-container"><div class="query-content"><span class="user-query-bubble-with-background"><span class="horizontal-container"><div class="query-text gds-body-l"><h5 class="cdk-visually-hidden screen-reader-user-query-label">You said In two sentences: what role did the Schlieffen Plan play?</h5><p class="query-text-line">In two sentences: what role did the Schlieffen Plan play?</p></div></span></span></div></user-query-content></span></user-query>
       <model-response><div class="presented-response-container"><message-content><div class="markdown markdown-main-panel"><p data-path-to-node="0">It was Germany's plan for a two-front war.</p></div></message-content></div></model-response>`
    );
    expect(readConversationFromPage(doc, "https://gemini.google.com/app/8264cc91339033b5").turns).toEqual([
      { role: "user", text: "In two sentences: what role did the Schlieffen Plan play?" },
      { role: "assistant", text: "It was Germany's plan for a two-front war." },
    ]);
  });

  it("Perplexity: reads the question from its right-hand message bubble, not only the answer", () => {
    const doc = page(
      `<div data-sidebar-session-row="true">In two sentences: what role did the Schlieffen Plan play?</div>
       <main>
         <div class="group/user-bubble flex justify-end"><div data-message-bubble="right" class="whitespace-pre-wrap"><div class="max-h-[144px] overflow-hidden"><div data-renderer="lm"><p>In two sentences: what role did the Schlieffen Plan play?</p></div></div></div></div>
         <div class="prose"><p>It turned a Balkan crisis into a general European war.</p></div>
       </main>`
    );
    expect(readConversationFromPage(doc, "https://www.perplexity.ai/search/d38516e7-bed9-438b-912b-9ae3c5b8f0ff").turns).toEqual([
      { role: "user", text: "In two sentences: what role did the Schlieffen Plan play?" },
      { role: "assistant", text: "It turned a Balkan crisis into a general European war." },
    ]);
  });

  it("an editor that shows inserted text a moment later is reported as inserted, and the text is not pasted twice", async () => {
    const doc = page(`<div id="ask-input" contenteditable="true" role="textbox"></div>`);
    const box = doc.getElementById("ask-input");
    // Like Perplexity's editor: accepts the command, renders on a later tick.
    doc.execCommand = vi.fn((_command, _ui, value) => {
      setTimeout(() => (box.textContent += value), 120);
      return true;
    });
    const pasted = vi.fn();
    box.addEventListener("paste", pasted);
    expect(await insertIntoComposer("Context from my Hubble project", doc, "https://www.perplexity.ai/search/abcdef")).toEqual({ inserted: true });
    expect(pasted).not.toHaveBeenCalled();
    expect(box.textContent).toBe("Context from my Hubble project");
  });
});

describe("insertIntoComposer", () => {
  it("adds context to a textarea after what is already typed, and never submits", async () => {
    const doc = page(`<form><textarea id="prompt-textarea"></textarea><button type="submit">Send</button></form>`);
    const box = doc.getElementById("prompt-textarea");
    box.value = "My question:";
    const submit = vi.fn((event) => event.preventDefault());
    doc.querySelector("form").addEventListener("submit", submit);
    const click = vi.fn();
    doc.querySelector("button").addEventListener("click", click);
    const input = vi.fn();
    box.addEventListener("input", input);

    expect(await insertIntoComposer("Context from my Hubble project", doc, "https://chatgpt.com/c/6720a1b2-1111-2222")).toEqual({ inserted: true });
    expect(box.value).toBe("My question:\n\nContext from my Hubble project");
    expect(input).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("types into a rich editor and confirms the text is there", async () => {
    const doc = page(`<div contenteditable="true" class="ProseMirror"></div>`);
    const box = doc.querySelector(".ProseMirror");
    doc.execCommand = vi.fn((command, _ui, value) => {
      box.textContent += value;
      return command === "insertText";
    });
    expect(await insertIntoComposer("Context from my Hubble project", doc, "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb")).toEqual({ inserted: true });
    expect(box.textContent).toContain("Context from my Hubble project");
  });

  it("reports failure honestly when the editor ignores the text", async () => {
    const doc = page(`<div contenteditable="true" role="textbox" class="ql-editor"></div>`);
    doc.execCommand = vi.fn(() => true);
    expect(await insertIntoComposer("Context", doc, "https://gemini.google.com/app/1a2b3c4d5e6f")).toEqual({ inserted: false, reason: "not-inserted" });
  });

  it("says there is no message box on a page without one, and on other sites", async () => {
    expect(await insertIntoComposer("x", page(`<main></main>`), "https://www.perplexity.ai/search/abcdef")).toEqual({ inserted: false, reason: "no-composer" });
    expect(await insertIntoComposer("x", page(`<textarea></textarea>`), "https://example.com/")).toEqual({ inserted: false, reason: "no-composer" });
  });

  it("is self-contained, as chrome.scripting.executeScript needs", () => {
    // A serialized function cannot reach module scope: no free references to this file's exports.
    for (const fn of [readConversationFromPage, insertIntoComposer]) {
      const source = fn.toString();
      expect(source).not.toMatch(/\bAI_PAGE_HOSTS\b|\bCONVERSATION_PATHS\b|\baiProviderOf\b|\bAI_PROVIDER_NAMES\b/);
    }
  });
});
