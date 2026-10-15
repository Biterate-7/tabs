// The AI-page reader and the message-box insert, run against saved page
// fixtures shaped like each app's markup. These are fixtures, not the live
// apps: they hold the code to the structure it was written for, and the
// failure paths (an unrecognised layout, no message box) to an honest
// reason instead of a guess.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_PAGE_HOSTS, aiProviderOf, checkPageRead, insertIntoComposer, isConversationUrl, readConversationFromPage } from "./ai-pages.js";
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
    expect(await readConversationFromPage(doc, "https://chatgpt.com/c/6720a1b2-1111-2222", 0)).toEqual({ ok: false, reason: "no-messages", provider: "chatgpt" });
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

function unitTurn(index, question, answer) {
  return `<div data-turn-key="69ff8060-e2b1-46e6-b070-f80adac4016${index}">
    <div data-content-search-turn-key="fallback-turn-${index}">
      <div aria-label="Sent" role="separator" data-markdown-copy="exclude"><time><span>11:2${index}</span></time></div>
      <div><div data-talvt-turn-state="complete">
        <div><div>
          <h4>You said:</h4>
          <div data-chatgpt-search-unit-key="fallback-turn-${index}:0:user" data-content-search-unit-key="fallback-turn-${index}:0:user" data-chatgpt-search-message-ids="">
            <div><div data-user-message-bubble="true"><div><div><div data-search-result-target=""><div><div style="white-space: pre-wrap">${question}</div></div></div></div></div></div>
            <div><span data-state="closed"><button aria-label="Copy message"><svg><path></path></svg></button></span><span data-state="closed"><button aria-label="Edit message"><svg><path></path></svg></button></span></div>
          </div>
        </div>
        <div>
          <span data-chatgpt-agent-turn-start=""></span>
          <div data-content-search-unit-key="fallback-turn-${index}:1:assistant" data-chatgpt-search-unit-key="fallback-turn-${index}:1:assistant" data-chatgpt-search-message-ids="">
            <h4 data-conversation-role="assistant">ChatGPT said:</h4>
            <div><div data-chatgpt-selection-message-id="m${index}"><div data-markdown-text-style="assistant-message"><div data-dil-source-message-id="" data-chatgpt-copy-reference="0" data-markdown-copy="contents"><div><div hidden=""></div><div data-theme="dark"><div data-d-inline-reveal="" data-d-direction="col">${answer}</div></div></div></div></div></div>
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

  it("says no-messages — the paste fallback — when the message keys are gone, though the page has text", async () => {
    const doc = page(
      `<main><div data-thread-find-target="conversation"><div data-turn-key="t1"><div><div>What caused WW1?</div></div><div><div>Militarism and alliances.</div></div></div></div>
       <form><textarea name="prompt"></textarea></form></main>`
    );
    expect(await readConversationFromPage(doc, SIGNED_IN, 0)).toEqual({ ok: false, reason: "no-messages", provider: "chatgpt" });
  });

  it("says no-messages when messages are found but none has readable text", async () => {
    expect(await readConversationFromPage(signedInPage([unitTurn(0, "", "")]), SIGNED_IN, 0)).toEqual({ ok: false, reason: "no-messages", provider: "chatgpt" });
  });

  it("says empty-conversation for a conversation with no messages", async () => {
    expect(await readConversationFromPage(signedInPage([]), SIGNED_IN, 0)).toEqual({ ok: false, reason: "empty-conversation", provider: "chatgpt" });
    // A loading notice is not a message either.
    expect(await readConversationFromPage(signedInPage([], { status: "Loading…" }), SIGNED_IN, 0)).toEqual({ ok: false, reason: "empty-conversation", provider: "chatgpt" });
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
    expect(await readConversationFromPage(page(`<main><div>Something else</div></main>`), SIGNED_IN, 300)).toEqual({ ok: false, reason: "no-messages", provider: "chatgpt" });
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
    ).toEqual({ ok: true, title: "Causes of WW1", turns: [{ role: "user", text: "Why?" }, { role: "assistant", text: "Because." }], olderNotLoaded: true });
  });

  it("says the page gave no answer when the script returned nothing", () => {
    for (const nothing of [undefined, null, "ok", 3]) expect(checkPageRead(nothing)).toEqual({ ok: false, error: "page-unreadable" });
  });

  it("passes on the reader's own reasons, and nothing else the page might say", () => {
    expect(checkPageRead({ ok: false, reason: "no-messages" })).toEqual({ ok: false, error: "no-messages" });
    expect(checkPageRead({ ok: false, reason: "empty-conversation" })).toEqual({ ok: false, error: "empty-conversation" });
    expect(checkPageRead({ ok: false, reason: "project-missing" })).toEqual({ ok: false, error: "invalid" });
    expect(checkPageRead({ ok: false })).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses malformed turns rather than saving part of them", () => {
    for (const turns of [undefined, "Why?", [{ role: "system", text: "x" }], [{ role: "user", text: 3 }], [null], [], [{ role: "user", text: " \n " }]]) {
      expect(checkPageRead({ ok: true, turns })).toEqual({ ok: false, error: "invalid" });
    }
  });
});
