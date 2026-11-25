// AI app pages: which ones Hubble for Chrome knows, how to read the
// conversation on screen, and how to put context into the message box.
//
// Mirrors src/lib/providers/registry.ts on the web app side (hosts and
// conversation paths); extension/src/ai-pages.test.js holds the two to the
// same answers.
//
// ## Only when asked, only this page
//
// Nothing here runs on its own. `readConversationFromPage` and
// `insertIntoComposer` are injected with chrome.scripting.executeScript into
// the one tab the person is looking at, after they click Save or Insert in
// the popup — the `activeTab` grant that click gives is the only access the
// extension has to an AI app. No host permission, no content script on these
// sites, no background reading of other tabs, no cookies or account data.
//
// ## Self-contained on purpose
//
// executeScript serializes a function and runs it in the page, so both
// functions carry their own helpers: they must not reference anything else
// in this module. They take an optional document and address so tests can
// run them against saved page fixtures.
//
// ## Pages change
//
// AI apps change their markup without notice, and ChatGPT runs more than one
// layout at a time (2026-10-15: signed-in chats had dropped the role
// attributes the signed-out ones still carried). The readers look for the
// message elements each app uses — ChatGPT's as a list of layouts, tried in
// order — and fail with a reason rather than guess: a page with no readable
// messages is "no-messages", never an empty save. The popup then offers the
// fallback — reload and save again, or import the app's export in Hubble.

export const AI_PAGE_HOSTS = {
  chatgpt: ["chatgpt.com", "chat.openai.com"],
  claude: ["claude.ai"],
  gemini: ["gemini.google.com"],
  perplexity: ["www.perplexity.ai", "perplexity.ai"],
};

export const AI_PROVIDER_NAMES = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity" };

// Each conversation page: its path (first group = the conversation's id) and its kind. Ids are only compared within
// one kind — a share link's id is the share's, and ChatGPT's signed-out /uc/ chats are not known to share ids with /c/.
const CONVERSATION_PATHS = {
  chatgpt: [
    { path: /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9-]{8,80})\/?$/, kind: "chat" },
    { path: /^\/uc\/([A-Za-z0-9-]{8,80})\/?$/, kind: "signed-out" },
    { path: /^\/share\/([A-Za-z0-9-]{8,80})\/?$/, kind: "share" },
  ],
  claude: [
    { path: /^\/chat\/([A-Za-z0-9-]{8,80})\/?$/, kind: "chat" },
    { path: /^\/share\/([A-Za-z0-9-]{8,80})\/?$/, kind: "share" },
  ],
  gemini: [
    { path: /^\/app\/([A-Za-z0-9_-]{6,80})\/?$/, kind: "chat" },
    { path: /^\/gem\/[^/]+\/([A-Za-z0-9_-]{6,80})\/?$/, kind: "chat" },
    { path: /^\/share\/([A-Za-z0-9_-]{6,80})\/?$/, kind: "share" },
  ],
  // 2026-11-24: new threads open at /session/<uuid>; older ones keep /search/<slug>.
  perplexity: [
    { path: /^\/search\/([A-Za-z0-9._-]{6,200})\/?$/, kind: "chat" },
    { path: /^\/session\/([A-Za-z0-9-]{8,80})\/?$/, kind: "chat" },
  ],
};

/** The AI app this address belongs to, or undefined. */
export function aiProviderOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  const host = parsed.hostname.toLowerCase();
  return Object.keys(AI_PAGE_HOSTS).find((id) => AI_PAGE_HOSTS[id].includes(host));
}

/**
 * Which conversation an address names — { provider, conversationId, url, key }
 * — or undefined for any other page (an app's home page, settings, a new chat
 * that has no id yet, another site). The same answers as `conversationRefOf`
 * in src/lib/providers/registry.ts (ai-pages.test.js holds them together).
 *
 * `key` is what tells conversations apart: provider, kind of page and id
 * ("chatgpt:chat:6720a1b2-…"). chat.openai.com or chatgpt.com, a `?model=`,
 * a fragment or a trailing slash change nothing; a different id is always a
 * different conversation, whatever its title. Never the provider or host
 * alone: nothing here says "this app already has a saved chat".
 */
export function conversationIdentityOf(url) {
  const provider = aiProviderOf(url);
  if (!provider) return undefined;
  const parsed = new URL(url);
  for (const { path, kind } of CONVERSATION_PATHS[provider]) {
    const match = path.exec(parsed.pathname);
    // Ids are compared exactly — case and every character — so two similar ids stay two conversations.
    if (match?.[1]) return { provider, conversationId: match[1], url: `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`, key: `${provider}:${kind}:${match[1]}` };
  }
  return undefined;
}

/** Whether this address is one conversation (not the app's home page or settings). */
export function isConversationUrl(url) {
  return conversationIdentityOf(url) !== undefined;
}

/**
 * Reads the conversation on screen. Runs in the page.
 *
 * ## What comes back (the extraction contract)
 *
 *   { ok: true, provider, url, title, turns: [{ role, text }], truncated, strategy }
 *     and, each only when it is so:
 *       olderNotLoaded  ChatGPT says earlier messages are still to load above
 *       partial         the app keeps only the messages near the screen on the
 *                       page (Claude and Perplexity do for long chats)
 *       responding      the app was still writing its last reply when the wait
 *                       ran out — what was read is not the whole reply
 *
 *   { ok: false, reason, provider?, detail?, diagnostics? }
 *       not-supported       not an AI app this reads           unsupported_platform
 *       not-loaded          the app is still loading this      conversation_not_loaded
 *                           conversation (a progress bar or a busy region
 *                           where the messages go)
 *       empty-conversation  the conversation is on screen      conversation_not_loaded
 *                           and has no messages
 *       no-messages         none of this app's adapters        no_messages_found
 *                           found a message with text: its layout changed
 *       read-failed         reading the page threw; `detail`   extraction_failed
 *                           is the error, never the page's text
 *
 * A failure carries `diagnostics` — what each adapter looked for and how many
 * elements it found, and a few landmarks of the page — counts and booleans
 * only, never the page's text, so a layout change can be told apart from a
 * page that hadn't loaded, and reported.
 *
 * What a note means is the caller's to decide: Save refuses a read that is
 * still `responding` (checkPageRead below says "still-responding") rather
 * than keep half a reply; the background's passive read keeps it as partial.
 *
 * ## Adapters
 *
 * Each app has its own list of strategies, tried in order — the layouts seen
 * live first, then structural fallbacks that survive class and attribute
 * renames (the screen-reader headings "You said:" / "ChatGPT said:" the apps
 * put before each message). The first strategy that finds both questions and
 * replies with text is the page's (failing that, the one that found the
 * most), and only it is read: one message is never read twice by two
 * strategies. `strategy` names it, for the log.
 *
 * A page still rendering, or a reply still streaming, is read again until
 * `waitMs` has passed. Each read starts from nothing, so a retry never
 * repeats a message.
 *
 * Text is rebuilt from the elements rather than taken from innerText: code
 * blocks keep their lines and come back fenced with their language, list
 * items keep a marker, table cells stay on their row, and the app's own
 * labels and buttons ("ChatGPT said:", "Copy code") are left out.
 *
 * A message whose element is there but whose text is not yet drawn (ChatGPT
 * paints a reply's body a moment after its turn, 2026-11-25) is waited for,
 * never silently left out: a read that still lacks one when the wait ends
 * says `partial`, and a question left without its reply counts as one.
 *
 * ## Long chats: scrolling through (Save only)
 *
 * ChatGPT (signed in, 2026-11-25), Claude and Perplexity keep only the
 * messages near the screen in the page — scrolling mounts others and
 * unmounts these — so no single read holds a long chat. With `collectMs`
 * (Save passes it; the passive read never does, so it never moves the
 * person's page), when the messages carry the app's own keys and sit in a
 * scrolling thread, the reader scrolls that thread to its top (loading older
 * messages), then down a screen at a time, collecting each message once by
 * its key in page order, and puts the scroll back where it was. A pass that
 * runs out of time says `partial`.
 */
export async function readConversationFromPage(doc, href, waitMs = 3000, collectMs = 0) {
  const page = doc || document;
  const address = href || location.href;
  const MAX_TOTAL = 2000000;
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(address);
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    return { ok: false, reason: "not-supported" };
  }
  const provider =
    host === "chatgpt.com" || host === "chat.openai.com"
      ? "chatgpt"
      : host === "claude.ai"
        ? "claude"
        : host === "gemini.google.com"
          ? "gemini"
          : host === "www.perplexity.ai" || host === "perplexity.ai"
            ? "perplexity"
            : undefined;
  if (!provider) return { ok: false, reason: "not-supported" };

  // Never part of what anyone said.
  const SKIP = [
    "script", "style", "noscript", "template", "svg", "textarea", "input", "select", "button",
    "[hidden]", '[aria-hidden="true"]', '[role="status"]',
    // Text only screen readers get (Gemini repeats the whole question as "You said …").
    ".cdk-visually-hidden", ".sr-only", ".visually-hidden", '[class*="screen-reader"]',
    // ChatGPT: what its own Copy leaves out (code-block headers, turn separators), and its "You said:" / "ChatGPT said:" labels.
    '[data-markdown-copy="exclude"]', "h4[data-message-attribution]", "h4[data-conversation-role]", "[data-message-content-controls]",
    // Gemini: a code block's header (its language name and buttons) — the name goes on the fence instead.
    ".code-block-decoration",
    // Claude: thinking and tool panels, and its spoken labels.
    "[data-find-omitted]",
  ].join(", ");
  const CODE = "[data-code-block], pre";
  // A file the person attached (Claude's file card, 2026-11-25): kept as its name, even where it sits in a part
  // the app hides from search, so a question that was only a file keeps its place in the chat.
  const ATTACHMENT = '[data-testid="file-thumbnail"]';
  const attachmentOf = (card) => {
    const leaf = [...card.querySelectorAll("*")].find((el) => !el.firstElementChild && (el.textContent || "").trim());
    const name = ((leaf || card).textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
    return name ? `[Attached file: ${name}]` : "[Attached file]";
  };
  const LANGUAGE = /^[A-Za-z][\w+#.-]{0,19}$/;
  const BLOCK = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "SECTION", "SUMMARY", "TABLE", "TBODY", "TFOOT", "THEAD", "TR", "UL"]);
  const PARAGRAPH = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TABLE", "UL", "OL", "FIGURE"]);
  const HOLD = "";
  // Where an app keeps a message's own key, in order: Claude's row in the whole chat, Perplexity's entry, ChatGPT's
  // turn id (data-turn-key, a UUID — its content-search keys "fallback-turn-18:0:user" count from the first turn
  // loaded, so they shift as older ones load, 2026-11-25), a message id.
  const KEY_HOLDERS = [
    ["data-index", '[data-testid="transcript-row"][data-index], [data-perf-row][data-index]'],
    ["data-workflow-entry", "[data-workflow-entry]"],
    ["data-turn-key", "[data-turn-key]"],
    ["data-message-id", "[data-message-id]"],
  ];
  // What the last read found, message by message (key, role, text — "" for one not drawn yet), for the waits below.
  let last = null;
  // Whether the page shows an element: not inside [hidden], and drawn where the browser can tell (checkVisibility).
  const visible = (el) => !el.closest("[hidden]") && (typeof el.checkVisibility !== "function" || el.checkVisibility());

  // Messages into turns: blank ones left out (the read says so), one reply split across several nodes kept as one
  // turn, and no more than MAX_TOTAL characters in all.
  const assemble = (messages) => {
    const turns = [];
    let total = 0;
    for (const message of messages) {
      if (!message.text || total >= MAX_TOTAL) continue;
      const kept = message.text.slice(0, MAX_TOTAL - total);
      total += kept.length;
      const prior = turns[turns.length - 1];
      if (prior && prior.role === message.role && message.role === "assistant") prior.text = `${prior.text}\n\n${kept}`;
      else turns.push({ role: message.role, text: kept });
    }
    return { turns, truncated: total >= MAX_TOTAL };
  };
  // A question followed straight by another question: the reply between them is missing from this read.
  const unanswered = (turns) => turns.some((turn, index) => turn.role === "user" && turns[index + 1] && turns[index + 1].role === "user");
  // Two replies (or questions) from different rows side by side: the message between them is missing. Turns can't
  // show it — two replies in a row become one turn — so this looks at the keyed messages.
  const holderOf = (key) => (key || "").replace(/:(user|assistant):[0-9]+$/, "");
  const gapped = (messages) => {
    const read = messages.filter((message) => message.text);
    return read.some((message, index) => {
      const next = read[index + 1];
      return next && next.role === message.role && message.key && next.key && holderOf(message.key) !== holderOf(next.key);
    });
  };

  // Elements in document order, without any that sit inside another match (a wrapper and its inner node are one message).
  // Linear: each element's ancestors are checked against the set, not every pair (a 300-message chat took seconds).
  const outermost = (elements) => {
    const set = new Set(elements);
    return elements.filter((el) => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) if (set.has(parent)) return false;
      return true;
    });
  };

  // The language a code block declares on its code element, lower-cased, or "".
  const declaredLanguage = (el) => {
    const code = el.matches("pre") ? el.querySelector("code") : el.querySelector("[data-language]") || el.querySelector("code");
    const named = code && (code.getAttribute("data-language") || code.getAttribute("data-code-language") || (/(?:^|\s)language-([\w+#.-]+)/.exec(code.getAttribute("class") || "") || [])[1]);
    return named ? named.toLowerCase() : "";
  };

  // The one-word label a <pre>'s wrapper shows before it, which names its language: signed-out ChatGPT's
  // <div><span>python</span><pre> (2026-10-15), and with a controls row and data-code-language beside it (2026-11-24).
  const labelOf = (pre) => {
    const parent = pre.parentElement;
    if (!parent || parent.children.length > 4) return null;
    const declared = declaredLanguage(pre);
    for (let sibling = pre.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.querySelector("pre, code")) return null;
      const text = (sibling.textContent || "").trim();
      if (!text) continue;
      if (!LANGUAGE.test(text)) return null;
      // A declared language must be the label's; without one, only a lone bare label next to its <pre> counts.
      if (declared) return text.toLowerCase() === declared ? sibling : null;
      return parent.children.length === 2 && !sibling.firstElementChild ? sibling : null;
    }
    return null;
  };

  // Is the app still writing a reply? Its Stop button is the one sign every app shows; some also mark the reply.
  const STOP = /^stop (generating|response|responding|streaming|answer|answering)\b/i;
  const MARKERS = {
    chatgpt: ".result-streaming",
    claude: '[data-is-streaming="true"]',
    gemini: 'pending-request, model-response [aria-busy="true"]',
    perplexity: "",
  };
  const respondingNow = () => {
    const stop = [...page.querySelectorAll('button[aria-label], [data-testid="stop-button"]')].some(
      (el) => !el.closest('[hidden], [aria-hidden="true"]') && (el.matches('[data-testid="stop-button"]') || STOP.test((el.getAttribute("aria-label") || "").trim()))
    );
    return stop || Boolean(MARKERS[provider] && page.querySelector(MARKERS[provider]));
  };
  // Is the app still loading the page or this conversation?
  const loadingNow = () =>
    Boolean(page.querySelector('main [aria-busy="true"], main [role="progressbar"], [data-testid="conversation-loading"], [class*="skeleton"]'));

  function readOnce() {
    const code = [];
    // Elements that are the app's furniture inside a message (a code label, a role heading): left out of its text.
    const omit = new Set();
    const codeOf = (el) => {
      const editor = el.querySelector("[data-language]");
      const inner = el.matches("pre") ? el.querySelector("code") : editor || el.querySelector("pre code, code");
      const label = el.matches("pre") ? labelOf(el) : null;
      const block = el.closest("code-block");
      const header = block && block.querySelector(".code-block-decoration");
      // Gemini names the language in the block's header; Perplexity (2026-11-24) in a <figcaption> inside the <pre>.
      const caption = el.matches("pre") ? el.querySelector("figcaption") : null;
      const shown = [header, caption].map((part) => (part ? ((part.querySelector("span") || part).textContent || "").trim() : "")).find((name) => LANGUAGE.test(name));
      const named = declaredLanguage(el) || (label ? label.textContent.trim().toLowerCase() : "") || (shown ? shown.toLowerCase() : "");
      let body;
      if (!inner) body = render(el, true);
      else {
        // A code editor draws one element per line.
        const lines = [...inner.children];
        body = lines.length > 0 && lines.every((line) => line.tagName === "DIV") ? lines.map((line) => line.textContent || "").join("\n") : inner.textContent || "";
      }
      return "```" + named + "\n" + body.replace(/^\n+/, "").replace(/\s+$/, "") + "\n```";
    };
    function render(root, verbatim = false) {
      let out = "";
      // At least `lines` line breaks here: two blocks meeting share one break, not one each.
      const breakTo = (lines) => {
        const have = /\n*$/.exec(out)[0].length;
        if (out && have < lines) out += "\n".repeat(lines - have);
      };
      const walk = (node) => {
        if (node.nodeType === 3) {
          const value = node.nodeValue || "";
          if (verbatim) out += value;
          else if (!value.trim()) {
            // Markup indentation is not text; a space between two words is.
            if (!value.includes("\n") && out && !/\s$/.test(out)) out += " ";
          } else out += value.includes("\n") ? value : value.replace(/[ \t\f\v]{2,}/g, " ");
          return;
        }
        if (node.nodeType !== 1) return;
        if (!verbatim && node.matches(ATTACHMENT)) {
          breakTo(1);
          out += attachmentOf(node);
          breakTo(1);
          return;
        }
        if (node.matches(SKIP) || omit.has(node)) {
          if (!verbatim) for (const card of node.querySelectorAll(ATTACHMENT)) {
            breakTo(1);
            out += attachmentOf(card);
            breakTo(1);
          }
          return;
        }
        // A formula (KaTeX) as the TeX it was written in, not its rendered glyphs followed by that TeX.
        // Gemini also keeps the TeX on the formula's wrapper (data-math), read there first: it is there even when KaTeX's MathML copy is not.
        const wrapped = !verbatim && node.matches(".math-inline[data-math], .math-block[data-math]") && (node.getAttribute("data-math") || "").trim();
        const annotation = !wrapped && !verbatim && node.matches(".katex, math") && node.querySelector('annotation[encoding="application/x-tex"]');
        const tex = wrapped || (annotation && annotation.textContent.trim());
        if (tex) {
          const display = wrapped
            ? node.matches(".math-block") || node.querySelector(".katex-display")
            : node.closest(".katex-display") || node.matches('math[display="block"]') || node.querySelector('math[display="block"]');
          if (display) breakTo(2);
          out += display ? `$$${tex}$$` : `$${tex}$`;
          if (display) breakTo(2);
          return;
        }
        if (!verbatim && node.matches(CODE)) {
          code.push(codeOf(node));
          breakTo(2);
          out += `${HOLD}${code.length - 1}${HOLD}`;
          breakTo(2);
          return;
        }
        const tag = node.tagName.toUpperCase();
        if (tag === "BR") {
          out += "\n";
          return;
        }
        const part = node.getAttribute("data-d-component");
        if (tag === "TD" || tag === "TH" || part === "table-cell") {
          out += (node.previousElementSibling ? " | " : "") + render(node, verbatim).replace(/\s*\n\s*/g, " ").trim();
          return;
        }
        const item = tag === "LI" || part === "list-item";
        // A paragraph inside a list item is that item's line, not a paragraph of its own.
        const paragraph = PARAGRAPH.has(tag) && !(node.parentElement && node.parentElement.closest('li, [data-d-component="list-item"]'));
        const gap = verbatim ? 0 : paragraph ? 2 : item || BLOCK.has(tag) || part === "table-row" ? 1 : 0;
        breakTo(gap);
        if (item && !verbatim) {
          const list = node.parentElement;
          out += list && list.tagName === "OL" ? `${[...list.children].indexOf(node) + 1}. ` : "- ";
        }
        for (const child of node.childNodes) walk(child);
        breakTo(gap);
      };
      for (const child of root.childNodes) walk(child);
      return out;
    }
    const textOf = (elements) => {
      // A code block's language label goes on its fence, not into the text.
      for (const el of elements) for (const pre of el.querySelectorAll("pre")) {
        const label = labelOf(pre);
        if (label) omit.add(label);
      }
      return elements
        .map((el) => render(el))
        .join("\n\n")
        .replace(/\r\n?/g, "\n")
        // A list item's text sits in its own paragraph: back on the marker's line.
        .replace(/(^|\n)(- |\d+\. )\s+(?!- |\d+\. )/g, "$1$2")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"), (_, index) => code[Number(index)]);
    };

    // The first selector that matches inside `el` — every match of it, a reply can come in parts — and holds most
    // of the message. A match holding only a sliver is not the body: on 2026-11-25 ChatGPT's old reply root
    // ([data-markdown-copy="contents"]) marked a small inline chip inside the reply, and reading only that chip
    // dropped the whole reply. The whole message is read then, its labels and buttons still left out.
    const bodyOf = (el, selectors) => {
      const whole = (el.textContent || "").trim().length;
      for (const selector of selectors) {
        const matches = outermost([...el.querySelectorAll(selector)]);
        const held = matches.reduce((sum, match) => sum + (match.textContent || "").trim().length, 0);
        if (matches.length > 0 && held * 2 >= whole) return matches;
      }
      return [el];
    };
    const all = (scope, selector) => outermost(scope.flatMap((root) => [...root.querySelectorAll(selector)]));

    // The fallback every app shares: the screen-reader heading each message starts with ("You said: …",
    // "ChatGPT said:", "Claude responded: …"). The message is the heading's nearest wrapper holding more than it.
    const HIDDEN = '.sr-only, .cdk-visually-hidden, .visually-hidden, [class*="screen-reader"], [data-message-attribution], [data-conversation-role]';
    const byHeading = (assistant) => (scope) => {
      const used = new Set();
      const found = [];
      const labels = all(scope, "h1, h2, h3, h4, h5, h6, [role='heading']")
        .map((heading) => {
          const said = (heading.getAttribute("aria-label") || heading.textContent || "").trim();
          const role = /^you said\b/i.test(said) ? "user" : assistant.test(said) ? "assistant" : undefined;
          // A heading in a reply that happens to start "You said" is text: only a label (hidden, or ending in ":") counts.
          return role && (heading.matches(HIDDEN) || /^[^:]{0,40}:/.test(said)) ? { heading, role } : undefined;
        })
        .filter(Boolean);
      for (const { heading, role } of labels) {
        const own = (heading.textContent || "").trim();
        let el = heading.parentElement;
        while (el && el !== page.body && !(el.textContent || "").replace(own, "").trim()) el = el.parentElement;
        // A label whose message has no text yet (a reply still to be drawn) climbs into the turn around it: that
        // wrapper holds another message's label, so it is not this message — never read a question as its reply.
        if (el && labels.some((other) => other.heading !== heading && el.contains(other.heading))) continue;
        if (!el || el === page.body || used.has(el)) continue;
        used.add(el);
        omit.add(heading);
        found.push({ role, el });
      }
      return found;
    };

    // 2026-11-25 (signed in): the reply's root is [data-markdown-text-style="assistant-message"].
    const CHATGPT_BODY = ["[data-markdown-text-style]", '[data-markdown-copy="contents"]', "[data-assistant-markdown-root]", ".markdown", "[data-user-message-bubble]", ".whitespace-pre-wrap"];
    const ADAPTERS = {
      chatgpt: [
        // Signed in at /c/ (2026-10-15): one element per message, keyed "<turn>:<n>:<role>".
        { name: "unit-key", find: (scope) => all(scope, "[data-content-search-unit-key]").map((el) => ({ el, role: (/:(user|assistant)$/.exec(el.getAttribute("data-content-search-unit-key") || "") || [])[1] })) },
        // The role on the message itself: li[data-message-role] (signed out, 2026-10-14 and 2026-11-24) and the earlier data-message-author-role.
        { name: "message-role", find: (scope) => all(scope, "[data-message-author-role], [data-message-role]").map((el) => ({ el, role: el.getAttribute("data-message-author-role") || el.getAttribute("data-message-role") })) },
        // A turn that names its role: article[data-turn] / [data-testid="conversation-turn-N"].
        {
          name: "turn",
          find: (scope) =>
            all(scope, 'article[data-turn], [data-testid^="conversation-turn-"]').map((el) => ({ el, role: el.getAttribute("data-turn") || (el.querySelector("[data-turn], [data-message-author-role]") || el).getAttribute("data-message-author-role") || undefined })),
        },
        { name: "role-heading", find: byHeading(/^chatgpt said\b/i) },
      ],
      claude: [
        // Signed in (2026-10-16): [data-testid="assistant-message"], text in [data-perf-reply-text]; earlier .font-claude-response / -message.
        { name: "message-testid", find: (scope) => all(scope, '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response, .font-claude-message').map((el) => ({ el, role: el.matches('[data-testid="user-message"]') ? "user" : "assistant" })) },
        // Each transcript row says whose it is.
        { name: "transcript-row", find: (scope) => all(scope, "[data-perf-row]").map((el) => ({ el, role: { human: "user", user: "user", assistant: "assistant" }[el.getAttribute("data-perf-row")] })) },
        // A reply carries its streaming flag whatever else it is called.
        { name: "streaming-flag", find: (scope) => all(scope, '[data-testid="user-message"], [data-is-streaming]').map((el) => ({ el, role: el.matches("[data-is-streaming]") ? "assistant" : "user" })) },
        { name: "role-heading", find: byHeading(/^claude (responded|said)\b/i) },
      ],
      gemini: [
        { name: "query-response", find: (scope) => all(scope, "user-query, model-response").map((el) => ({ el, role: el.tagName.toLowerCase() === "user-query" ? "user" : "assistant" })) },
        { name: "content-blocks", find: (scope) => all(scope, ".query-text, message-content").map((el) => ({ el, role: el.matches(".query-text") ? "user" : "assistant" })) },
        { name: "role-heading", find: byHeading(/^gemini said\b/i) },
      ],
      perplexity: [
        { name: "bubble-prose", find: (scope) => all(scope, '[data-testid="query-text"], [class*="group/query"], [data-message-bubble="right"], .prose').map((el) => ({ el, role: el.classList.contains("prose") ? "assistant" : "user" })) },
        // 2026-11-24: the question's bubble and the answer are both rendered by [data-renderer]; only the bubble is the person's.
        { name: "bubble-renderer", find: (scope) => all(scope, '[data-message-bubble="right"], [data-renderer]').map((el) => ({ el, role: el.matches("[data-message-bubble]") ? "user" : "assistant" })) },
      ],
    };
    const BODY = {
      chatgpt: { user: CHATGPT_BODY, assistant: CHATGPT_BODY },
      claude: { user: ['[data-testid="user-message"]'], assistant: ["[data-perf-reply-text]", ".standard-markdown, .progressive-markdown"] },
      gemini: { user: [".query-text"], assistant: ["message-content", ".markdown"] },
      perplexity: { user: [], assistant: [] },
    };

    // Where this conversation is. After a switch inside the app, ChatGPT keeps the chat you came from in the
    // page (data-app-shell-active-page="false", seen live 2026-10-15): its questions keep their text, its
    // replies are emptied. The active page is read first, the whole page only if it holds no messages.
    const marks = provider === "chatgpt" ? [...page.querySelectorAll("[data-app-shell-active-page]")] : [];
    const active = outermost(marks.filter((mark) => mark.getAttribute("data-app-shell-active-page") === "true"));
    const scopes = active.length > 0 ? [active, [page]] : [[page]];
    // A turn tagged with another conversation's id is left out — but only when the page tags turns with ids in
    // this address's form at all: ids in some other form say nothing about which chat a turn is.
    const chatId = provider === "chatgpt" ? (/^\/(?:g\/[^/]+\/)?u?c\/([A-Za-z0-9-]{8,80})\/?$/.exec(pathname) || [])[1] : undefined;
    const idsOf = (el) => {
      const turn = el.closest("[data-turn-key]") || el;
      const tagged = [...turn.querySelectorAll("[data-chatgpt-selection-conversation-id]")].filter((node) => !turn.matches("[data-turn-key]") || node.closest("[data-turn-key]") === turn).map((node) => node.getAttribute("data-chatgpt-selection-conversation-id"));
      const section = el.closest("[data-conversation-id]");
      return section ? [...tagged, section.getAttribute("data-conversation-id")] : tagged;
    };

    // The app's own key for a message, stable while it is scrolled out of the page and back: its turn's id
    // (ChatGPT), or its row's place in the whole chat (Claude, Perplexity), with its role and order there.
    // Undefined when the page gives none — that read cannot be collected across scrolling.
    const keysOf = (items) => {
      const seen = new Map();
      return items.map((item) => {
        // The first kind of key, in KEY_HOLDERS' order, that a wrapper of the message carries — the same for every
        // strategy, which can change from one screen to the next (Claude's message test ids or its rows), and never
        // a wrapper of an earlier turn that happens to hold this one.
        let holder;
        let name;
        for (const [attribute, selector] of KEY_HOLDERS) {
          holder = item.el.closest(selector);
          if (holder) {
            name = attribute;
            break;
          }
        }
        if (!holder) return undefined;
        const slot = `${name}=${holder.getAttribute(name)}:${item.role}`;
        const nth = seen.get(holder)?.[item.role] || 0;
        seen.set(holder, { ...seen.get(holder), [item.role]: nth + 1 });
        return `${slot}:${nth}`;
      });
    };

    const tried = {};
    let picked;
    for (const scope of scopes) {
      for (const strategy of ADAPTERS[provider]) {
        let items = strategy.find(scope).filter((item) => (item.role === "user" || item.role === "assistant") && !item.el.closest('nav, aside, [role="navigation"]'));
        if (chatId && items.some((item) => idsOf(item.el).includes(chatId))) items = items.filter((item) => {
          const ids = idsOf(item.el);
          return ids.length === 0 || ids.includes(chatId);
        });
        const keys = keysOf(items);
        const messages = items.map((item, index) => {
          const body = BODY[provider][item.role];
          return { key: keys[index], role: item.role, el: item.el, text: textOf(body.length > 0 ? bodyOf(item.el, body) : [item.el]) };
        });
        const { turns, truncated } = assemble(messages);
        tried[strategy.name] = Math.max(tried[strategy.name] || 0, items.length);
        // Questions and replies both found: this is the page's layout. One that found only one side (a renamed
        // reply element) is kept in case nothing better turns up, never preferred over one that found both. Every
        // strategy is tried until one looks whole, and the best wins (ties keep the earlier): on 2026-11-25 Claude
        // left its user-message test id off some questions, so the first strategy found both sides yet lost a question.
        const both = turns.some((turn) => turn.role === "user") && turns.some((turn) => turn.role === "assistant");
        // Better: both sides found, then no message missing between two others, then more turns.
        const whole = !gapped(messages);
        const better = !picked || (both && !picked.both) || (both === picked.both && ((whole && !picked.whole) || (whole === picked.whole && turns.length > picked.turns.length)));
        if (turns.length > 0 && better) {
          picked = { strategy: strategy.name, items, messages, turns, truncated, both, whole };
        }
        // A pick that looks whole — both sides, starting with a question, no message missing between two others — ends the search.
        if (picked && picked.both && picked.turns[0].role === "user" && !unanswered(picked.turns) && !gapped(picked.messages)) break;
      }
      if (picked) break;
    }

    const responding = respondingNow();
    const within = (selector) => scopes[0].flatMap((root) => [...root.querySelectorAll(selector)]);
    if (!picked) {
      const found = Object.values(tried).reduce((sum, count) => sum + count, 0);
      // Empty only when the conversation area is there and holds nothing but a loading notice. Turns or
      // text Hubble could not read are a layout it no longer understands, never "no messages".
      const thread = provider === "chatgpt" && found === 0 && within('[data-thread-find-target="conversation"], [data-conversation-transcript]')[0];
      const notices = thread ? [...thread.querySelectorAll('[role="status"]')].map((status) => status.textContent || "") : [];
      // Claude says so itself (2026-11-25): a chat opened only for an artifact has an empty-conversation line and no rows.
      const empty =
        (thread && !thread.querySelector("[data-turn-key], li") && !notices.reduce((text, notice) => text.replace(notice, ""), thread.textContent || "").trim()) ||
        (provider === "claude" && found === 0 && Boolean(page.querySelector('[data-testid="empty-conversation-line"]')));
      const loading = !empty && found === 0 && loadingNow();
      const diagnostics = {
        strategies: tried,
        activePage: active.length > 0,
        main: Boolean(page.querySelector("main")),
        thread: Boolean(thread),
        composer: Boolean(page.querySelector('textarea, [contenteditable="true"]')),
        responding,
        loading: loadingNow(),
        elements: page.querySelectorAll("*").length,
      };
      return { ok: false, reason: empty ? "empty-conversation" : loading ? "not-loaded" : "no-messages", provider, diagnostics };
    }

    const { turns } = picked;
    const title = String(page.title || "").trim().slice(0, 300);
    const read = { ok: true, provider, url: address, title, turns, truncated: picked.truncated, strategy: picked.strategy };
    // ChatGPT shows only the latest messages of a long chat and says so above them ("Loading older messages…").
    const firstMessage = picked.items[0] && picked.items[0].el;
    const thread = provider === "chatgpt" && firstMessage && firstMessage.closest('[data-thread-find-target="conversation"]');
    const pending = thread && [...thread.querySelectorAll('[role="status"]')].some((status) => (status.textContent || "").trim() && visible(status) && status.compareDocumentPosition(firstMessage) & 4);
    if (pending) read.olderNotLoaded = true;
    let partial = false;
    if (provider === "claude") {
      // A long chat keeps only the rows near the screen mounted; each row knows its place in the whole chat.
      const rows = [...page.querySelectorAll('[data-testid="transcript-row"]')];
      partial = rows.length > 0 && (Math.min(...rows.map((row) => Number(row.getAttribute("data-index")) || 0)) > 0 || Math.min(...rows.map((row) => Number(row.getAttribute("data-perf-row-from-tail")) || 0)) > 0);
    } else if (provider === "perplexity") {
      // Signed in (2026-10-16), a thread keeps only the turns near the screen mounted: opened at its end, it
      // starts mid-way, with a reply and no question before it.
      const entries = [...page.querySelectorAll("[data-workflow-entry]")].map((el) => Number(el.getAttribute("data-workflow-entry")) || 0);
      partial = (entries.length > 0 && Math.min(...entries) > 0) || turns[0].role === "assistant";
    }
    // A message on the page whose text isn't drawn yet, or a question left without its reply, is part of the
    // chat this read doesn't have: never left out without saying so.
    const blank = picked.messages.filter((message) => !message.text).length;
    if (blank > 0 || unanswered(turns) || gapped(picked.messages)) partial = true;
    if (partial) read.partial = true;
    if (responding) read.responding = true;
    last = { messages: picked.messages, blank, first: firstMessage, pending: Boolean(pending) };
    return read;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Reads until the page has a readable chat, its reply finished and every message drawn — or until `until`. A
  // message that stays blank while nothing else changes for a while is not going to be drawn: that read is taken.
  // With `box`, only messages on screen in it count: ChatGPT draws a reply only once it scrolls into view, and one
  // mounted below the screen is read on a later step.
  const onScreen = (box, el) => {
    const shown = box.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return shown.height === 0 || rect.height === 0 || (rect.bottom > shown.top && rect.top < shown.bottom);
  };
  const settle = async (until, box) => {
    let stableSince = Date.now();
    let previous = "";
    for (;;) {
      last = null;
      const read = readOnce();
      const waiting = last ? last.messages.filter((message) => !message.text && (!box || onScreen(box, message.el))).length : 0;
      if (read.ok && !read.responding && waiting === 0) return read;
      const shape = last ? last.messages.map((message) => `${message.key}=${message.text.length}`).join(",") : "";
      if (shape !== previous) stableSince = Date.now();
      previous = shape;
      if (read.ok && !read.responding && Date.now() - stableSince >= 1500) return read;
      if (Date.now() >= until) return read;
      await sleep(read.ok ? 150 : 250);
    }
  };

  // The thread's scrolling box: the nearest ancestor of a message that scrolls, or the page itself.
  const scrollerOf = (el) => {
    const view = page.defaultView || (typeof window !== "undefined" ? window : undefined);
    for (let node = el && el.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 4 && view && /(auto|scroll|overlay)/.test(view.getComputedStyle(node).overflowY || "")) return node;
    }
    const root = page.scrollingElement;
    return root && view && root.scrollHeight > view.innerHeight + 4 ? root : undefined;
  };

  // Moves the box as a person's scrolling would: a wheel event first, then the position. ChatGPT (2026-11-25) snaps
  // its thread back to the latest reply when it moves with no sign of the person scrolling — 10 snaps in 60 steps on
  // a long chat, none with the wheel event. The event itself scrolls nothing.
  const moveTo = (box, top) => {
    try {
      const view = page.defaultView || (typeof window !== "undefined" ? window : undefined);
      const Wheel = view && (view.WheelEvent || view.Event);
      if (Wheel) box.dispatchEvent(new Wheel("wheel", { deltaY: top - box.scrollTop, bubbles: true, cancelable: true }));
    } catch {
      // No wheel event here: the position is still set.
    }
    box.scrollTop = top;
  };

  // Scrolls `box` through the whole chat and collects every message by its key, in page order. Each pass's
  // messages are placed after the last one already known before them, so order holds however the page windows.
  const collect = async (box, first, until) => {
    const order = [];
    const byKey = new Map();
    const take = () => {
      let after = -1;
      for (const message of last ? last.messages : []) {
        const known = byKey.get(message.key);
        if (known) {
          if (message.text.length > known.text.length) known.text = message.text;
          after = order.indexOf(message.key);
        } else {
          byKey.set(message.key, { ...message });
          order.splice(after + 1, 0, message.key);
          after += 1;
        }
      }
    };
    let read = first;
    take();
    // Up to its top, waiting for older messages to load: done when the box is at the top and stops growing.
    const topBy = Date.now() + Math.max(1000, (until - Date.now()) * 0.4);
    let height = -1;
    let still = 0;
    while (Date.now() < topBy && still < 2) {
      moveTo(box, 0);
      await sleep(400);
      last = null;
      read = readOnce();
      take();
      still = box.scrollTop <= 1 && box.scrollHeight === height && !(last && last.pending) ? still + 1 : 0;
      height = box.scrollHeight;
    }
    const top = still >= 2;
    // Down a screen at a time, letting each screen's messages draw. The app may move the box on its own — ChatGPT
    // snapped a long thread to its end mid-way (2026-11-25), which once looked like reaching the bottom and lost the
    // middle — so the walk keeps its own place, puts the box back when it was moved, and is at the end only when
    // that place is. A screen read while the box was elsewhere is not taken.
    let bottom = false;
    let lost = false;
    let at = box.scrollTop;
    let moved = 0;
    for (;;) {
      read = await settle(Math.min(until, Date.now() + 2500), box);
      if (Math.abs(box.scrollTop - at) > box.clientHeight / 2) {
        if (moved < 5 && Date.now() < until) {
          moved += 1;
          moveTo(box, at);
          await sleep(100);
          continue;
        }
        // It won't stay: what lies between here and where it went may be missed.
        lost = true;
        at = box.scrollTop;
      }
      take();
      // A small move is the browser keeping the screen's content still while turns above are measured (scroll
      // anchoring): the next step starts from where the box really is, or a strip would be stepped over.
      at = box.scrollTop;
      bottom = at + box.clientHeight >= box.scrollHeight - 2;
      if (bottom || Date.now() >= until) break;
      const next = Math.min(box.scrollHeight - box.clientHeight, at + Math.max(80, Math.floor(box.clientHeight * 0.85)));
      if (next <= at) {
        bottom = true;
        break;
      }
      at = next;
      moved = 0;
      moveTo(box, at);
      await sleep(150);
    }
    return { read, messages: order.map((key) => byKey.get(key)), whole: top && bottom && !lost };
  };

  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  try {
    let read = await settle(deadline);
    const limit = Math.max(0, Number(collectMs) || 0);
    const box = read.ok && limit > 0 && last && last.messages.every((message) => message.key) ? scrollerOf(last.first) : undefined;
    if (!box) return read;
    // Put back by its distance from the end: older messages loaded above would move a plain offset.
    const fromEnd = box.scrollHeight - box.scrollTop;
    // Someone reading the latest reply is put back at the end, however much the chat's height changed meanwhile.
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    let pass;
    try {
      pass = await collect(box, read, Date.now() + limit);
    } finally {
      box.scrollTop = atEnd ? box.scrollHeight : Math.max(0, box.scrollHeight - fromEnd);
    }
    if (atEnd) {
      await sleep(60);
      box.scrollTop = box.scrollHeight;
    }
    const { turns, truncated } = assemble(pass.messages);
    if (turns.length === 0) return read;
    const whole = pass.whole && pass.messages.every((message) => message.text) && !unanswered(turns) && !gapped(pass.messages);
    const collected = { ok: true, provider, url: address, title: read.ok ? read.title : String(page.title || "").trim().slice(0, 300), turns, truncated, strategy: read.ok ? read.strategy : "collected" };
    if (!whole) collected.partial = true;
    if (pass.read.responding || read.responding) collected.responding = true;
    return collected;
  } catch (err) {
    // Chrome turns a thrown error into no result at all, which the popup could only call "Chrome didn't let
    // Hubble read this page". Said as what it is instead, with the error (never the page's text) for the log.
    return { ok: false, reason: "read-failed", provider, detail: `${(err && err.name) || "Error"}: ${(err && err.message) || ""}`.slice(0, 200) };
  }
}

const PAGE_READ_REASONS = new Set(["not-supported", "not-loaded", "no-messages", "empty-conversation", "read-failed"]);

/** A failed read's diagnostics, re-checked: numbers, booleans and short names only — never anything the page wrote. */
export function readDiagnostics(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const plain = (value) => typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
  const out = {};
  for (const [key, value] of Object.entries(raw).slice(0, 20)) {
    if (!/^[a-z][A-Za-z-]{0,30}$/.test(key)) continue;
    if (plain(value)) out[key] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner = {};
      for (const [name, count] of Object.entries(value).slice(0, 20)) if (/^[a-z][a-z-]{0,30}$/.test(name) && plain(count)) inner[name] = count;
      out[key] = inner;
    }
  }
  return out;
}

/**
 * What `readConversationFromPage` sent back, re-checked in the extension
 * before it goes anywhere: the page is the AI app's, not ours, so a result
 * that is missing, malformed or carries a reason this file never gives is a
 * failure with a reason, never a save. Resolves to
 * { ok: true, title, turns, olderNotLoaded, partial, strategy } or
 * { ok: false, error, diagnostics? }.
 *
 * A read whose reply was still being written is refused ("still-responding"):
 * Save keeps whole conversations, so it waits for the reply rather than keep
 * half of it.
 */
export function checkPageRead(read) {
  if (!read || typeof read !== "object") return { ok: false, error: "page-unreadable" };
  if (read.ok !== true) {
    const diagnostics = readDiagnostics(read.diagnostics);
    return { ok: false, error: PAGE_READ_REASONS.has(read.reason) ? read.reason : "invalid", ...(diagnostics ? { diagnostics } : {}) };
  }
  if (!Array.isArray(read.turns)) return { ok: false, error: "invalid" };
  const turns = [];
  for (const turn of read.turns) {
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.text !== "string") return { ok: false, error: "invalid" };
    if (turn.text.trim()) turns.push({ role: turn.role, text: turn.text });
  }
  if (turns.length === 0) return { ok: false, error: "invalid" };
  if (read.responding === true) return { ok: false, error: "still-responding", diagnostics: { turns: turns.length } };
  return {
    ok: true,
    title: typeof read.title === "string" ? read.title : "",
    turns,
    olderNotLoaded: read.olderNotLoaded === true,
    partial: read.partial === true,
    ...(typeof read.strategy === "string" && /^[a-z-]{1,40}$/.test(read.strategy) ? { strategy: read.strategy } : {}),
  };
}

/**
 * Puts `text` into the AI app's message box, after anything already there,
 * and never sends it. Runs in the page. Resolves to { inserted: true } only
 * when the text is then found in the box; otherwise { inserted: false,
 * reason: "no-composer" | "not-inserted" } so the popup can copy instead and
 * say that it did.
 *
 * Async because rich editors (Perplexity's, for one) render inserted text a
 * moment after the event: checking at once reported a failure for text that
 * had arrived, and the fallback paste then inserted it a second time.
 */
export async function insertIntoComposer(text, doc, href) {
  const page = doc || document;
  const address = href || location.href;
  let host = "";
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return { inserted: false, reason: "no-composer" };
  }
  const SELECTORS = {
    chatgpt: ["#prompt-textarea", 'div[contenteditable="true"].ProseMirror', 'textarea[name="prompt"]', "form textarea"],
    claude: ['div[contenteditable="true"].ProseMirror', '[data-testid="chat-input"]', 'fieldset div[contenteditable="true"]'],
    gemini: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
    perplexity: ["#ask-input", 'textarea[placeholder]', 'div[contenteditable="true"][role="textbox"]'],
  };
  const provider =
    host === "chatgpt.com" || host === "chat.openai.com"
      ? "chatgpt"
      : host === "claude.ai"
        ? "claude"
        : host === "gemini.google.com"
          ? "gemini"
          : host === "www.perplexity.ai" || host === "perplexity.ai"
            ? "perplexity"
            : undefined;
  if (!provider) return { inserted: false, reason: "no-composer" };

  let box;
  for (const selector of SELECTORS[provider]) {
    box = [...page.querySelectorAll(selector)].find((el) => el.isConnected && !el.closest("[aria-hidden='true']"));
    if (box) break;
  }
  if (!box) return { inserted: false, reason: "no-composer" };

  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const probe = normalize(text).slice(0, 60);
  const contains = () => normalize(box.value !== undefined && (box.tagName === "TEXTAREA" || box.tagName === "INPUT") ? box.value : box.innerText || box.textContent).includes(probe);
  // Up to ~600 ms for the editor to show what it was given.
  const arrived = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (contains()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return contains();
  };

  try {
    box.focus();
  } catch {
    // A box that cannot take focus is tried anyway; the check below decides.
  }

  if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
    const view = page.defaultView || window;
    const proto = box.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const next = box.value ? `${box.value}\n\n${text}` : text;
    if (setter) setter.call(box, next);
    else box.value = next;
    box.dispatchEvent(new view.Event("input", { bubbles: true }));
    return (await arrived()) ? { inserted: true } : { inserted: false, reason: "not-inserted" };
  }

  // A rich editor: caret to the end, then the way a person's typing arrives.
  const view = page.defaultView || window;
  try {
    const selection = view.getSelection && view.getSelection();
    if (selection && page.createRange) {
      const range = page.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } catch {
    // No selection API: the editor keeps its own caret.
  }
  const prefix = normalize(box.innerText || box.textContent) ? "\n\n" : "";
  let done = false;
  try {
    done = typeof page.execCommand === "function" && page.execCommand("insertText", false, prefix + text) && (await arrived());
  } catch {
    done = false;
  }
  if (!done && !contains()) {
    // Editors that ignore execCommand still take a paste.
    try {
      const data = new view.DataTransfer();
      data.setData("text/plain", prefix + text);
      box.dispatchEvent(new view.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      done = await arrived();
    } catch {
      done = false;
    }
  }
  done = done || contains();
  return done ? { inserted: true } : { inserted: false, reason: "not-inserted" };
}
