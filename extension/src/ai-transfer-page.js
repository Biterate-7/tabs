// Use in AI, inside the AI app's page: one step of a transfer at a time.
//
// background.js (through src/ai-transfer.js) injects `hubbleTransferStep`
// with chrome.scripting.executeScript into the one tab it opened or chose for
// a transfer the person started in Hubble — allowed by the optional host
// permission they granted for that app. It runs each step separately
// (probe → attach → insert → submit) so every step has its own bound, the
// service worker hears back between them, and the person sees each state as
// it really happens.
//
// ## Self-contained on purpose
//
// executeScript serializes the function, so it carries every helper and the
// per-app adapters inside it and references nothing else in this module. It
// takes an optional document and address so tests can run it against saved
// page fixtures (extension/src/ai-transfer-page.test.js).
//
// ## The adapters are data
//
// Each app differs in where its message box is, what kind of editor it is
// (ChatGPT and Claude: ProseMirror; Gemini: Quill; Perplexity: Lexical or a
// textarea), how a file gets in (a file input most apps keep in the page;
// Gemini only takes a paste or a drop), and which button sends. Selectors
// are attributes, ids and roles the apps use for accessibility or testing —
// never generated class names — tried in order, and every step ends by
// LOOKING for its result: text is only "inserted" once it is read back from
// the box, a file only "attached" once its name shows up beside the box, a
// message only "submitted" once the box has emptied. Waits are polls with a
// deadline, never a fixed sleep.
//
// ## What it never does
//
// It never clears or overwrites text it didn't put there, never presses send
// unless the step is "submit" (which the background runs only when the
// person chose Send automatically), never clicks anything else, and never
// reads the page beyond the message box and what is next to it.

/**
 * One step. Resolves to a plain object (never throws: a thrown error would
 * reach the extension as `null`, which it treats as a failure):
 *
 *   probe   { probe, waitMs } → { ok: true, empty, ours } once the message
 *           box is there; { ok: false, reason } for "sign-in-required",
 *           "provider-check", "no-composer", "unsupported"
 *   attach  { files: [{ name, type, data(base64) }], waitMs }
 *           → { ok: true, files: [{ name, attached, reason? }] }
 *   insert  { text, probe, waitMs } → { ok: true } | { ok: false, reason:
 *           "composer-has-draft" | "no-composer" | "not-inserted" }
 *   submit  { probe, waitMs, confirmMs } → { ok: true } | { ok: false, reason:
 *           "not-ours" | "no-send-button" | "send-disabled" | "not-submitted" }
 */
export async function hubbleTransferStep(step, args, doc, href) {
  const page = doc || document;
  const view = page.defaultView || window;
  const address = href || location.href;
  const input = args || {};

  const ADAPTERS = {
    chatgpt: {
      hosts: ["chatgpt.com", "chat.openai.com"],
      composer: ["#prompt-textarea[contenteditable='true']", "div[contenteditable='true'].ProseMirror", "textarea#prompt-textarea", "textarea[name='prompt']", "textarea#mobile-composer-prompt"],
      attach: ["input", "paste", "drop"],
      send: ["button[data-testid='send-button']", "#composer-submit-button", "button[aria-label='Send prompt']", "button[aria-label='Send message']"],
    },
    claude: {
      hosts: ["claude.ai"],
      composer: ["div[contenteditable='true'].ProseMirror", "[data-testid='chat-input'][contenteditable='true']", "[data-testid='chat-input']", "fieldset div[contenteditable='true']"],
      attach: ["input", "paste", "drop"],
      send: ["button[aria-label='Send message']", "button[aria-label='Send Message']", "button[data-testid='send-button']"],
    },
    gemini: {
      hosts: ["gemini.google.com"],
      composer: ["rich-textarea .ql-editor[contenteditable='true']", ".ql-editor[contenteditable='true']", "div[contenteditable='true'][role='textbox']"],
      attach: ["paste", "drop", "input"],
      send: ["button.send-button", "button[aria-label='Send message']", "button[aria-label='Send']"],
    },
    perplexity: {
      hosts: ["www.perplexity.ai", "perplexity.ai"],
      composer: ["#ask-input", "div[contenteditable='true'][role='textbox']", "textarea[placeholder]"],
      attach: ["input", "paste", "drop"],
      send: ["button[aria-label='Submit']", "button[data-testid='submit-button']", "button[aria-label='Send']"],
      // Its editor (Lexical) drops the line breaks inside one typed string and ignores execCommand's own line breaks
      // (seen live 2026-10-19), so lines are typed one at a time with the editor's soft line break between them — the
      // Shift+Enter kind, asked for the way the browser asks (a beforeinput event), which never sends.
      softBreaks: true,
    },
  };

  let host = "";
  let path = "";
  try {
    const parsed = new URL(address);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } catch {
    return { ok: false, reason: "unsupported" };
  }
  const provider = Object.keys(ADAPTERS).find((id) => ADAPTERS[id].hosts.includes(host));
  if (!provider) return { ok: false, reason: "unsupported" };
  const adapter = ADAPTERS[provider];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A bound in ms: the caller's (0 included), else the step's default; never more than two minutes.
  const boundOf = (ms, fallback) => Math.max(0, Math.min(ms === undefined || ms === null || !Number.isFinite(Number(ms)) ? fallback : Number(ms), 120000));
  const deadlineOf = (ms, fallback) => Date.now() + boundOf(ms, fallback);
  // Text compared with every space, line break and zero-width character taken out: a rich editor renders the
  // message's paragraphs as separate blocks, so its textContent has no break between them where the text had two.
  const INVISIBLE = new RegExp("[\\s\\u200b\\u200c\\u200d\\ufeff]+", "g");
  const normalize = (value) => String(value || "").replace(INVISIBLE, "");

  // Hidden things are skipped: a box in an aria-hidden or inert subtree, `hidden`, or display:none.
  const usable = (el) => {
    if (!el || !el.isConnected || el.closest("[aria-hidden='true'], [inert], [hidden]")) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = view.getComputedStyle ? view.getComputedStyle(node) : null;
      if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    }
    return !el.disabled && el.getAttribute("aria-disabled") !== "true";
  };
  const findComposer = () => {
    for (const selector of adapter.composer) {
      const box = [...page.querySelectorAll(selector)].find(usable);
      if (box) return box;
    }
    return undefined;
  };
  const isField = (box) => box.tagName === "TEXTAREA" || box.tagName === "INPUT";
  const textOf = (box) => (isField(box) ? box.value : box.textContent);
  // Where the box's own controls live (attachments, the send button): its form, else a few levels up.
  const regionOf = (box) => {
    const form = box.closest("form, fieldset");
    if (form) return form;
    let node = box;
    for (let level = 0; level < 6 && node.parentElement && node.parentElement !== page.body; level++) node = node.parentElement;
    return node;
  };

  const signInPath = /^\/(?:login|log-in|signin|sign-in|signup|auth)(?:\/|$)/i;
  const blocker = () => {
    const title = String(page.title || "");
    if (/^just a moment/i.test(title) || page.querySelector("#challenge-form, #challenge-running, iframe[src*='challenges.cloudflare.com'], [name='cf-turnstile-response']")) return "provider-check";
    // The app may move to its sign-in page after this step started (a client-side redirect): read the address now.
    if (signInPath.test(href ? path : location.pathname)) return "sign-in-required";
    return undefined;
  };

  try {
    if (step === "probe") {
      const deadline = deadlineOf(input.waitMs, 15000);
      const probe = normalize(input.probe);
      for (;;) {
        const blocked = blocker();
        if (blocked) return { ok: false, reason: blocked };
        const box = findComposer();
        if (box) {
          const current = normalize(textOf(box));
          return { ok: true, empty: current.length === 0, ours: Boolean(probe) && current.includes(probe) };
        }
        if (Date.now() >= deadline) {
          // No message box, and a sign-in form instead: the app wants the person signed in.
          const signIn = page.querySelector("input[type='email'], input[type='password'], input[autocomplete='username']");
          return { ok: false, reason: signIn ? "sign-in-required" : "no-composer" };
        }
        await sleep(250);
      }
    }

    if (step === "insert") {
      const text = String(input.text || "");
      const box = findComposer();
      if (!box) return { ok: false, reason: "no-composer" };
      const probe = normalize(input.probe || text.slice(0, 120)).slice(0, 60);
      const tail = normalize(text.slice(-200)).slice(-60);
      const current = normalize(textOf(box));
      // Never on top of someone's own words.
      if (current && !current.includes(probe)) return { ok: false, reason: "composer-has-draft" };
      const arrived = () => {
        const now = normalize(textOf(box));
        return now.includes(probe) && now.includes(tail);
      };
      // Hubble's own text from an earlier try: whole, it is done; cut short, typing again would double it.
      if (current) return arrived() ? { ok: true, already: true } : { ok: false, reason: "not-inserted" };
      const waitArrived = async () => {
        const deadline = deadlineOf(input.waitMs, 4000);
        for (;;) {
          if (arrived()) return true;
          if (Date.now() >= deadline) return false;
          await sleep(100);
        }
      };
      try {
        box.focus();
      } catch {
        // A box that can't take focus is tried anyway; reading it back decides.
      }
      if (isField(box)) {
        const proto = box.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(box, text);
        else box.value = text;
        box.dispatchEvent(new view.Event("input", { bubbles: true }));
        box.dispatchEvent(new view.Event("change", { bubbles: true }));
        return (await waitArrived()) ? { ok: true } : { ok: false, reason: "not-inserted" };
      }
      // A rich editor: the caret into the (empty) box, then the way typing arrives.
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
        // The editor keeps its own caret.
      }
      let done = false;
      try {
        if (typeof page.execCommand !== "function") done = false;
        else if (adapter.softBreaks) {
          let typed = true;
          text.split("\n").forEach((line, index) => {
            if (index > 0) box.dispatchEvent(new view.InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true }));
            if (line) typed = page.execCommand("insertText", false, line) && typed;
          });
          done = typed && (await waitArrived());
        } else done = page.execCommand("insertText", false, text) && (await waitArrived());
      } catch {
        done = false;
      }
      if (!done && !normalize(textOf(box))) {
        // Editors that ignore execCommand still take a paste — only into a box that is still empty, so nothing doubles.
        try {
          const data = new view.DataTransfer();
          data.setData("text/plain", text);
          box.dispatchEvent(new view.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
          done = await waitArrived();
        } catch {
          done = false;
        }
      }
      return done || arrived() ? { ok: true } : { ok: false, reason: "not-inserted" };
    }

    if (step === "attach") {
      const box = findComposer();
      if (!box) return { ok: false, reason: "no-composer" };
      const files = Array.isArray(input.files) ? input.files : [];
      // How often a name appears in the page's text and labels — before and after, so a name already on the page (an
      // earlier message) never counts as this file arriving.
      const mentions = (name) => {
        const needle = name.toLowerCase();
        const stem = needle.replace(/\.[a-z0-9]{1,8}$/, "").slice(0, 24);
        let count = 0;
        const add = (value) => {
          const hay = String(value || "").toLowerCase();
          for (const term of stem.length >= 6 ? [needle, stem] : [needle]) {
            for (let at = hay.indexOf(term); at !== -1; at = hay.indexOf(term, at + term.length)) count += 1;
          }
        };
        add(page.body ? page.body.textContent : "");
        for (const el of page.querySelectorAll("[title], [aria-label], [alt], [data-filename]")) {
          add(el.getAttribute("title"));
          add(el.getAttribute("aria-label"));
          add(el.getAttribute("alt"));
          add(el.getAttribute("data-filename"));
        }
        return count;
      };
      const fileOf = (entry) => {
        const binary = view.atob(String(entry.data || ""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return new view.File([bytes], String(entry.name), { type: String(entry.type || "application/octet-stream") });
      };
      const accepts = (fileInput, file) => {
        const accept = (fileInput.getAttribute("accept") || "").trim();
        if (!accept) return true;
        const ext = (/\.[a-z0-9]{1,8}$/i.exec(file.name) || [""])[0].toLowerCase();
        return accept.split(",").some((part) => {
          const rule = part.trim().toLowerCase();
          if (!rule) return false;
          if (rule.startsWith(".")) return rule === ext;
          if (rule.endsWith("/*")) return file.type.toLowerCase().startsWith(rule.slice(0, -1));
          return rule === file.type.toLowerCase();
        });
      };
      const fileInputFor = (file) => {
        const region = regionOf(box);
        const all = [...page.querySelectorAll("input[type='file']")].filter((el) => !el.disabled && accepts(el, file));
        // One beside the box first; ChatGPT keeps a separate image-only input, which `accepts` rules out for a PDF.
        return all.find((el) => region.contains(el)) || all[0];
      };
      const methods = {
        input: (file) => {
          const target = fileInputFor(file);
          if (!target) return false;
          const data = new view.DataTransfer();
          data.items.add(file);
          target.files = data.files;
          target.dispatchEvent(new view.Event("input", { bubbles: true }));
          target.dispatchEvent(new view.Event("change", { bubbles: true }));
          return true;
        },
        paste: (file) => {
          const data = new view.DataTransfer();
          data.items.add(file);
          box.focus();
          box.dispatchEvent(new view.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
          return true;
        },
        drop: (file) => {
          const data = new view.DataTransfer();
          data.items.add(file);
          const target = regionOf(box);
          for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new view.DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
          return true;
        },
      };
      const perMethodMs = Math.max(1500, Math.min(Number(input.waitMs) || 8000, 20000));
      // A dialog asking the person to sign in, opened by the app in answer to the file (ChatGPT and Perplexity do,
      // signed out — seen live 2026-10-19). Then nothing more is tried: another try would only stack prompts.
      const DIALOGS = "[role='dialog'], [role='alertdialog'], dialog[open]";
      const dialogsBefore = new Set(page.querySelectorAll(DIALOGS));
      const signInPrompt = () => [...page.querySelectorAll(DIALOGS)].some((el) => !dialogsBefore.has(el) && /\b(sign|log)\s?(in|up)\b/i.test(el.textContent || ""));
      const results = [];
      let gated = false;
      for (const entry of files) {
        let file;
        try {
          file = fileOf(entry);
        } catch {
          results.push({ name: String(entry && entry.name), attached: false, reason: "unreadable" });
          continue;
        }
        if (gated) {
          results.push({ name: file.name, attached: false, reason: "sign-in-to-attach" });
          continue;
        }
        const before = mentions(file.name);
        let attached = false;
        let tried = false;
        for (const method of adapter.attach) {
          let started = false;
          try {
            started = methods[method](file);
          } catch {
            started = false;
          }
          if (!started) continue;
          tried = true;
          const deadline = Date.now() + perMethodMs;
          while (Date.now() < deadline) {
            if (mentions(file.name) > before) {
              attached = true;
              break;
            }
            if (signInPrompt()) {
              gated = true;
              break;
            }
            await sleep(200);
          }
          if (attached || gated) break;
        }
        results.push(attached ? { name: file.name, attached: true } : { name: file.name, attached: false, reason: gated ? "sign-in-to-attach" : tried ? "not-shown" : "no-way-to-attach" });
      }
      return { ok: true, files: results };
    }

    if (step === "submit") {
      const box = findComposer();
      if (!box) return { ok: false, reason: "no-composer" };
      const probe = normalize(input.probe).slice(0, 60);
      // Only a message Hubble put there.
      if (!probe || !normalize(textOf(box)).includes(probe)) return { ok: false, reason: "not-ours" };
      const findSend = () => {
        // The box's own send button: searched outward from the box, so "Send feedback" elsewhere is never pressed.
        for (let scope = box.parentElement; scope; scope = scope.parentElement) {
          for (const selector of adapter.send) {
            const button = [...scope.querySelectorAll(selector)].find((el) => el.isConnected && !el.closest("[aria-hidden='true'], [inert]"));
            if (button) return button;
          }
          if (scope === page.body) break;
        }
        return undefined;
      };
      const ready = (button) => button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
      // Files may still be uploading: the app keeps its send button disabled until they are done.
      const deadline = deadlineOf(input.waitMs, 45000);
      let button = findSend();
      while (!ready(button) && Date.now() < deadline) {
        await sleep(250);
        button = findSend();
      }
      if (!button) return { ok: false, reason: "no-send-button" };
      if (!ready(button)) return { ok: false, reason: "send-disabled" };
      button.click();
      const sentBy = deadlineOf(input.confirmMs, 10000);
      for (;;) {
        const now = findComposer();
        if (!now || !normalize(textOf(now)).includes(probe)) return { ok: true };
        if (Date.now() >= sentBy) return { ok: false, reason: "not-submitted" };
        await sleep(200);
      }
    }

    return { ok: false, reason: "unsupported" };
  } catch (err) {
    return { ok: false, reason: "page-error", detail: `${(err && err.name) || "Error"}: ${(err && err.message) || ""}`.slice(0, 200) };
  }
}
