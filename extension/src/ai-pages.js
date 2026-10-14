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
// AI apps change their markup without notice. The readers look for the
// message elements each app uses (verified against fixtures, not the live
// apps), and fail with a reason rather than guess: a page with no readable
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
 * Resolves to { ok: true, provider, url, title, turns: [{ role, text }] }
 * or { ok: false, reason: "not-supported" | "no-messages" }.
 */
export function readConversationFromPage(doc, href) {
  const page = doc || document;
  const address = href || location.href;
  const MAX_TOTAL = 2000000;
  let host = "";
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "not-supported" };
  }
  // Text only screen readers get (Gemini repeats the whole question as "You said …") is not what anyone said.
  const HIDDEN_LABELS = '.cdk-visually-hidden, .sr-only, .visually-hidden, [class*="screen-reader"]';
  const textOf = (el) => {
    if (!el) return "";
    let raw = typeof el.innerText === "string" && el.innerText.length > 0 ? el.innerText : el.textContent || "";
    for (const hidden of el.querySelectorAll(HIDDEN_LABELS)) {
      const label = (hidden.innerText || hidden.textContent || "").trim();
      if (label) raw = raw.replace(label, "");
    }
    return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  };
  // Elements in document order, without any that sit inside another match (a wrapper and its inner node are one message).
  const outermost = (elements) => elements.filter((el) => !elements.some((other) => other !== el && other.contains(el)));
  const turns = [];
  let total = 0;
  const push = (role, el) => {
    const text = textOf(el);
    if (!text || total >= MAX_TOTAL) return;
    const kept = text.slice(0, MAX_TOTAL - total);
    total += kept.length;
    const last = turns[turns.length - 1];
    // One reply split across several nodes is still one turn.
    if (last && last.role === role && role === "assistant") last.text = `${last.text}\n\n${kept}`;
    else turns.push({ role, text: kept });
  };

  let provider;
  if (host === "chatgpt.com" || host === "chat.openai.com") {
    provider = "chatgpt";
    for (const el of outermost([...page.querySelectorAll("[data-message-author-role], [data-message-role]")])) {
      const role = el.getAttribute("data-message-author-role") || el.getAttribute("data-message-role");
      if (role !== "user" && role !== "assistant") continue;
      push(
        role,
        el.querySelector("[data-assistant-markdown-root]") || el.querySelector(".markdown") || el.querySelector("[data-user-message-bubble]") || el.querySelector(".whitespace-pre-wrap") || el
      );
    }
  } else if (host === "claude.ai") {
    provider = "claude";
    const matches = outermost([...page.querySelectorAll('[data-testid="user-message"], .font-claude-response, .font-claude-message')]);
    for (const el of matches) push(el.matches('[data-testid="user-message"]') ? "user" : "assistant", el);
  } else if (host === "gemini.google.com") {
    provider = "gemini";
    for (const el of outermost([...page.querySelectorAll("user-query, model-response")])) {
      const user = el.tagName.toLowerCase() === "user-query";
      push(user ? "user" : "assistant", user ? el.querySelector(".query-text") || el : el.querySelector("message-content") || el.querySelector(".markdown") || el);
    }
  } else if (host === "www.perplexity.ai" || host === "perplexity.ai") {
    provider = "perplexity";
    const matches = outermost([...page.querySelectorAll('[data-testid="query-text"], [class*="group/query"], [data-message-bubble="right"], .prose')]);
    for (const el of matches) push(el.classList.contains("prose") ? "assistant" : "user", el);
  } else {
    return { ok: false, reason: "not-supported" };
  }

  if (turns.length === 0) return { ok: false, reason: "no-messages", provider };
  const title = String(page.title || "").trim().slice(0, 300);
  return { ok: true, provider, url: address, title, turns, truncated: total >= MAX_TOTAL };
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
