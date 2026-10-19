// Use in AI, in the extension: one transfer the person started in Hubble —
// chosen context (and uploaded files) into ChatGPT, Claude, Gemini or
// Perplexity, in a new chat.
//
//   Hubble page ─► content script ─► background ─► this runner
//     1. check the request again (the page and content script are transport)
//     2. the app's optional host permission: asked for once, in a small window
//        the person answers (permissions/grant.html)
//     3. a tab: one already on that app's new-chat page, else a new one
//     4. wait for it to load, then step by step in the page
//        (src/ai-transfer-page.js): probe → attach → insert → submit
//     5. the result, said only as far as it was seen to happen
//
// The mirror of the page's protocol is src/lib/ai-transfer/protocol.ts;
// protocol.test.ts there holds both to the same names and limits.
//
// ## Safe to repeat
//
// Every transfer has an `opId`, and its record lives in
// chrome.storage.session (which outlives the service worker going idle, not a
// browser restart). The same id again never types or sends twice: running →
// "already-running"; finished → the same answer, with its tab brought forward;
// failed → tried again, in the same tab when it is still a new chat.
//
// ## Never into the wrong place
//
// Only a tab on the app's new-chat page is reused — never one inside a
// conversation — and only when its message box is empty. A box holding
// someone's draft is left alone: a reused tab gives way to a new one, and a
// new tab that comes up with a draft (ChatGPT restores them) stops the
// transfer with "composer-has-draft".
//
// Pure apart from what `deps` provides, so tests drive it with fakes.

export const MSG_AI_TRANSFER = "HUBBLE_AI_TRANSFER";
export const MSG_AI_TRANSFER_PROGRESS = "HUBBLE_AI_TRANSFER_PROGRESS";
export const MSG_AI_TRANSFER_RESULT = "HUBBLE_AI_TRANSFER_RESULT";
export const MSG_AI_TRANSFER_HELLO = "HUBBLE_AI_TRANSFER_HELLO";
export const MSG_AI_TRANSFER_HELLO_RESULT = "HUBBLE_AI_TRANSFER_HELLO_RESULT";
// The grant page → background: the person answered the permission request.
export const MSG_AI_PERMISSION_ANSWER = "HUBBLE_AI_PERMISSION_ANSWER";
export const AI_TRANSFER_PROTOCOL = 1;

export const AI_TRANSFER_LIMITS = {
  opId: 64,
  text: 200000,
  files: 11,
  fileName: 255,
  fileBytes: 25 * 1024 * 1024,
  totalFileBytes: 32 * 1024 * 1024,
};

export const TRANSFER_TIMING = {
  /** A new tab reaching "complete". */
  tabLoadMs: 30000,
  /** The message box appearing once the page has loaded (apps render it late). */
  composerMs: 15000,
  /** Each attach method's wait for the file to show. */
  attachMs: 8000,
  /** Typed text being read back. */
  insertMs: 5000,
  /** The send button becoming enabled (files still uploading). */
  submitMs: 45000,
  /** The person answering the permission window. */
  permissionMs: 120000,
  /** A "running" record older than this was cut off (the worker stopped). */
  staleMs: 6 * 60 * 1000,
};

export const OPS_KEY = "hubble_ai_transfers";
const OPS_KEPT = 20;

/**
 * Each app as the runner needs it. Hosts and new-chat paths mirror
 * src/lib/providers/registry.ts (protocol.test.ts checks); `origins` are the
 * manifest's optional_host_permissions for it.
 */
export const TRANSFER_PROVIDERS = {
  chatgpt: { name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"], origins: ["https://chatgpt.com/*", "https://chat.openai.com/*"], homeUrl: "https://chatgpt.com/", newChat: [/^\/$/], submit: true },
  claude: { name: "Claude", hosts: ["claude.ai"], origins: ["https://claude.ai/*"], homeUrl: "https://claude.ai/new", newChat: [/^\/new\/?$/], submit: true },
  gemini: { name: "Gemini", hosts: ["gemini.google.com"], origins: ["https://gemini.google.com/*"], homeUrl: "https://gemini.google.com/app", newChat: [/^\/app\/?$/], submit: true },
  perplexity: { name: "Perplexity", hosts: ["www.perplexity.ai", "perplexity.ai"], origins: ["https://www.perplexity.ai/*", "https://perplexity.ai/*"], homeUrl: "https://www.perplexity.ai/", newChat: [/^\/$/], submit: true },
};

// Where an app sends someone to sign in. Hubble never goes further than saying so.
const SIGN_IN_HOSTS = ["accounts.google.com", "auth.openai.com", "auth0.openai.com", "login.microsoftonline.com", "appleid.apple.com"];

const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function base64Bytes(data) {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * The request as the page sent it, checked field by field. Resolves to
 * { ok: true, request } with only the known fields, or { ok: false }.
 */
export function readTransferRequest(payload) {
  if (!payload || typeof payload !== "object") return { ok: false };
  const { opId, provider, mode, text, fallbackText, files } = payload;
  if (typeof opId !== "string" || !OP_ID.test(opId)) return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(TRANSFER_PROVIDERS, provider)) return { ok: false };
  if (mode !== "prepare" && mode !== "send") return { ok: false };
  if (typeof text !== "string" || !text.trim() || text.length > AI_TRANSFER_LIMITS.text) return { ok: false };
  if (fallbackText !== undefined && (typeof fallbackText !== "string" || !fallbackText.trim() || fallbackText.length > AI_TRANSFER_LIMITS.text)) return { ok: false };
  if (!Array.isArray(files) || files.length > AI_TRANSFER_LIMITS.files) return { ok: false };
  let total = 0;
  const checked = [];
  for (const file of files) {
    if (!file || typeof file.name !== "string" || !file.name || file.name.length > AI_TRANSFER_LIMITS.fileName) return { ok: false };
    if (typeof file.type !== "string" || file.type.length > 200) return { ok: false };
    if (typeof file.data !== "string" || !BASE64.test(file.data)) return { ok: false };
    const size = base64Bytes(file.data);
    if (size !== file.size || size > AI_TRANSFER_LIMITS.fileBytes) return { ok: false };
    total += size;
    checked.push({ name: file.name, type: file.type, size, data: file.data });
  }
  if (total > AI_TRANSFER_LIMITS.totalFileBytes) return { ok: false };
  return { ok: true, request: { opId, provider, mode, text, ...(fallbackText !== undefined ? { fallbackText } : {}), files: checked } };
}

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Whether `url` is the app's own new-chat page (https, its exact host, a new-chat path). */
export function isNewChatTab(provider, url) {
  const config = TRANSFER_PROVIDERS[provider];
  const parsed = parse(url || "");
  if (!config || !parsed || parsed.protocol !== "https:" || !config.hosts.includes(parsed.hostname.toLowerCase())) return false;
  return config.newChat.some((pattern) => pattern.test(parsed.pathname));
}

/** The words that identify Hubble's text in the box: its start, whitespace-folded. */
export function probeOf(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** chrome.tabs.query match patterns for an app's pages. */
function patternsOf(provider) {
  return TRANSFER_PROVIDERS[provider].hosts.map((host) => `https://${host}/*`);
}

/**
 * The runner. `deps`:
 *   tabs.{query, get, create, update}, windows.update
 *   hasPermission(origins) → boolean
 *   requestPermission(provider, origins, opId) → "granted" | "denied" | "timeout"
 *   waitForTab(tabId, ms) → "complete" | "removed" | "timeout"
 *   step(tabId, name, args) → the page step's answer, or throws
 *   store.get(key) / store.set(key, value)   (chrome.storage.session)
 *   now(), log(stage, fields), keepAlive() → stop function
 */
export function createTransferRunner(deps) {
  const running = new Set();

  async function readOps() {
    try {
      const stored = await deps.store.get(OPS_KEY);
      const ops = stored && typeof stored === "object" ? stored : {};
      return ops;
    } catch {
      return {};
    }
  }

  async function writeOp(opId, record) {
    try {
      const ops = await readOps();
      ops[opId] = { ...ops[opId], ...record, at: deps.now() };
      const kept = Object.entries(ops)
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
        .slice(0, OPS_KEPT);
      await deps.store.set(OPS_KEY, Object.fromEntries(kept));
    } catch {
      // Not remembered: a repeat then runs again, and its own checks (an empty box, a probe of Hubble's own text) still stop it doubling.
    }
  }

  async function activate(tab) {
    try {
      await deps.tabs.update(tab.id, { active: true });
      if (Number.isInteger(tab.windowId)) await deps.windows.update(tab.windowId, { focused: true });
    } catch {
      // Bringing it forward is a courtesy; the transfer's result doesn't depend on it.
    }
  }

  async function liveTab(tabId) {
    if (!Number.isInteger(tabId)) return undefined;
    try {
      return await deps.tabs.get(tabId);
    } catch {
      return undefined;
    }
  }

  /** A tab already on the app's new-chat page: the Hubble tab's window first, then the one used most recently. */
  async function findReusable(provider, senderTab, exclude) {
    let tabs = [];
    try {
      tabs = await deps.tabs.query({ url: patternsOf(provider) });
    } catch {
      tabs = [];
    }
    const candidates = tabs.filter((tab) => Number.isInteger(tab.id) && !exclude.has(tab.id) && !tab.incognito && !tab.discarded && isNewChatTab(provider, tab.url));
    candidates.sort((a, b) => Number(b.windowId === senderTab?.windowId) - Number(a.windowId === senderTab?.windowId) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return candidates[0];
  }

  async function openTab(provider, senderTab) {
    const where = Number.isInteger(senderTab?.windowId) ? { windowId: senderTab.windowId, ...(Number.isInteger(senderTab.index) ? { index: senderTab.index + 1 } : {}) } : {};
    return deps.tabs.create({ url: TRANSFER_PROVIDERS[provider].homeUrl, active: true, ...where });
  }

  /** Runs one page step; a thrown injection becomes a reason, never a success. */
  async function step(tabId, name, args) {
    try {
      const answer = await deps.step(tabId, name, args);
      return answer && typeof answer === "object" ? answer : { ok: false, reason: "page-error" };
    } catch (err) {
      const message = String((err && err.message) || "");
      if (/no tab with id|tab was closed|tab.*removed/i.test(message)) return { ok: false, reason: "tab-closed" };
      if (/cannot access|permission|manifest must request/i.test(message)) return { ok: false, reason: "permission-denied" };
      return { ok: false, reason: "page-error", detail: message.slice(0, 200) };
    }
  }

  /** The tab once loaded, or the reason it can't be used. */
  async function loaded(provider, tab) {
    const waited = tab.status === "complete" ? "complete" : await deps.waitForTab(tab.id, TRANSFER_TIMING.tabLoadMs);
    if (waited === "removed") return { error: "tab-closed" };
    const now = await liveTab(tab.id);
    if (!now) return { error: "tab-closed" };
    if (waited === "timeout" && now.status !== "complete") return { error: "provider-not-loaded" };
    const parsed = parse(now.url || now.pendingUrl || "");
    const host = parsed ? parsed.hostname.toLowerCase() : "";
    if (!TRANSFER_PROVIDERS[provider].hosts.includes(host)) return { error: SIGN_IN_HOSTS.includes(host) ? "sign-in-required" : "unexpected-page" };
    // The app sent the new chat somewhere else: its sign-in page (the page step tells), or a conversation — never typed into.
    if (!isNewChatTab(provider, now.url)) {
      const path = parsed.pathname;
      if (/^\/(?:login|log-in|signin|sign-in|signup|auth)(?:\/|$)/i.test(path)) return { error: "sign-in-required" };
      return { error: "unexpected-page" };
    }
    return { tab: now };
  }

  async function run(request, { senderTab, report }) {
    const { opId, provider, mode } = request;
    const config = TRANSFER_PROVIDERS[provider];
    const fail = (error, extra = {}) => ({ opId, ok: false, error, ...extra });
    const say = (state) => {
      try {
        report(state);
      } catch {
        // The Hubble tab went away; the transfer carries on and its record keeps the answer.
      }
    };

    if (running.has(opId)) return fail("already-running");
    const previous = (await readOps())[opId];
    if (previous?.status === "running" && deps.now() - (previous.at || 0) < TRANSFER_TIMING.staleMs) return fail("already-running");
    if (previous?.status === "done" && previous.result) {
      // Already typed (and maybe sent): the same answer, never a second message.
      const tab = await liveTab(previous.tabId);
      if (tab) await activate(tab);
      return previous.result;
    }

    running.add(opId);
    const stopKeepAlive = deps.keepAlive();
    await writeOp(opId, { status: "running", provider });
    let tabId;
    const finish = async (result) => {
      await writeOp(opId, { status: result.ok ? "done" : "failed", provider, tabId, ...(result.ok ? { result } : {}) });
      deps.log("ai-transfer-finished", { provider, ok: result.ok, state: result.ok ? result.state : result.error, files: request.files.length });
      return result;
    };

    try {
      if (!(await deps.hasPermission(config.origins))) {
        say("waiting-for-permission");
        const answer = await deps.requestPermission(provider, config.origins, opId);
        if (answer !== "granted") return await finish(fail(answer === "timeout" ? "permission-timeout" : "permission-denied"));
      }

      say("opening-provider");
      const tried = new Set();
      let reusedTab = false;
      // A failed try's tab, when it is still a new chat; else one already open; else a new one.
      let tab = previous?.tabId !== undefined ? await liveTab(previous.tabId) : undefined;
      if (tab && !isNewChatTab(provider, tab.url)) tab = undefined;
      if (!tab) {
        tab = await findReusable(provider, senderTab, tried);
        reusedTab = Boolean(tab);
      }
      if (tab) await activate(tab);
      else tab = await openTab(provider, senderTab);

      let probe;
      for (;;) {
        tried.add(tab.id);
        tabId = tab.id;
        await writeOp(opId, { status: "running", provider, tabId });
        say("waiting-for-provider");
        const ready = await loaded(provider, tab);
        if (ready.error) return await finish(fail(ready.error));
        tab = ready.tab;
        probe = await step(tab.id, "probe", { probe: probeOf(request.text), waitMs: TRANSFER_TIMING.composerMs });
        if (!probe.ok && (probe.reason === "page-error" || probe.reason === "no-composer" || probe.reason === "unsupported")) {
          // The app may have moved on after loading — to its sign-in page (Claude does, signed out), which ends the
          // step it was running. Where the tab is now says why; a new chat that merely reloaded is looked at once more.
          const moved = await loaded(provider, tab);
          if (moved.error) return await finish(fail(moved.error));
          if (probe.reason === "page-error") probe = await step(tab.id, "probe", { probe: probeOf(request.text), waitMs: TRANSFER_TIMING.composerMs });
        }
        if (!probe.ok) return await finish(fail(probe.reason === "unsupported" || probe.reason === "page-error" ? "no-composer" : probe.reason));
        if (probe.empty || probe.ours) break;
        // Someone's draft. A tab Hubble only borrowed gives way to a new one; a new tab with a draft stops here.
        if (!reusedTab) return await finish(fail("composer-has-draft"));
        reusedTab = false;
        tab = await openTab(provider, senderTab);
      }

      const attached = [];
      const notAttached = [];
      let usedFallback = false;
      let text = request.text;
      if (probe.ours) {
        // An earlier try already typed this message: nothing is typed or attached again. The insert step only checks
        // it is whole (it never types into a box that isn't empty) — the message, or the all-text one a failed attach left.
        deps.log("ai-transfer-already-inserted", { provider });
        let check = await step(tab.id, "insert", { text, probe: probeOf(text), waitMs: 0 });
        if (!check.ok && request.fallbackText) {
          const alternative = await step(tab.id, "insert", { text: request.fallbackText, probe: probeOf(request.fallbackText), waitMs: 0 });
          if (alternative.ok) {
            check = alternative;
            text = request.fallbackText;
            usedFallback = true;
          }
        }
        if (!check.ok) return await finish(fail(["tab-closed", "permission-denied", "no-composer"].includes(check.reason) ? check.reason : "not-inserted"));
      } else {
        if (request.files.length > 0) {
          say("attaching");
          const answer = await step(tab.id, "attach", { files: request.files, waitMs: TRANSFER_TIMING.attachMs });
          const results = answer.ok && Array.isArray(answer.files) ? answer.files : [];
          for (const file of request.files) {
            const result = results.find((entry) => entry && entry.name === file.name);
            if (result?.attached === true) attached.push(file.name);
            else
              notAttached.push({
                name: file.name,
                reason:
                  result?.reason === "sign-in-to-attach"
                    ? `${config.name} asked you to sign in to attach files`
                    : result?.reason === "no-way-to-attach"
                      ? `${config.name} offered no way to attach it here`
                      : `${config.name} didn't show it as attached`,
              });
          }
          if (notAttached.length > 0) {
            if (!request.fallbackText) return await finish(fail("attach-failed", { notAttached }));
            text = request.fallbackText;
            usedFallback = true;
          }
        }
        say("inserting");
        const inserted = await step(tab.id, "insert", { text, probe: probeOf(text), waitMs: TRANSFER_TIMING.insertMs });
        if (!inserted.ok) {
          const reason = ["composer-has-draft", "no-composer", "tab-closed", "permission-denied"].includes(inserted.reason) ? inserted.reason : "not-inserted";
          return await finish(fail(reason, notAttached.length > 0 ? { notAttached } : {}));
        }
      }

      const base = { opId, ok: true, attached, notAttached, usedFallback, reusedTab };
      // Sent only when the person chose it for this transfer, and only Hubble's own message.
      if (mode === "send" && config.submit) {
        say("submitting");
        const sent = await step(tab.id, "submit", { probe: probeOf(text), waitMs: TRANSFER_TIMING.submitMs });
        if (sent.ok) return await finish({ ...base, state: "submitted" });
        const why = {
          "no-send-button": `Hubble couldn't find ${config.name}'s send button`,
          "send-disabled": `${config.name}'s send button stayed off (a file may still be uploading)`,
          "not-submitted": `${config.name} didn't take the message after send was pressed`,
          "not-ours": "the message box no longer held Hubble's message",
        }[sent.reason] || `${config.name} couldn't be sent to automatically`;
        return await finish({ ...base, state: "ready-for-review", submitProblem: why });
      }
      return await finish({ ...base, state: "ready-for-review" });
    } catch (err) {
      deps.log("ai-transfer-error", { provider, detail: String((err && err.message) || err).slice(0, 200) });
      return await finish(fail("failed"));
    } finally {
      running.delete(opId);
      stopKeepAlive();
    }
  }

  return { run };
}
