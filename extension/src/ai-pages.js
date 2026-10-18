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
// fallback — paste the conversation in Hubble.

export const AI_PAGE_HOSTS = {
  chatgpt: ["chatgpt.com", "chat.openai.com"],
  claude: ["claude.ai"],
  gemini: ["gemini.google.com"],
  perplexity: ["www.perplexity.ai", "perplexity.ai"],
};

export const AI_PROVIDER_NAMES = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity" };

const CONVERSATION_PATHS = {
  chatgpt: [/^\/(?:g\/[^/]+\/)?c\/[A-Za-z0-9-]{8,80}\/?$/, /^\/uc\/[A-Za-z0-9-]{8,80}\/?$/, /^\/share\/[A-Za-z0-9-]{8,80}\/?$/],
  claude: [/^\/chat\/[A-Za-z0-9-]{8,80}\/?$/, /^\/share\/[A-Za-z0-9-]{8,80}\/?$/],
  gemini: [/^\/app\/[A-Za-z0-9_-]{6,80}\/?$/, /^\/gem\/[^/]+\/[A-Za-z0-9_-]{6,80}\/?$/, /^\/share\/[A-Za-z0-9_-]{6,80}\/?$/],
  perplexity: [/^\/search\/[A-Za-z0-9._-]{6,200}\/?$/],
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

/** Whether this address is one conversation (not the app's home page or settings). */
export function isConversationUrl(url) {
  const provider = aiProviderOf(url);
  if (!provider) return false;
  const path = new URL(url).pathname;
  return CONVERSATION_PATHS[provider].some((pattern) => pattern.test(path));
}

/**
 * Reads the conversation on screen. Runs in the page.
 * Resolves to { ok: true, provider, url, title, turns: [{ role, text }], truncated }
 * (plus `olderNotLoaded: true` when the app says earlier messages are still
 * to load, and `partial: true` when the app keeps only the messages near the
 * screen on the page — Claude and Perplexity do for long chats, so no scroll
 * position has them all) or { ok: false, reason }:
 *
 *   not-supported       not an AI app this reads
 *   no-messages         nothing here looks like the app's messages: its
 *                       layout changed, so the popup offers the paste fallback
 *   empty-conversation  the conversation is on screen but has no messages
 *                       (a new chat, or one that has not loaded)
 *   read-failed         reading the page threw (`detail` says what, never
 *                       the page's text)
 *
 * A page still rendering is read again until `waitMs` has passed before
 * either failure is given. Each read starts from nothing, so a retry never
 * repeats a message.
 *
 * Text is rebuilt from the elements rather than taken from innerText: code
 * blocks keep their lines and come back fenced with their language, list
 * items keep a marker, table cells stay on their row, and the app's own
 * labels and buttons ("ChatGPT said:", "Copy code") are left out.
 */
export async function readConversationFromPage(doc, href, waitMs = 3000) {
  const page = doc || document;
  const address = href || location.href;
  const MAX_TOTAL = 2000000;
  let host = "";
  try {
    host = new URL(address).hostname.toLowerCase();
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
    "script", "style", "noscript", "template", "svg", "textarea", "input", "select",
    "[hidden]", '[aria-hidden="true"]',
    // Text only screen readers get (Gemini repeats the whole question as "You said …").
    ".cdk-visually-hidden", ".sr-only", ".visually-hidden", '[class*="screen-reader"]',
    // ChatGPT: what its own Copy leaves out (code-block headers, turn separators), and its "You said:" / "ChatGPT said:" labels.
    '[data-markdown-copy="exclude"]', "h4[data-message-attribution]", "h4[data-conversation-role]",
    // Gemini: a code block's header (its language name and buttons) — the name goes on the fence instead.
    ".code-block-decoration",
  ].join(", ");
  const CODE = "[data-code-block], pre";
  const BLOCK = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "SECTION", "SUMMARY", "TABLE", "TBODY", "TFOOT", "THEAD", "TR", "UL"]);
  const PARAGRAPH = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TABLE", "UL", "OL", "FIGURE"]);
  const HOLD = "\uE000";

  // Elements in document order, without any that sit inside another match (a wrapper and its inner node are one message).
  const outermost = (elements) => elements.filter((el) => !elements.some((other) => other !== el && other.contains(el)));

  // A <pre> whose wrapper holds only it and a one-word label before it (signed-out ChatGPT, 2026-10-15): the label names its language.
  const labelOf = (pre) => {
    const label = pre.previousElementSibling;
    return label && !label.firstElementChild && pre.parentElement.children.length === 2 && /^[A-Za-z][\w+#.-]{0,19}$/.test((label.textContent || "").trim()) ? label : null;
  };

  function readOnce() {
    const code = [];
    const codeOf = (el) => {
      const editor = el.querySelector("[data-language]");
      const inner = el.matches("pre") ? el.querySelector("code") : editor || el.querySelector("pre code, code");
      const label = el.matches("pre") ? labelOf(el) : null;
      const block = el.closest("code-block");
      const header = block && block.querySelector(".code-block-decoration");
      const headerName = header ? ((header.querySelector("span") || header).textContent || "").trim() : "";
      const named = (inner && inner.getAttribute("data-language")) || (/(?:^|\s)language-([\w+#.-]+)/.exec((inner && inner.getAttribute("class")) || "") || [])[1] || (label ? label.textContent.trim().toLowerCase() : "") || (/^[A-Za-z][\w+#.-]{0,19}$/.test(headerName) ? headerName.toLowerCase() : "");
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
        if (node.nodeType !== 1 || node.matches(SKIP)) return;
        // A code block's language label goes on its fence, not into the text.
        if (!verbatim && node.nextElementSibling && node.nextElementSibling.matches("pre") && labelOf(node.nextElementSibling) === node) return;
        // A formula (KaTeX) as the TeX it was written in, not its rendered glyphs followed by that TeX.
        const tex = !verbatim && node.matches(".katex, math") && node.querySelector('annotation[encoding="application/x-tex"]');
        if (tex) {
          const display = node.closest(".katex-display") || node.matches('math[display="block"]') || node.querySelector('math[display="block"]');
          if (display) breakTo(2);
          out += display ? `$$${tex.textContent.trim()}$$` : `$${tex.textContent.trim()}$`;
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
    const textOf = (elements) =>
      elements
        .map((el) => render(el))
        .join("\n\n")
        .replace(/\r\n?/g, "\n")
        // A list item's text sits in its own paragraph: back on the marker's line.
        .replace(/(^|\n)(- |\d+\. )\s+(?!- |\d+\. )/g, "$1$2")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"), (_, index) => code[Number(index)]);

    const turns = [];
    let total = 0;
    let found = 0;
    const push = (role, elements) => {
      found += 1;
      const text = textOf(elements.filter(Boolean));
      if (!text || total >= MAX_TOTAL) return;
      const kept = text.slice(0, MAX_TOTAL - total);
      total += kept.length;
      const last = turns[turns.length - 1];
      // One reply split across several nodes is still one turn.
      if (last && last.role === role && role === "assistant") last.text = `${last.text}\n\n${kept}`;
      else turns.push({ role, text: kept });
    };
    // The first selector that matches inside `el` — every match of it, a reply can come in parts.
    const bodyOf = (el, selectors) => {
      for (const selector of selectors) {
        const matches = outermost([...el.querySelectorAll(selector)]);
        if (matches.length > 0) return matches;
      }
      return [el];
    };

    let firstMessage;
    let partial = false;
    if (provider === "chatgpt") {
      // ChatGPT has more than one layout live at once; the first that finds messages is the page's, and only it is read.
      const LAYOUTS = [
        {
          // Seen live 2026-10-15, signed in and signed out at /c/: one element per message, keyed "<turn>:<n>:<role>".
          messages: "[data-content-search-unit-key]",
          roleOf: (el) => (/:(user|assistant)$/.exec(el.getAttribute("data-content-search-unit-key") || "") || [])[1],
        },
        {
          // The role on the message itself: li[data-message-role] (signed out at /uc/, 2026-10-14) and the earlier data-message-author-role.
          messages: "[data-message-author-role], [data-message-role]",
          roleOf: (el) => el.getAttribute("data-message-author-role") || el.getAttribute("data-message-role"),
        },
      ];
      for (const layout of LAYOUTS) {
        for (const el of outermost([...page.querySelectorAll(layout.messages)])) {
          const role = layout.roleOf(el);
          if (role !== "user" && role !== "assistant") continue;
          firstMessage = firstMessage || el;
          push(role, bodyOf(el, ['[data-markdown-copy="contents"]', "[data-assistant-markdown-root]", ".markdown", "[data-user-message-bubble]", ".whitespace-pre-wrap"]));
        }
        if (found > 0) break;
      }
    } else if (provider === "claude") {
      // Seen live signed in 2026-10-16: a reply is [data-testid="assistant-message"], its text in one or more
      // [data-perf-reply-text] blocks between thinking and tool panels. Earlier layouts: .font-claude-response / -message.
      const matches = outermost([...page.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response, .font-claude-message')]);
      for (const el of matches) {
        if (el.matches('[data-testid="user-message"]')) push("user", [el]);
        else push("assistant", bodyOf(el, ["[data-perf-reply-text]", ".standard-markdown, .progressive-markdown"]));
      }
      // A long chat keeps only the rows near the screen mounted; each row knows its place in the whole chat.
      const rows = [...page.querySelectorAll('[data-testid="transcript-row"]')];
      partial = rows.length > 0 && (Math.min(...rows.map((row) => Number(row.getAttribute("data-index")) || 0)) > 0 || Math.min(...rows.map((row) => Number(row.getAttribute("data-perf-row-from-tail")) || 0)) > 0);
    } else if (provider === "gemini") {
      for (const el of outermost([...page.querySelectorAll("user-query, model-response")])) {
        const user = el.tagName.toLowerCase() === "user-query";
        push(user ? "user" : "assistant", [user ? el.querySelector(".query-text") || el : el.querySelector("message-content") || el.querySelector(".markdown") || el]);
      }
    } else {
      const matches = outermost([...page.querySelectorAll('[data-testid="query-text"], [class*="group/query"], [data-message-bubble="right"], .prose')]);
      for (const el of matches) push(el.classList.contains("prose") ? "assistant" : "user", [el]);
      // Signed in (2026-10-16), a thread keeps only the turns near the screen mounted: opened at its end, it
      // starts mid-way, with a reply and no question before it.
      const entries = [...page.querySelectorAll("[data-workflow-entry]")].map((el) => Number(el.getAttribute("data-workflow-entry")) || 0);
      partial = (entries.length > 0 && Math.min(...entries) > 0) || (turns.length > 0 && turns[0].role === "assistant");
    }

    if (turns.length === 0) {
      // Empty only when the conversation area is there and holds nothing but a loading notice. Turns or
      // text Hubble could not read are a layout it no longer understands, never "no messages".
      const thread = provider === "chatgpt" && found === 0 && page.querySelector('[data-thread-find-target="conversation"], [data-conversation-transcript]');
      const notices = thread ? [...thread.querySelectorAll('[role="status"]')].map((status) => status.textContent || "") : [];
      const empty = thread && !thread.querySelector("[data-turn-key], li") && !notices.reduce((text, notice) => text.replace(notice, ""), thread.textContent || "").trim();
      return { ok: false, reason: empty ? "empty-conversation" : "no-messages", provider };
    }
    const title = String(page.title || "").trim().slice(0, 300);
    const read = { ok: true, provider, url: address, title, turns, truncated: total >= MAX_TOTAL };
    // ChatGPT shows only the latest messages of a long chat and says so above them ("Loading older messages…").
    const thread = firstMessage && firstMessage.closest('[data-thread-find-target="conversation"]');
    const pending = thread && [...thread.querySelectorAll('[role="status"]')].some((status) => (status.textContent || "").trim() && status.compareDocumentPosition(firstMessage) & 4);
    if (pending) read.olderNotLoaded = true;
    if (partial) read.partial = true;
    return read;
  }

  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    let read;
    try {
      read = readOnce();
    } catch (err) {
      // Chrome turns a thrown error into no result at all, which the popup could only call "Chrome didn't let
      // Hubble read this page". Said as what it is instead, with the error (never the page's text) for the log.
      return { ok: false, reason: "read-failed", provider, detail: `${(err && err.name) || "Error"}: ${(err && err.message) || ""}`.slice(0, 200) };
    }
    if (read.ok || Date.now() >= deadline) return read;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const PAGE_READ_REASONS = new Set(["not-supported", "no-messages", "empty-conversation", "read-failed"]);

/**
 * What `readConversationFromPage` sent back, re-checked in the extension
 * before it goes anywhere: the page is the AI app's, not ours, so a result
 * that is missing, malformed or carries a reason this file never gives is a
 * failure with a reason, never a save. Resolves to
 * { ok: true, title, turns, olderNotLoaded, partial } or { ok: false, error }.
 */
export function checkPageRead(read) {
  if (!read || typeof read !== "object") return { ok: false, error: "page-unreadable" };
  if (read.ok !== true) return { ok: false, error: PAGE_READ_REASONS.has(read.reason) ? read.reason : "invalid" };
  if (!Array.isArray(read.turns)) return { ok: false, error: "invalid" };
  const turns = [];
  for (const turn of read.turns) {
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.text !== "string") return { ok: false, error: "invalid" };
    if (turn.text.trim()) turns.push({ role: turn.role, text: turn.text });
  }
  if (turns.length === 0) return { ok: false, error: "invalid" };
  return { ok: true, title: typeof read.title === "string" ? read.title : "", turns, olderNotLoaded: read.olderNotLoaded === true, partial: read.partial === true };
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
