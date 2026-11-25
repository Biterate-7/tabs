// The AI-page reader and the message-box insert, run against saved page
// fixtures shaped like each app's markup. These are fixtures, not the live
// apps: they hold the code to the structure it was written for, and the
// failure paths (an unrecognised layout, no message box) to an honest
// reason instead of a guess.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_PAGE_HOSTS, aiProviderOf, checkPageRead, conversationIdentityOf, insertIntoComposer, isConversationUrl, readConversationFromPage } from "./ai-pages.js";
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

// The identity every save, duplicate check and "already saved" line uses — the same answers in the extension and
// the web app, for every provider and address shape either knows.
describe("which conversation an address names", () => {
  const ADDRESSES = [
    "https://chatgpt.com/c/6720a1b2-1111-2222",
    "https://chatgpt.com/c/6720a1b2-1111-2222/?model=gpt-4o#x",
    "https://chat.openai.com/c/6720a1b2-1111-2222",
    "https://chatgpt.com/g/g-abc-tutor/c/6720a1b2-1111-2222",
    "https://chatgpt.com/c/6720A1B2-1111-2222",
    "https://chatgpt.com/uc/6720a1b2-1111-2222",
    "https://chatgpt.com/share/6720a1b2-1111-2222",
    "https://chatgpt.com/c/short",
    "https://chatgpt.com/",
    "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb",
    "https://claude.ai/chat/0b6f6d3e-aaaa-bbbc",
    "https://claude.ai/share/0b6f6d3e-aaaa-bbbb",
    "https://claude.ai/new",
    "https://gemini.google.com/app/1a2b3c4d5e6f",
    "https://gemini.google.com/app/1a2b3c4d5e6f?hl=en",
    "https://gemini.google.com/gem/study-buddy/1a2b3c4d5e6f",
    "https://gemini.google.com/share/1a2b3c4d5e6f",
    "https://gemini.google.com/app",
    "https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3",
    "https://perplexity.ai/search/why-is-the-sky-blue-x1y2z3/",
    "https://www.perplexity.ai/library",
    "https://example.com/c/6720a1b2-1111-2222",
    "not a url",
  ];

  it.each(ADDRESSES)("agrees with the web app's conversationRefOf about %s", (url) => {
    const ref = conversationRefOf(url);
    expect(conversationIdentityOf(url)).toEqual(ref ? { provider: ref.provider, conversationId: ref.conversationId, url: ref.url, key: ref.key } : undefined);
  });

  it("gives two conversations of one app two identities, and one conversation one identity however its address is written", () => {
    const key = (url) => conversationIdentityOf(url)?.key;
    expect(key("https://chatgpt.com/c/6720a1b2-1111-2222")).not.toBe(key("https://chatgpt.com/c/68f0c3d4-aaaa-bbbb"));
    expect(key("https://claude.ai/chat/0b6f6d3e-aaaa-bbbb")).not.toBe(key("https://claude.ai/chat/0b6f6d3e-aaaa-bbbc"));
    expect(key("https://gemini.google.com/app/1a2b3c4d5e6f")).not.toBe(key("https://gemini.google.com/app/1a2b3c4d5e6a"));
    expect(key("https://www.perplexity.ai/search/why-x1y2z3")).not.toBe(key("https://www.perplexity.ai/search/why-q9r8s7"));
    expect(key("https://chat.openai.com/c/6720a1b2-1111-2222/?model=gpt-4o")).toBe(key("https://chatgpt.com/c/6720a1b2-1111-2222"));
    expect(key("https://chatgpt.com/")).toBeUndefined();
  });
});

describe("readConversationFromPage", () => {
  it("reads ChatGPT's messages by author role, leaving the sidebar out", async () => {
    const doc = page(
      `<nav><a href="/c/other">Another chat about energy</a></nav>
       <main>
         <div data-message-author-role="user"><div class="whitespace-pre-wrap">What caused WW1?</div></div>
         <div data-message-author-role="assistant"><div class="markdown"><p>Militarism and alliances.</p></div></div>
         <div data-message-author-role="tool"><div>search results</div></div>
       </main>`,
      "Causes of WW1"
    );
    const read = await readConversationFromPage(doc, "https://chatgpt.com/c/6720a1b2-1111-2222");
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
      strategy: "message-role",
    });
  });

  it("reads Claude's user and response blocks, joining one reply split across nodes", async () => {
    const doc = page(
      `<div data-testid="user-message">Is my thesis arguable?</div>
       <div class="font-claude-response"><p>Yes.</p></div>
       <div class="font-claude-response"><p>Narrow the time frame.</p></div>`,
      "Thesis feedback - Claude"
    );
    const read = await readConversationFromPage(doc, "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb");
    expect(read.ok).toBe(true);
    expect(read.turns).toEqual([
      { role: "user", text: "Is my thesis arguable?" },
      { role: "assistant", text: "Yes.\n\nNarrow the time frame." },
    ]);
  });

  it("reads Gemini's query and response elements", async () => {
    const doc = page(
      `<user-query><div class="query-text">Explain photosynthesis</div></user-query>
       <model-response><message-content><p>Plants turn light into chemical energy.</p></message-content></model-response>`
    );
    const read = await readConversationFromPage(doc, "https://gemini.google.com/app/1a2b3c4d5e6f");
    expect(read.provider).toBe("gemini");
    expect(read.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  it("reads Perplexity's query and answer", async () => {
    const doc = page(
      `<div data-testid="query-text">Why is the sky blue?</div>
       <div class="prose"><p>Rayleigh scattering.</p></div>`
    );
    const read = await readConversationFromPage(doc, "https://www.perplexity.ai/search/why-is-the-sky-blue-x1y2z3");
    expect(read.turns).toEqual([
      { role: "user", text: "Why is the sky blue?" },
      { role: "assistant", text: "Rayleigh scattering." },
    ]);
  });

  it("says when a page's layout has no messages it recognises, rather than saving nothing", async () => {
    const doc = page(`<main><div class="some-new-layout">What caused WW1?</div></main>`);
    expect(await readConversationFromPage(doc, "https://chatgpt.com/c/6720a1b2-1111-2222", 0)).toMatchObject({ ok: false, reason: "no-messages", provider: "chatgpt" });
  });

  it("refuses any other site", async () => {
    expect(await readConversationFromPage(page(`<div data-message-author-role="user">hi</div>`), "https://evil.example/c/12345678")).toEqual({ ok: false, reason: "not-supported" });
  });
});

describe("live markup, 2026-10-14", () => {
  it("ChatGPT: reads li[data-message-role] messages at a signed-out /uc/ address", async () => {
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
    expect((await readConversationFromPage(doc, url)).turns).toEqual([
      { role: "user", text: "In two sentences: what role did the Schlieffen Plan play?" },
      { role: "assistant", text: "It required Germany to invade Belgium to defeat France quickly." },
    ]);
  });

  it("ChatGPT: types into the signed-out composer, a plain textarea named prompt", async () => {
    const doc = page(`<div><textarea id="mobile-composer-prompt" name="prompt"></textarea></div>`);
    expect(await insertIntoComposer("Context from my Hubble project", doc, "https://chatgpt.com/uc/6acf1856-995c")).toEqual({ inserted: true });
    expect(doc.querySelector("textarea").value).toBe("Context from my Hubble project");
  });

  it("Gemini: leaves out the screen-reader 'You said' label, which repeats the question", async () => {
    const doc = page(
      `<user-query><span class="user-query-container"><user-query-content class="user-query-container"><div class="query-content"><span class="user-query-bubble-with-background"><span class="horizontal-container"><div class="query-text gds-body-l"><h5 class="cdk-visually-hidden screen-reader-user-query-label">You said In two sentences: what role did the Schlieffen Plan play?</h5><p class="query-text-line">In two sentences: what role did the Schlieffen Plan play?</p></div></span></span></div></user-query-content></span></user-query>
       <model-response><div class="presented-response-container"><message-content><div class="markdown markdown-main-panel"><p data-path-to-node="0">It was Germany's plan for a two-front war.</p></div></message-content></div></model-response>`
    );
    expect((await readConversationFromPage(doc, "https://gemini.google.com/app/8264cc91339033b5")).turns).toEqual([
      { role: "user", text: "In two sentences: what role did the Schlieffen Plan play?" },
      { role: "assistant", text: "It was Germany's plan for a two-front war." },
    ]);
  });

  it("Perplexity: reads the question from its right-hand message bubble, not only the answer", async () => {
    const doc = page(
      `<div data-sidebar-session-row="true">In two sentences: what role did the Schlieffen Plan play?</div>
       <main>
         <div class="group/user-bubble flex justify-end"><div data-message-bubble="right" class="whitespace-pre-wrap"><div class="max-h-[144px] overflow-hidden"><div data-renderer="lm"><p>In two sentences: what role did the Schlieffen Plan play?</p></div></div></div></div>
         <div class="prose"><p>It turned a Balkan crisis into a general European war.</p></div>
       </main>`
    );
    expect((await readConversationFromPage(doc, "https://www.perplexity.ai/search/d38516e7-bed9-438b-912b-9ae3c5b8f0ff")).turns).toEqual([
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

  it("is self-contained, as chrome.scripting.executeScript needs", async () => {
    // A serialized function cannot reach module scope: no free references to this file's exports.
    for (const fn of [readConversationFromPage, insertIntoComposer]) {
      const source = fn.toString();
      expect(source).not.toMatch(/\bAI_PAGE_HOSTS\b|\bCONVERSATION_PATHS\b|\baiProviderOf\b|\bAI_PROVIDER_NAMES\b|\bcheckPageRead\b|\bPAGE_READ_REASONS\b/);
    }
  });
});

// ChatGPT as it served a signed-in conversation on 2026-10-15 (and signed-out
// chats once they moved to /c/), reduced to its structure: the message itself
// carries no role attribute any more — each one is keyed "<turn>:<n>:<role>" —
// the reply sits in [data-markdown-copy="contents"], and "You said:" /
// "ChatGPT said:" are visible labels beside the text. The layout that made
// every Save end in "couldn't find the messages".
const SIGNED_IN = "https://chatgpt.com/c/6ad062bc-2bcc-83e8-9305-06038d74964f";

function unitTurn(index, question, answer, chat = "") {
  return `<div data-turn-key="69ff8060-e2b1-46e6-b070-f80adac4016${index}">
    <div data-content-search-turn-key="fallback-turn-${index}">
      <div aria-label="Sent" role="separator" data-markdown-copy="exclude"><time><span>11:2${index}</span></time></div>
      <div><div data-talvt-turn-state="complete">
        <div><div>
          <h4>You said:</h4>
          <div data-chatgpt-search-unit-key="fallback-turn-${index}:0:user" data-content-search-unit-key="fallback-turn-${index}:0:user" data-chatgpt-search-message-ids="">
            <div><div data-user-message-bubble="true"><div><div><div data-search-result-target=""><div><div style="white-space: pre-wrap">${question}</div></div></div></div></div></div></div>
            <div><span data-state="closed"><button aria-label="Copy message"><svg><path></path></svg></button></span><span data-state="closed"><button aria-label="Edit message"><svg><path></path></svg></button></span></div>
          </div>
        </div>
        <div>
          <span data-chatgpt-agent-turn-start=""></span>
          <div data-content-search-unit-key="fallback-turn-${index}:1:assistant" data-chatgpt-search-unit-key="fallback-turn-${index}:1:assistant" data-chatgpt-search-message-ids="">
            <h4 data-conversation-role="assistant">ChatGPT said:</h4>
            <div><div${chat ? ` data-chatgpt-selection-conversation-id="${chat}"` : ""} data-chatgpt-selection-message-id="m${index}"><div data-markdown-text-style="assistant-message"><div data-dil-source-message-id="" data-chatgpt-copy-reference="0" data-markdown-copy="contents"><div><div hidden=""></div><div data-theme="dark"><div data-d-inline-reveal="" data-d-direction="col">${answer}</div></div></div></div></div></div>
          </div>
        </div></div>
        <div><span data-state="closed"><button aria-label="Copy">Copy</button></span><span data-state="closed"><button aria-label="Rate">Good response</button></span></div>
      </div></div>
    </div>
  </div>`;
}

function signedInPage(turns, { status = "", title = "Admissions Strategy Assessment" } = {}) {
  return page(
    `<nav aria-label="Chat history"><a href="/">New chat</a><a href="/c/other">Write Hubble Features Prompt</a><div>Projects</div></nav>
     <main data-app-shell-main-surface="browser">
       <header data-app-shell-titlebar="true"><button aria-label="Share">Share</button></header>
       <div data-mcp-app-portal-target="true" data-thread-user-message-navigation-content="true">
         <div data-chatgpt-conversation-selection-target="true" data-thread-find-target="conversation">
           ${status ? `<div><div role="status"><span>${status}</span></div></div>` : ""}
           <div>${turns.join("")}</div>
         </div>
       </div>
       <form><div>Suggested: Quiz me on the French Revolution</div><textarea id="prompt-textarea" name="prompt" aria-label="Chat with ChatGPT">half-written draft</textarea><button aria-label="Send prompt">Send</button></form>
     </main>`,
    title
  );
}

const text = (body) => `<p data-d-text-flow="" data-d-component="text">${body}</p>`;

// A code block as ChatGPT draws it: a header ChatGPT's own Copy leaves out, and an editor with one element per line.
const codeBlock = (language, lines) => `<div data-code-block="true" data-markdown-copy="code-block" data-theme="dark" data-search-result-target="">
  <div data-markdown-copy="exclude" contenteditable="false"><svg aria-hidden="true"><use href=""></use></svg><div>${language[0].toUpperCase()}${language.slice(1)}</div><div><div data-code-block-controls="true" role="presentation"><span data-state="closed"><button type="button" aria-label="Enable word wrap"></button></span><span data-state="closed"><button type="button" aria-label="Copy code">Copy code</button></span><button type="button" aria-label="Run code">Run</button></div></div></div>
  <div><div aria-hidden="false"><div><div><div data-editor-search-surface="true" dir="ltr"><div><div aria-live="polite"></div><div tabindex="-1"><div spellcheck="false" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Edit code" data-language="${language}">${lines.map((line) => `<div>${line ? `<span>${line}</span>` : "<br>"}</div>`).join("")}</div></div></div></div></div></div><button aria-hidden="true" aria-label="Scroll to bottom" tabindex="-1" type="button">Scroll</button></div></div>
</div>`;

describe("ChatGPT, signed in (live markup, 2026-10-15)", () => {
  it("reads alternating questions and replies by their message keys, each once and in order", async () => {
    const doc = signedInPage([unitTurn(0, "What caused WW1?", text("Militarism and alliances.")), unitTurn(1, "And the spark?", text("The assassination in Sarajevo."))]);
    expect(await readConversationFromPage(doc, SIGNED_IN, 0)).toEqual({
      ok: true,
      provider: "chatgpt",
      url: SIGNED_IN,
      title: "Admissions Strategy Assessment",
      turns: [
        { role: "user", text: "What caused WW1?" },
        { role: "assistant", text: "Militarism and alliances." },
        { role: "user", text: "And the spark?" },
        { role: "assistant", text: "The assassination in Sarajevo." },
      ],
      truncated: false,
      strategy: "unit-key",
    });
  });

  it("leaves out the sidebar, the composer, suggestions, labels, buttons and timestamps", async () => {
    const doc = signedInPage([unitTurn(0, "What caused WW1?", text("Militarism and alliances."))]);
    const all = (await readConversationFromPage(doc, SIGNED_IN, 0)).turns.map((turn) => turn.text).join("\n");
    for (const noise of ["New chat", "Write Hubble Features Prompt", "Projects", "Share", "Suggested", "half-written draft", "Send", "You said", "ChatGPT said", "Copy", "Edit message", "Good response", "11:20"]) {
      expect(all).not.toContain(noise);
    }
  });

  it("keeps a long reply's headings, paragraphs and code, fenced with its language and indentation", async () => {
    const answer = [
      `<h2 data-d-text-flow="" data-d-component="title" data-d-size="lg">How binary search works</h2>`,
      text("Binary search finds a target in a sorted list by halving the range each step."),
      text("Each comparison discards half of what is left, so it takes about log2(n) steps."),
      codeBlock("python", ["def search(items, target):", "    low, high = 0, len(items) - 1", "", "    while low &lt;= high:", "        mid = (low + high) // 2", "        if items[mid] == target:", "            return mid"]),
      text("It only works when the list is sorted."),
    ].join("");
    const read = await readConversationFromPage(signedInPage([unitTurn(0, "How does binary search work?", answer)]), SIGNED_IN, 0);
    expect(read.turns[1]).toEqual({
      role: "assistant",
      text: [
        "How binary search works",
        "Binary search finds a target in a sorted list by halving the range each step.",
        "Each comparison discards half of what is left, so it takes about log2(n) steps.",
        "```python\ndef search(items, target):\n    low, high = 0, len(items) - 1\n\n    while low <= high:\n        mid = (low + high) // 2\n        if items[mid] == target:\n            return mid\n```",
        "It only works when the list is sorted.",
      ].join("\n\n"),
    });
  });

  it("keeps a multiline question and a reply's Markdown: emphasis, lists, numbered steps and tables", async () => {
    const answer = [
      `<p data-d-component="text">You are <strong>a credible applicant</strong>, with <em>gaps</em> to close.</p>`,
      `<div data-d-component="list"><div data-d-component="list-item"><p data-d-component="text">Keep your four 7s.</p></div><div data-d-component="list-item"><p data-d-component="text">Lift History to a 7.</p></div></div>`,
      `<ol><li>Take an SAT diagnostic.</li><li>Launch a small beta.</li></ol>`,
      `<div data-d-component="table"><div data-d-component="table-row"><div data-d-component="table-cell"><p>Area</p></div><div data-d-component="table-cell"><p>Assessment</p></div></div><div data-d-component="table-row"><div data-d-component="table-cell"><p>Academics</p></div><div data-d-component="table-cell"><p>Encouraging</p></div></div></div>`,
      `<table><tr><th>Period</th><th>Goal</th></tr><tr><td>Oct–Dec</td><td>Protect grades</td></tr></table>`,
    ].join("");
    const read = await readConversationFromPage(signedInPage([unitTurn(0, "Assess my profile.\nIB: 40/42\n\nSAT: not taken", answer)]), SIGNED_IN, 0);
    expect(read.turns).toEqual([
      { role: "user", text: "Assess my profile.\nIB: 40/42\n\nSAT: not taken" },
      {
        role: "assistant",
        text: [
          "You are a credible applicant, with gaps to close.",
          "- Keep your four 7s.\n- Lift History to a 7.",
          "1. Take an SAT diagnostic.\n2. Launch a small beta.",
          "Area | Assessment\nAcademics | Encouraging",
          "Period | Goal\nOct–Dec | Protect grades",
        ].join("\n\n"),
      },
    ]);
  });

  it("keeps formulas as the TeX they were written in: inline $…$, display $$…$$", async () => {
    // KaTeX as ChatGPT draws it: MathML with the TeX as an annotation, then the visible glyphs, hidden from screen readers.
    const katex = (tex, glyphs, display) =>
      `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ""}><semantics><mrow><mi>${glyphs}</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">${glyphs}</span></span></span></span>`;
    const answer = [
      `<p data-d-component="text">Newton's second law: <span data-d-component="math" data-d-stream-inline="">${katex("F_{\\text{net}} = ma", "Fnet=ma")}</span>.</p>`,
      `<div><span data-d-block="" data-d-component="math"><span class="katex-display">${katex("E_k = \\frac{1}{2}mv^2", "Ek=12mv2", true)}</span></span></div>`,
    ].join("");
    const read = await readConversationFromPage(signedInPage([unitTurn(0, "State Newton's second law.", answer)]), SIGNED_IN, 0);
    expect(read.turns[1].text).toBe("Newton's second law: $F_{\\text{net}} = ma$.\n\n$$E_k = \\frac{1}{2}mv^2$$");
  });

  it("keeps Gemini's formulas as the TeX on their wrapper, with or without KaTeX's MathML copy", async () => {
    // Gemini wraps each KaTeX formula in .math-inline / .math-block carrying the TeX as data-math. Here the
    // drawn formula has no MathML annotation, so its glyphs ("32θ=sinθ") are all the page would otherwise give.
    const glyphs = (text) => `<span class="katex"><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">${text}</span></span></span></span>`;
    const doc = page(
      `<user-query><div class="query-text"><p class="query-text-line">Solve it</p></div></user-query>
       <model-response><message-content><div class="markdown">` +
        `<p>Rearrange <span class="math-inline" data-math="\\frac{3}{2}\\theta = \\sin\\theta">${glyphs("32θ=sinθ")}</span> first.</p>` +
        `<div class="math-block" data-math="\\boxed{\\theta = 0}"><span class="katex-display">${glyphs("θ=0")}</span></div>` +
        `</div></message-content></model-response>`
    );
    expect((await readConversationFromPage(doc, "https://gemini.google.com/app/ed0431c2728ddb16")).turns[1].text).toBe(
      "Rearrange $\\frac{3}{2}\\theta = \\sin\\theta$ first.\n\n$$\\boxed{\\theta = 0}$$"
    );
  });

  it("says no-messages — the paste fallback — when the message keys are gone, though the page has text", async () => {
    const doc = page(
      `<main><div data-thread-find-target="conversation"><div data-turn-key="t1"><div><div>What caused WW1?</div></div><div><div>Militarism and alliances.</div></div></div></div>
       <form><textarea name="prompt"></textarea></form></main>`
    );
    expect(await readConversationFromPage(doc, SIGNED_IN, 0)).toMatchObject({ ok: false, reason: "no-messages", provider: "chatgpt" });
  });

  it("says no-messages when messages are found but none has readable text", async () => {
    expect(await readConversationFromPage(signedInPage([unitTurn(0, "", "")]), SIGNED_IN, 0)).toMatchObject({ ok: false, reason: "no-messages", provider: "chatgpt" });
  });

  it("says empty-conversation for a conversation with no messages", async () => {
    expect(await readConversationFromPage(signedInPage([]), SIGNED_IN, 0)).toMatchObject({ ok: false, reason: "empty-conversation", provider: "chatgpt" });
    // A loading notice is not a message either.
    expect(await readConversationFromPage(signedInPage([], { status: "Loading…" }), SIGNED_IN, 0)).toMatchObject({ ok: false, reason: "empty-conversation", provider: "chatgpt" });
  });

  it("waits for a conversation that has not finished rendering, then reads it once", async () => {
    const doc = signedInPage([]);
    const list = doc.querySelector('[data-thread-find-target="conversation"] > div:last-child');
    setTimeout(() => {
      list.innerHTML = unitTurn(0, "What caused WW1?", text("Militarism and alliances."));
    }, 300);
    const read = await readConversationFromPage(doc, SIGNED_IN, 3000);
    expect(read.ok).toBe(true);
    expect(read.turns).toEqual([
      { role: "user", text: "What caused WW1?" },
      { role: "assistant", text: "Militarism and alliances." },
    ]);
  });

  it("gives up with its reason once the wait is over", async () => {
    const started = Date.now();
    expect(await readConversationFromPage(page(`<main><div>Something else</div></main>`), SIGNED_IN, 300)).toMatchObject({ ok: false, reason: "no-messages", provider: "chatgpt" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("reads each message once when its key repeats inside it, or an older layout's role sits inside it", async () => {
    const nested = unitTurn(0, "What caused WW1?", `<div data-content-search-unit-key="fallback-turn-0:1:assistant"><div data-message-author-role="assistant">${text("Militarism and alliances.")}</div></div>`);
    const doc = signedInPage([nested, unitTurn(1, "And the spark?", text("Sarajevo."))]);
    const first = await readConversationFromPage(doc, SIGNED_IN, 0);
    expect(first.turns).toEqual([
      { role: "user", text: "What caused WW1?" },
      { role: "assistant", text: "Militarism and alliances." },
      { role: "user", text: "And the spark?" },
      { role: "assistant", text: "Sarajevo." },
    ]);
    // Reading again (a retry, a second click) starts from nothing.
    expect(await readConversationFromPage(doc, SIGNED_IN, 0)).toEqual(first);
  });

  it("reads only the open chat when ChatGPT keeps the one you came from in the page", async () => {
    // Seen live 2026-10-15: after switching chats in the app, the previous chat stays mounted on an inactive page,
    // its questions intact and its replies emptied. Saving chat B read both, and chat A's questions led B's save.
    const previous = "6ad08116-edd8-83ec-b032-cde25a3651ae";
    const open = "6ad062bc-2bcc-83e8-9305-06038d74964f";
    const doc = page(
      `<div data-app-shell-active-page="false"><main><div data-thread-find-target="conversation">
         ${unitTurn(0, "Reply with a Python code block.", "", previous)}${unitTurn(1, "State Newton's second law.", "", previous)}
       </div></main></div>
       <div data-app-shell-active-page="true"><main><div data-thread-find-target="conversation">
         ${unitTurn(0, "What caused WW1?", text("Militarism and alliances."), open)}
       </div></main></div>`
    );
    expect(await readConversationFromPage(doc, SIGNED_IN, 0)).toMatchObject({
      ok: true,
      turns: [
        { role: "user", text: "What caused WW1?" },
        { role: "assistant", text: "Militarism and alliances." },
      ],
    });
  });

  it("leaves out a turn tagged with another conversation's id, wherever it sits", async () => {
    const doc = signedInPage([unitTurn(0, "A question from another chat", text("Its reply."), "6ad08116-edd8-83ec-b032-cde25a3651ae"), unitTurn(1, "What caused WW1?", text("Militarism."), "6ad062bc-2bcc-83e8-9305-06038d74964f")]);
    expect((await readConversationFromPage(doc, SIGNED_IN, 0)).turns).toEqual([
      { role: "user", text: "What caused WW1?" },
      { role: "assistant", text: "Militarism." },
    ]);
  });

  it("says when ChatGPT has not loaded the older messages above the ones on screen", async () => {
    const doc = signedInPage([unitTurn(0, "What caused WW1?", text("Militarism and alliances."))], { status: "Loading older messages…" });
    expect(await readConversationFromPage(doc, SIGNED_IN, 0)).toMatchObject({ ok: true, olderNotLoaded: true });
    expect(await readConversationFromPage(signedInPage([unitTurn(0, "Q", text("A"))]), SIGNED_IN, 0)).not.toHaveProperty("olderNotLoaded");
  });

  it("fences a signed-out /uc/ code block with the language its label names, and leaves the label out of the text", async () => {
    const doc = page(
      `<ol data-conversation-transcript=""><li data-message-role="assistant" data-message-complete=""><div data-assistant-markdown-root=""><section aria-label="DIL content"><p>Here is a function.</p><div><span>javascript</span><pre><code><span>function</span><span> </span><span>add(a, b) {</span>\n<span>  return a + b;</span>\n<span>}</span></code></pre></div><p>Call it with two numbers.</p></section></div></li></ol>`
    );
    expect((await readConversationFromPage(doc, "https://chatgpt.com/uc/6ad0abab-ba14-83ea-a168-4e05461c85a6", 0)).turns).toEqual([
      { role: "assistant", text: "Here is a function.\n\n```javascript\nfunction add(a, b) {\n  return a + b;\n}\n```\n\nCall it with two numbers." },
    ]);
  });

  it("still reads the earlier role-attribute layout, its code blocks fenced", async () => {
    const doc = page(
      `<article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown"><p>Like this:</p><pre><div><div>python</div><div><button>Copy code</button></div></div><div><code class="language-python">def add(a, b):\n    return a + b\n</code></div></pre></div></div></article>`
    );
    expect((await readConversationFromPage(doc, "https://chatgpt.com/c/6720a1b2-1111-2222", 0)).turns).toEqual([{ role: "assistant", text: "Like this:\n\n```python\ndef add(a, b):\n    return a + b\n```" }]);
  });
});

// Shapes seen in signed-in chats on 2026-10-16 (element structure only; the text here is made up).
const claudeRow = (index, fromTail, inner) =>
  `<div data-testid="transcript-row" data-index="${index}" data-perf-row-from-tail="${fromTail}"><div role="article"><div data-mini-claude-message=""><div data-transcript-row="">${inner}</div></div></div></div>`;
const claudeQuestion = (text) =>
  `<h2 data-find-omitted="" class="sr-only">You said: ${text}</h2><div data-user-scope=""><div data-turn-key="t" class="font-sans"><div class="font-normal break-words"><div><div><div data-testid="user-message" class="grid-cols-1"><div><p class="whitespace-pre-wrap break-words">${text}</p></div></div></div></div></div></div></div>`;
const claudeReply = (...parts) =>
  `<div data-reply-scope=""><div data-testid="assistant-message" data-turn-key="t" data-is-streaming="false"><h2 data-find-omitted="" class="sr-only">Claude responded: ${parts[0]}</h2><div>` +
  `<div data-find-omitted="" data-state="closed"><div class="font-sans font-normal"><span>Thought for 4 seconds</span></div><span role="status" class="sr-only">Thinking</span></div>` +
  parts.map((part) => `<div data-transcript-engine-root=""><div class="prose"><div data-perf-reply-text="" class="standard-markdown grid-cols-1"><p>${part}</p></div></div></div><div data-find-omitted="" data-state="closed"><div data-cds-row="">Searched the web</div></div>`).join("") +
  `</div><div data-testid="message-actions"><button>Retry</button></div></div></div>`;

describe("signed in (live markup, 2026-10-16)", () => {
  const CLAUDE = "https://claude.ai/chat/446f8e09-fd3c-43b5-a8fa-5c5861dfb044";

  it("Claude: reads each question and reply, leaving out the spoken labels, thinking and tool panels", async () => {
    const doc = page(
      `<nav data-testid="sidebar"><a href="/chat/older">An older chat</a></nav>
       <div data-testid="transcript-list">${claudeRow(0, 3, claudeQuestion("Is my thesis arguable?"))}${claudeRow(1, 2, claudeReply("Yes, mostly.", "Narrow the time frame."))}${claudeRow(2, 1, claudeQuestion("Which years?"))}${claudeRow(3, 0, claudeReply("1905 to 1914."))}</div>
       <div data-testid="chat-input" contenteditable="true"></div>`,
      "Thesis feedback - Claude"
    );
    const read = await readConversationFromPage(doc, CLAUDE);
    expect(read).toEqual({
      ok: true,
      provider: "claude",
      url: CLAUDE,
      title: "Thesis feedback - Claude",
      turns: [
        { role: "user", text: "Is my thesis arguable?" },
        { role: "assistant", text: "Yes, mostly.\n\nNarrow the time frame." },
        { role: "user", text: "Which years?" },
        { role: "assistant", text: "1905 to 1914." },
      ],
      truncated: false,
      strategy: "message-testid",
    });
  });

  it("Claude: a reply with no text block (an artifact only) is still read, from the whole message", async () => {
    const doc = page(claudeRow(0, 1, claudeQuestion("Make me slides")) + claudeRow(1, 0, `<div data-testid="assistant-message"><div data-testid="frame-card-open">Slides deck</div></div>`));
    expect((await readConversationFromPage(doc, CLAUDE)).turns).toEqual([
      { role: "user", text: "Make me slides" },
      { role: "assistant", text: "Slides deck" },
    ]);
  });

  it("Claude: says only part of a long chat was on the page when earlier or later rows are not mounted", async () => {
    const tail = page(claudeRow(13, 1, claudeQuestion("And then?")) + claudeRow(14, 0, claudeReply("Then it ended.")));
    expect(await readConversationFromPage(tail, CLAUDE)).toMatchObject({ ok: true, partial: true });
    const head = page(claudeRow(0, 5, claudeQuestion("Start here")) + claudeRow(1, 4, claudeReply("Started.")));
    expect(await readConversationFromPage(head, CLAUDE)).toMatchObject({ ok: true, partial: true });
    const whole = page(claudeRow(0, 1, claudeQuestion("Start here")) + claudeRow(1, 0, claudeReply("Started.")));
    expect(await readConversationFromPage(whole, CLAUDE)).not.toHaveProperty("partial");
  });

  it("Gemini: names a code block's language on its fence, leaving its header out of the text", async () => {
    const doc = page(
      `<user-query><div class="query-text"><p class="query-text-line">Print two colours in Python</p></div></user-query>
       <model-response><message-content><div class="markdown"><p>Here you go.</p><code-block><div class="code-block"><div class="formatted-code-block-internal-container"><div class="animated-opacity"><div class="code-block-decoration header-formatted"><span>Python</span><div class="buttons"><gem-icon-button aria-label="Copy code"></gem-icon-button></div></div><pre><code class="code-container">colors = ["red", "blue"]\nprint(colors)</code></pre></div></div></div></code-block></div></message-content></model-response>`
    );
    expect((await readConversationFromPage(doc, "https://gemini.google.com/app/ed0431c2728ddb16")).turns).toEqual([
      { role: "user", text: "Print two colours in Python" },
      { role: "assistant", text: 'Here you go.\n\n```python\ncolors = ["red", "blue"]\nprint(colors)\n```' },
    ]);
  });

  const perplexityTurn = (entry, question, answer) =>
    `<div class="group/partition" data-workflow-entry="${entry}"><div dir="auto"><div><div class="group/user-bubble"><div data-message-bubble="right"><p>${question}</p></div></div></div></div></div>` +
    `<div class="group/partition group/final-text" data-workflow-final-text=""><div data-workflow-items=""><div><div class="prose"><p>${answer}</p></div></div></div></div>`;

  it("Perplexity: reads a whole thread in order", async () => {
    const doc = page(`<div></div><div></div>${perplexityTurn(0, "First question", "First answer.")}${perplexityTurn(1, "Follow-up", "Second answer.")}`);
    const read = await readConversationFromPage(doc, "https://www.perplexity.ai/search/07f15fc6-ef25-4f50-aa41-4a551474a5b0");
    expect(read.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(read).not.toHaveProperty("partial");
  });

  it("Perplexity: says only part of the thread was on the page when it starts mid-way", async () => {
    // Opened at its end: the first question is not mounted, the thread starts with the tail of a reply.
    const doc = page(`<div></div><div></div><div></div><div><div class="prose"><p>First answer, its end.</p></div></div>${perplexityTurn(2, "Follow-up", "Second answer.")}`);
    const read = await readConversationFromPage(doc, "https://www.perplexity.ai/search/07f15fc6-ef25-4f50-aa41-4a551474a5b0");
    expect(read.turns.map((turn) => turn.role)).toEqual(["assistant", "user", "assistant"]);
    expect(read.partial).toBe(true);
  });

  it("says read-failed, with the error and not the page's text, when reading the page throws", async () => {
    const broken = {
      title: "A private title",
      querySelectorAll() {
        throw new TypeError("Cannot read properties of null (reading 'children')");
      },
    };
    expect(await readConversationFromPage(broken, CLAUDE, 0)).toEqual({ ok: false, reason: "read-failed", provider: "claude", detail: "TypeError: Cannot read properties of null (reading 'children')" });
  });
});

describe("checkPageRead: what came back from the page, before it goes anywhere", () => {
  it("passes on a well-formed read with only the role and text of each turn", () => {
    expect(
      checkPageRead({
        ok: true,
        provider: "chatgpt",
        url: SIGNED_IN,
        title: "Causes of WW1",
        turns: [{ role: "user", text: "Why?", html: "<b>x</b>" }, { role: "assistant", text: "  " }, { role: "assistant", text: "Because." }],
        truncated: false,
        olderNotLoaded: true,
      })
    ).toEqual({ ok: true, title: "Causes of WW1", turns: [{ role: "user", text: "Why?" }, { role: "assistant", text: "Because." }], olderNotLoaded: true, partial: false });
  });

  it("passes on that only part of a long chat was on the page", () => {
    expect(checkPageRead({ ok: true, turns: [{ role: "assistant", text: "Because." }], partial: true })).toMatchObject({ ok: true, partial: true });
    expect(checkPageRead({ ok: true, turns: [{ role: "assistant", text: "Because." }], partial: "yes" })).toMatchObject({ ok: true, partial: false });
  });

  it("says the page gave no answer when the script returned nothing", () => {
    for (const nothing of [undefined, null, "ok", 3]) expect(checkPageRead(nothing)).toEqual({ ok: false, error: "page-unreadable" });
  });

  it("passes on the reader's own reasons, and nothing else the page might say", () => {
    expect(checkPageRead({ ok: false, reason: "no-messages" })).toEqual({ ok: false, error: "no-messages" });
    expect(checkPageRead({ ok: false, reason: "empty-conversation" })).toEqual({ ok: false, error: "empty-conversation" });
    expect(checkPageRead({ ok: false, reason: "read-failed", detail: "TypeError: x" })).toEqual({ ok: false, error: "read-failed" });
    expect(checkPageRead({ ok: false, reason: "project-missing" })).toEqual({ ok: false, error: "invalid" });
    expect(checkPageRead({ ok: false })).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses malformed turns rather than saving part of them", () => {
    for (const turns of [undefined, "Why?", [{ role: "system", text: "x" }], [{ role: "user", text: 3 }], [null], [], [{ role: "user", text: " \n " }]]) {
      expect(checkPageRead({ ok: true, turns })).toEqual({ ok: false, error: "invalid" });
    }
  });
});

// ---------------------------------------------------------------------------
// Seen live on 2026-11-24 (signed out, element structure only; the text here is made up), and the fallbacks that keep
// Save working when a layout changes again.
// ---------------------------------------------------------------------------

const OCTANE = "https://chatgpt.com/uc/6b05b8fc-b6b0-83ea-8fd7-74faaff6107b";
// ChatGPT's signed-out layout of 2026-11-24: li[data-message-role] inside section[data-conversation-id], a code block's
// controls row and one-word label before its <pre>, the language on code[data-code-language], tables as data-d-components.
const octaneQuestion = (id, body) =>
  `<li data-message-role="user" id="${id}"><div data-submit-message-animation-target=""><div><div data-user-message-bubble=""><p data-user-message-copy="">${body}</p></div></div></div></li>`;
const octaneReply = (id, body, { complete = true } = {}) =>
  `<li data-message-role="assistant" id="${id}" data-assistant-content-started=""${complete ? ' data-message-complete=""' : ""}>` +
  `<h4 data-message-attribution="" aria-label="ChatGPT said:" tabindex="-1"></h4><div><span aria-hidden="true" data-assistant-placeholder-slot="" hidden=""><span></span></span>` +
  `<div><div><div data-assistant-markdown="" data-assistant-markdown-root=""><div aria-busy="false"><div><section aria-label="DIL content" dir="auto">${body}</section></div><div role="status"></div></div></div></div></div></div>` +
  `<div aria-label="Response actions" data-message-actions="" role="group"><button aria-label="Copy response" data-copy-message="">Copy</button><span aria-live="polite" role="status"></span></div></li>`;
const octaneCode = (language, lines) =>
  `<div><span data-message-content-controls=""><button type="button" aria-label="Copy code">Copy</button></span><div><span>${language}</span></div>` +
  `<pre><code data-code-language="${language}">${lines.map((line) => `<span>${line}</span>`).join("\n")}</code></pre></div>`;
const octaneTable = (rows) =>
  `<div data-d-component="table"><div data-d-table-viewport=""><table><tbody data-d-component="table-section">${rows
    .map(
      (row, index) =>
        `<tr data-d-component="table-row">${row
          .map((cell) => (index === 0 ? `<th data-d-component="table-cell"><p data-d-component="text">${cell}</p></th>` : `<td data-d-component="table-cell"><p data-d-component="text">${cell}</p></td>`))
          .join("")}</tr>`
    )
    .join("")}</tbody></table></div><div aria-hidden="true" data-d-overflow-edges=""></div></div>`;
const octanePage = (items, { stop = false } = {}) =>
  page(
    `<nav><a href="/uc/older">An older chat</a></nav><main data-slot="conversation"><div><section aria-label="Conversation" data-web-mobile-conversation="" data-conversation-id="6b05b8fc-b6b0-83ea-8fd7-74faaff6107b"><div data-mobile-thread=""><div data-mobile-thread-content="">` +
      `<ol aria-label="Conversation" data-conversation-transcript="">${items.join("")}</ol></div></div></section>` +
      `<form><textarea name="prompt"></textarea>${stop ? '<button type="button" aria-label="Stop generating"></button>' : '<button type="submit" aria-label="Send prompt"></button>'}</form></div></main>`,
    "ChatGPT: Chat, Work, Create & Code with AI"
  );

describe("live markup, 2026-11-24", () => {
  it("ChatGPT: reads the signed-out layout — fenced code with its language and no stray label, a table, no buttons or labels", async () => {
    const doc = octanePage([
      octaneQuestion("q1", "Write a Python adder, then compare tea and coffee."),
      octaneReply("a1", `<p data-d-component="text">Here it is.</p>${octaneCode("python", ["def add(a, b):", "    return a + b"])}${octaneTable([["Tea", "Coffee"], ["Less caffeine", "More caffeine"]])}`),
    ]);
    const read = await readConversationFromPage(doc, OCTANE, 0);
    expect(read).toMatchObject({ ok: true, provider: "chatgpt", strategy: "message-role" });
    expect(read.turns).toEqual([
      { role: "user", text: "Write a Python adder, then compare tea and coffee." },
      { role: "assistant", text: "Here it is.\n\n```python\ndef add(a, b):\n    return a + b\n```\n\nTea | Coffee\nLess caffeine | More caffeine" },
    ]);
    expect(read).not.toHaveProperty("responding");
  });

  it("ChatGPT: says a reply is still being written while its Stop button shows, and reads it whole once it stops", async () => {
    const doc = octanePage([octaneQuestion("q1", "Write an essay"), octaneReply("a1", `<p>The first half of the</p>`, { complete: false })], { stop: true });
    const streaming = await readConversationFromPage(doc, OCTANE, 0);
    expect(streaming).toMatchObject({ ok: true, responding: true });
    expect(checkPageRead(streaming)).toEqual({ ok: false, error: "still-responding", diagnostics: { turns: 2 } });

    setTimeout(() => {
      doc.querySelector('[aria-label="Stop generating"]').remove();
      doc.querySelector("section[aria-label='DIL content']").innerHTML = "<p>The whole essay.</p>";
    }, 300);
    const done = await readConversationFromPage(doc, OCTANE, 3000);
    expect(done).not.toHaveProperty("responding");
    expect(done.turns[1]).toEqual({ role: "assistant", text: "The whole essay." });
  });

  it("Gemini: a question waiting for its reply (pending-request), or a reply under a Stop button, is still responding", async () => {
    const doc = page(`<infinite-scroller><pending-request class="conversation-container"><user-query><div class="query-text">Explain tides</div></user-query></pending-request></infinite-scroller>`);
    expect(await readConversationFromPage(doc, "https://gemini.google.com/app/ca326f1a7f391868", 0)).toMatchObject({ ok: true, responding: true });
    const answering = page(`<user-query><div class="query-text">Explain tides</div></user-query><model-response><message-content><p>The moon</p></message-content></model-response><button aria-label="Stop response"></button>`);
    expect(await readConversationFromPage(answering, "https://gemini.google.com/app/ca326f1a7f391868", 0)).toMatchObject({ ok: true, responding: true });
  });

  it("Claude: a reply flagged data-is-streaming=true is still responding", async () => {
    const doc = page(claudeRow(0, 1, claudeQuestion("Hi")) + claudeRow(1, 0, claudeReply("Hel").replace('data-is-streaming="false"', 'data-is-streaming="true"')));
    expect(await readConversationFromPage(doc, "https://claude.ai/chat/446f8e09-fd3c-43b5-a8fa-5c5861dfb044", 0)).toMatchObject({ ok: true, responding: true });
  });

  it("Perplexity: reads a /session/ thread, its code fenced with the figcaption's language; 'Stop response (Esc)' means still responding", async () => {
    const SESSION = "https://www.perplexity.ai/session/2c347cdf-b595-4b86-8c02-2112937b702d";
    const answer =
      `<div data-renderer="lm" class="prose"><pre><figure><figcaption><span>python</span><div><button aria-label="Wrap lines"></button><button aria-label="Copy code"></button></div></figcaption>` +
      `<div><span><code><span>def add(a, b):</span>\n<span>    return a + b</span></code></span></div></figure></pre><h2 id="tea">Tea vs coffee</h2></div>`;
    const html = (stop) =>
      `<div data-sidebar-session-row="true"><div>Write a Python adder</div></div><div data-workflow-items="populated"><div dir="auto"><div data-message-bubble="right"><div data-renderer="lm"><p>Write a Python adder</p></div></div></div></div>` +
      `<div data-workflow-items="populated"><div><button aria-expanded="false"><div title="Finished">Finished</div></button></div><div dir="auto">${answer}</div></div>${stop ? '<button aria-label="Stop response (Esc)"></button>' : ""}`;
    expect(conversationIdentityOf(SESSION)).toMatchObject({ provider: "perplexity", conversationId: "2c347cdf-b595-4b86-8c02-2112937b702d" });
    const read = await readConversationFromPage(page(html(false)), SESSION, 0);
    expect(read.turns).toEqual([
      { role: "user", text: "Write a Python adder" },
      { role: "assistant", text: "```python\ndef add(a, b):\n    return a + b\n```\n\nTea vs coffee" },
    ]);
    expect(read).not.toHaveProperty("responding");
    expect(await readConversationFromPage(page(html(true)), SESSION, 0)).toMatchObject({ ok: true, responding: true });
  });
});

describe("when a layout changes: fallbacks, and an honest reason with diagnostics", () => {
  it("ChatGPT: a layout with no known attributes is still read by its screen-reader headings", async () => {
    const doc = page(
      `<main><div class="thread-x"><div class="turn-a"><h5 class="sr-only">You said:</h5><div class="bubble">Why is the sky blue?</div></div>` +
        `<div class="turn-b"><h5 class="sr-only">ChatGPT said:</h5><div class="answer"><p>Rayleigh scattering.</p><button>Copy</button></div></div></div></main>`
    );
    const read = await readConversationFromPage(doc, SIGNED_IN, 0);
    expect(read).toMatchObject({ ok: true, strategy: "role-heading" });
    expect(read.turns).toEqual([
      { role: "user", text: "Why is the sky blue?" },
      { role: "assistant", text: "Rayleigh scattering." },
    ]);
  });

  it("ChatGPT: a reply's own heading that starts 'You said' is text, not a message boundary", async () => {
    const doc = page(`<main><div><h5 class="sr-only">ChatGPT said:</h5><div><h3>You said it best</h3><p>Indeed.</p></div></div></main>`);
    expect((await readConversationFromPage(doc, SIGNED_IN, 0)).turns).toEqual([{ role: "assistant", text: "You said it best\n\nIndeed." }]);
  });

  it("ChatGPT: reads article[data-turn] turns", async () => {
    const doc = page(`<article data-turn="user"><div class="whitespace-pre-wrap">Hi</div></article><article data-turn="assistant"><div class="markdown"><p>Hello.</p></div></article>`);
    expect(await readConversationFromPage(doc, SIGNED_IN, 0)).toMatchObject({ ok: true, strategy: "turn", turns: [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello." }] });
  });

  it("ChatGPT: reads the whole page when the active-page wrapper holds no messages", async () => {
    const doc = page(`<div data-app-shell-active-page="true"><nav>Chats</nav></div><main>${unitTurn(0, "What caused WW1?", text("Militarism."))}</main>`);
    expect((await readConversationFromPage(doc, SIGNED_IN, 0)).turns).toEqual([
      { role: "user", text: "What caused WW1?" },
      { role: "assistant", text: "Militarism." },
    ]);
  });

  it("ChatGPT: never drops every turn because the page tags them with ids in another form", async () => {
    const doc = signedInPage([unitTurn(0, "What caused WW1?", text("Militarism."), "conv_01HXYZ"), unitTurn(1, "And then?", text("War."), "conv_01HXYZ")]);
    expect((await readConversationFromPage(doc, SIGNED_IN, 0)).turns).toHaveLength(4);
  });

  it("Claude: reads transcript rows by their row role when the message test ids are gone", async () => {
    const doc = page(
      `<div data-testid="transcript-row" data-perf-row="human" data-index="0" data-perf-row-from-tail="1"><h2 class="sr-only">You said: Hi</h2><div class="bubble"><p>Hi</p></div></div>` +
        `<div data-testid="transcript-row" data-perf-row="assistant" data-index="1" data-perf-row-from-tail="0"><div data-find-omitted="" data-state="closed">Thought for 2 seconds</div><div class="reply"><p>Hello there.</p></div></div>`
    );
    const read = await readConversationFromPage(doc, "https://claude.ai/chat/446f8e09-fd3c-43b5-a8fa-5c5861dfb044", 0);
    expect(read).toMatchObject({ ok: true, strategy: "transcript-row" });
    expect(read.turns).toEqual([
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello there." },
    ]);
  });

  it("Claude: reads by its spoken labels when nothing else is left", async () => {
    const doc = page(`<main><div><h2 class="sr-only">You said: Hi</h2><div><p>Hi</p></div></div><div><h2 class="sr-only">Claude responded: Hello.</h2><div><p>Hello.</p></div></div></main>`);
    expect(await readConversationFromPage(doc, "https://claude.ai/chat/446f8e09-fd3c-43b5-a8fa-5c5861dfb044", 0)).toMatchObject({
      ok: true,
      strategy: "role-heading",
      turns: [
        { role: "user", text: "Hi" },
        { role: "assistant", text: "Hello." },
      ],
    });
  });

  it("Gemini: reads the question and reply blocks when their custom elements are renamed", async () => {
    const doc = page(`<div class="turn"><div class="query-text">Explain tides</div></div><div class="turn"><message-content><p>The moon pulls the sea.</p></message-content></div>`);
    expect(await readConversationFromPage(doc, "https://gemini.google.com/app/ca326f1a7f391868", 0)).toMatchObject({
      ok: true,
      strategy: "content-blocks",
      turns: [{ role: "user" }, { role: "assistant", text: "The moon pulls the sea." }],
    });
  });

  it("Perplexity: reads the answer from its renderer when the prose class is gone", async () => {
    const doc = page(`<div data-message-bubble="right"><div data-renderer="lm"><p>Why?</p></div></div><div><div data-renderer="lm"><p>Because.</p></div></div>`);
    expect(await readConversationFromPage(doc, "https://www.perplexity.ai/session/2c347cdf-b595-4b86-8c02-2112937b702d", 0)).toMatchObject({
      ok: true,
      strategy: "bubble-renderer",
      turns: [
        { role: "user", text: "Why?" },
        { role: "assistant", text: "Because." },
      ],
    });
  });

  it("says not-loaded while the app is still loading the conversation", async () => {
    const doc = page(`<main><div aria-busy="true"><div class="placeholder"></div></div></main>`);
    expect(await readConversationFromPage(doc, SIGNED_IN, 0)).toMatchObject({ ok: false, reason: "not-loaded", provider: "chatgpt", diagnostics: { loading: true } });
  });

  it("says what each strategy found when nothing is recognised — counts only, never the page's text", async () => {
    const doc = page(`<main><div class="new-thing">A private question about my health</div><textarea></textarea></main>`, "A private title");
    const read = await readConversationFromPage(doc, SIGNED_IN, 0);
    expect(read).toMatchObject({
      ok: false,
      reason: "no-messages",
      diagnostics: { strategies: { "unit-key": 0, "message-role": 0, turn: 0, "role-heading": 0 }, main: true, composer: true, responding: false },
    });
    expect(JSON.stringify(read)).not.toMatch(/private/i);
  });

  it("reads a long conversation whole and in order", async () => {
    const turns = Array.from({ length: 150 }, (_, n) => unitTurn(n, `Question ${n}`, text(`Answer ${n}.`)));
    const read = await readConversationFromPage(signedInPage(turns), SIGNED_IN, 0);
    expect(read.turns).toHaveLength(300);
    expect(read.turns[0]).toEqual({ role: "user", text: "Question 0" });
    expect(read.turns[299]).toEqual({ role: "assistant", text: "Answer 149." });
    expect(read.turns.every((turn, n) => turn.role === (n % 2 === 0 ? "user" : "assistant"))).toBe(true);
    // jsdom's selector engine scans the whole document for every query scoped to an element, so 300 messages take
    // seconds here (the same read took 3–24 ms in Chrome on a live chat, 2026-11-25): the default 5 s is too tight.
  }, 60_000);
});

describe("checkPageRead: the extraction contract", () => {
  it("refuses a read whose reply was still being written, and passes on the strategy that read it", () => {
    expect(checkPageRead({ ok: true, turns: [{ role: "user", text: "Q" }], responding: true })).toEqual({ ok: false, error: "still-responding", diagnostics: { turns: 1 } });
    expect(checkPageRead({ ok: true, turns: [{ role: "user", text: "Q" }], strategy: "message-role" })).toMatchObject({ ok: true, strategy: "message-role" });
    expect(checkPageRead({ ok: true, turns: [{ role: "user", text: "Q" }], strategy: "<b>evil</b>" })).not.toHaveProperty("strategy");
  });

  it("passes on not-loaded, and only numbers and booleans of a failure's diagnostics", () => {
    expect(
      checkPageRead({ ok: false, reason: "not-loaded", diagnostics: { loading: true, elements: 4, note: "page text", strategies: { "unit-key": 0, "page text here": 3, turn: "x" } } })
    ).toEqual({
      ok: false,
      error: "not-loaded",
      diagnostics: { loading: true, elements: 4, strategies: { "unit-key": 0 } },
    });
  });
});

// ChatGPT signed in as served on 2026-11-25 (seen live, structure only): the reply's root is
// [data-markdown-text-style="assistant-message"]; [data-markdown-copy="contents"] — the reply root of 2026-10 —
// now marks a small inline chip inside a reply; a reply's body is drawn a moment after its turn; and a long chat
// is windowed: only turns near the screen are in the page, older ones load at the top, and the content-search
// keys ("fallback-turn-N:…") count from the first turn loaded, so they shift. Only data-turn-key is stable.
describe("ChatGPT, signed in (live markup, 2026-11-25)", () => {
  const reply = (body) => `<div data-markdown-text-style="assistant-message">${body}</div>`;
  const chip = (label) => `<span data-markdown-copy="contents"><span>${label}</span></span>`;

  it("reads the whole reply when an inline chip carries the old reply-root marker, not just the chip", async () => {
    const doc = signedInPage([
      unitTurn(0, "Plan the redesign", reply(`${text(`Start with the ${chip("Command Centre")} rail.`)}${text("Then the graph.")}`)),
      unitTurn(1, "And then?", reply(text("Ship it."))),
    ]);
    // unitTurn wraps its answer in [data-markdown-copy="contents"]; the live page no longer does.
    for (const wrapper of doc.querySelectorAll('[data-chatgpt-copy-reference][data-markdown-copy="contents"]')) wrapper.removeAttribute("data-markdown-copy");
    const read = await readConversationFromPage(doc, SIGNED_IN, 0);
    expect(read.turns).toEqual([
      { role: "user", text: "Plan the redesign" },
      { role: "assistant", text: "Start with the Command Centre rail.\n\nThen the graph." },
      { role: "user", text: "And then?" },
      { role: "assistant", text: "Ship it." },
    ]);
    expect(read).not.toHaveProperty("partial");
  });

  it("waits for a reply whose body is drawn after its turn, rather than saving the question alone", async () => {
    const doc = signedInPage([unitTurn(0, "What caused WW1?", "")]);
    const body = doc.querySelector('[data-content-search-unit-key$=":assistant"] [data-d-inline-reveal]');
    setTimeout(() => {
      body.innerHTML = text("Militarism and alliances.");
    }, 300);
    const read = await readConversationFromPage(doc, SIGNED_IN, 3000);
    expect(read.turns).toEqual([
      { role: "user", text: "What caused WW1?" },
      { role: "assistant", text: "Militarism and alliances." },
    ]);
    expect(read).not.toHaveProperty("partial");
  });

  it("says partial when a reply is still not drawn once the wait is over — never a silent loss", async () => {
    const doc = signedInPage([unitTurn(0, "First?", ""), unitTurn(1, "Second?", text("Second answer."))]);
    const read = await readConversationFromPage(doc, SIGNED_IN, 300);
    expect(read).toMatchObject({ ok: true, partial: true });
    expect(read.turns.map((turn) => turn.role)).toEqual(["user", "user", "assistant"]);
  });

  // A thread that windows like ChatGPT's: 100px a turn, a 200px box, only turns near the screen mounted, older
  // turns loaded five at a time when the box reaches its top (keeping what was on screen in place).
  function windowedChat(total, loaded, { snapOnce } = {}) {
    const doc = signedInPage([]);
    const thread = doc.querySelector('[data-thread-find-target="conversation"]');
    const list = thread.querySelector(":scope > div:last-child");
    thread.setAttribute("style", "overflow-y: auto");
    const state = { from: total - loaded, top: 0, writes: 0 };
    const status = doc.createElement("div");
    status.innerHTML = `<div role="status"><span>Loading older messages…</span></div>`;
    thread.insertBefore(status, list);
    const height = () => (total - state.from) * 100;
    const draw = () => {
      status.hidden = state.from === 0;
      const html = [];
      for (let n = state.from; n < total; n++) {
        const y = (n - state.from) * 100;
        if (y + 100 < state.top - 100 || y > state.top + 300) continue;
        html.push(unitTurn(n, `Question ${n}`, text(`Answer ${n}.`)).replaceAll(`fallback-turn-${n}:`, `fallback-turn-${n - state.from}:`));
      }
      list.innerHTML = html.join("");
    };
    Object.defineProperty(thread, "clientHeight", { get: () => 200 });
    Object.defineProperty(thread, "scrollHeight", { get: height });
    Object.defineProperty(thread, "scrollTop", {
      get: () => state.top,
      set: (value) => {
        state.writes += 1;
        state.top = Math.max(0, Math.min(height() - 200, Math.round(value)));
        draw();
        // The app snapping the thread to its end on its own, once, mid-way down.
        if (snapOnce && state.from === 0 && state.top >= snapOnce) {
          snapOnce = 0;
          setTimeout(() => {
            state.top = height() - 200;
            draw();
          }, 30);
        }
        if (state.top === 0 && state.from > 0)
          setTimeout(() => {
            const added = Math.min(5, state.from);
            state.from -= added;
            state.top += added * 100;
            draw();
          }, 50);
      },
    });
    state.top = height() - 200;
    draw();
    return { doc, state };
  }

  it("Save scrolls a windowed chat through and keeps every message once, in order, then puts the scroll back", async () => {
    const { doc, state } = windowedChat(12, 4);
    const read = await readConversationFromPage(doc, SIGNED_IN, 0, 20000);
    expect(read.turns).toHaveLength(24);
    expect(read.turns.map((turn) => turn.text)).toEqual(Array.from({ length: 12 }, (_, n) => [`Question ${n}`, `Answer ${n}.`]).flat());
    expect(read).not.toHaveProperty("partial");
    expect(read).not.toHaveProperty("olderNotLoaded");
    expect(state.top).toBe((12 - state.from) * 100 - 200);
  }, 30000);

  it("keeps its place when the app snaps the thread to its end mid-way, and still reads the middle", async () => {
    const { doc } = windowedChat(16, 4, { snapOnce: 500 });
    // ChatGPT snaps back to the latest reply when the thread moves with no sign of a person scrolling: each move is
    // announced with a wheel event first.
    const thread = doc.querySelector('[data-thread-find-target="conversation"]');
    let wheels = 0;
    thread.addEventListener("wheel", () => (wheels += 1));
    const read = await readConversationFromPage(doc, SIGNED_IN, 0, 30000);
    expect(read.turns.map((turn) => turn.text)).toEqual(Array.from({ length: 16 }, (_, n) => [`Question ${n}`, `Answer ${n}.`]).flat());
    expect(read).not.toHaveProperty("partial");
    expect(wheels).toBeGreaterThan(5);
  }, 40000);

  it("the passive read (no collect time) never scrolls the person's page, and says what it did not have", async () => {
    const { doc, state } = windowedChat(12, 4);
    const read = await readConversationFromPage(doc, SIGNED_IN, 0);
    expect(state.writes).toBe(0);
    expect(read).toMatchObject({ ok: true, olderNotLoaded: true });
    expect(read.turns.length).toBeLessThan(24);
  });

  it("says partial when the scroll-through runs out of time", async () => {
    const { doc } = windowedChat(40, 4);
    const read = await readConversationFromPage(doc, SIGNED_IN, 0, 800);
    expect(read).toMatchObject({ ok: true, partial: true });
  }, 15000);
});

describe("Claude, signed in (live markup, 2026-11-25)", () => {
  const CLAUDE = "https://claude.ai/chat/98d51b6c-9a25-4117-97c9-759bb09d81c0";
  // Each row carries data-perf-row (human / assistant) and its place in the whole chat; some questions have lost
  // their user-message test id.
  const row = (index, role, inner) => `<div data-testid="transcript-row" data-index="${index}" data-perf-row="${role}">${inner}</div>`;
  const bare = (text) => `<div data-user-scope=""><div data-turn-key="q${text.length}"><p class="whitespace-pre-wrap">${text}</p></div></div>`;
  const tagged = (text) => `<div data-user-scope=""><div data-turn-key="q${text.length}"><div data-testid="user-message"><p>${text}</p></div></div></div>`;
  const answer = (text) => `<div data-reply-scope=""><div data-testid="assistant-message"><div class="standard-markdown"><p>${text}</p></div></div></div>`;

  it("keeps a question that lost its user-message test id, rather than the first strategy that found both sides", async () => {
    const doc = page(row(0, "human", bare("First question")) + row(1, "assistant", answer("First answer.")) + row(2, "human", tagged("Second question")) + row(3, "assistant", answer("Second answer.")));
    const read = await readConversationFromPage(doc, CLAUDE, 0);
    expect(read.turns).toEqual([
      { role: "user", text: "First question" },
      { role: "assistant", text: "First answer." },
      { role: "user", text: "Second question" },
      { role: "assistant", text: "Second answer." },
    ]);
    expect(read).not.toHaveProperty("partial");
  });

  it("keeps a question that was only an attached file, by the file's name, so the chat still starts with the question", async () => {
    const file = `<div data-user-scope=""><div data-turn-key="q0"><div data-find-omitted=""><div data-testid="file-thumbnail"><span aria-hidden="true"></span><div data-cds-card-body=""><span>Thesis draft.pdf</span><span>.pdf</span><bdi>PDF</bdi></div></div></div></div></div>`;
    const doc = page(row(0, "human", file) + row(1, "assistant", answer("Read it.")) + row(2, "human", tagged("Thoughts?")) + row(3, "assistant", answer("Strong.")));
    const read = await readConversationFromPage(doc, CLAUDE, 0);
    expect(read.turns).toEqual([
      { role: "user", text: "[Attached file: Thesis draft.pdf]" },
      { role: "assistant", text: "Read it." },
      { role: "user", text: "Thoughts?" },
      { role: "assistant", text: "Strong." },
    ]);
  });

  it("says empty-conversation for a chat Claude itself says is empty (one opened only for an artifact)", async () => {
    const doc = page(`<div data-testid="transcript-list"><div data-testid="empty-conversation-line">This conversation has no messages yet</div></div><div data-testid="chat-input" contenteditable="true"></div>`);
    expect(await readConversationFromPage(doc, CLAUDE, 0)).toMatchObject({ ok: false, reason: "empty-conversation", provider: "claude" });
  });

  it("Save collects a windowed Claude chat by each row's place in it, even when turn ids repeat", async () => {
    const doc = page(`<div id="box" style="overflow-y: auto"><div id="rows"></div></div>`);
    const box = doc.getElementById("box");
    const rows = doc.getElementById("rows");
    // Questions carry their testid only on some rows, so the strategy that reads a screen changes as it scrolls.
    const all = Array.from({ length: 10 }, (_, n) => (n % 2 === 1 ? row(n, "assistant", answer(`Answer ${n}.`)) : row(n, "human", n % 4 === 0 ? bare("Same length?") : tagged("Same length?"))));
    let top = 800;
    const draw = () => {
      const first = Math.floor(top / 100);
      rows.innerHTML = all.slice(Math.max(0, first - 1), first + 3).join("");
    };
    Object.defineProperty(box, "clientHeight", { get: () => 200 });
    Object.defineProperty(box, "scrollHeight", { get: () => 1000 });
    Object.defineProperty(box, "scrollTop", {
      get: () => top,
      set: (value) => {
        top = Math.max(0, Math.min(800, Math.round(value)));
        draw();
      },
    });
    draw();
    const read = await readConversationFromPage(doc, CLAUDE, 0, 20000);
    expect(read.turns).toHaveLength(10);
    expect(read.turns.filter((turn) => turn.role === "user")).toHaveLength(5);
    expect(read.turns.map((turn) => turn.text).filter((text) => text.startsWith("Answer"))).toEqual(["Answer 1.", "Answer 3.", "Answer 5.", "Answer 7.", "Answer 9."]);
    expect(read).not.toHaveProperty("partial");
    expect(top).toBe(800);
  }, 30000);
});
