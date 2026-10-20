import { MSG_CAPTURE_CONVERSATION, MSG_DESKTOP_STATUS, MSG_INSERT_CONTEXT, MSG_MEMORY_REQUEST, TARGET_PROJECT_KEY } from "../src/config.js";
import { AI_PROVIDER_NAMES, aiProviderOf, conversationIdentityOf } from "../src/ai-pages.js";
import { readStoredTarget } from "../src/quick-add.js";

/**
 * The popup's AI-app section: on ChatGPT, Claude, Gemini or Perplexity,
 *
 *   Save this conversation   reads the conversation on screen (only now,
 *                            only this tab) into Hubble Desktop when it is
 *                            open — the person picks the project there —
 *                            or else into the project chosen here
 *   Use your knowledge here  searches that project, builds context from the
 *                            items ticked, and inserts it into the message
 *                            box — or copies it, and says which happened
 *
 * Everything that changes data happens in the Hubble page; this only asks
 * and reports. Every failure is said in words, with the fallback that works.
 *
 * ## Always this tab's conversation
 *
 * What the panel shows — saved or not, saving, failed — belongs to the one
 * conversation the tab is on (its provider and id: conversationIdentityOf),
 * never to its app. When the tab moves to another conversation while the
 * popup is open, the panel starts over for that one; a save still running
 * for the last one never disables saving this one, and its answer is not
 * shown against the wrong chat.
 */

/** What to say for each reason a save can fail. */
export const CAPTURE_ERRORS = {
  "not-supported": "Hubble can save conversations from ChatGPT, Claude, Gemini and Perplexity.",
  "not-a-conversation": "Open a conversation to save it — this page isn't one.",
  "no-messages": "Hubble couldn't find the messages on this page (the app may have changed its layout). Reload the page and try again. If it still doesn't work, import the app's export file in Hubble: Add → Import AI chats.",
  "empty-conversation": "There are no messages in this conversation yet. If it's still loading, wait a moment and try again.",
  empty: "Hubble couldn't find the messages on this page. Reload the page and try again. If it still doesn't work, import the app's export file in Hubble: Add → Import AI chats.",
  "page-unreadable": "Chrome didn't let Hubble read this page. Reload it and try again.",
  "read-failed": "Hubble couldn't read this conversation's layout. Reload the page and try again. If it still doesn't work, import the app's export file in Hubble: Add → Import AI chats.",
  "project-missing": "That project isn't in Hubble any more. Choose another one.",
  "storage-failed": "Hubble couldn't keep the conversation on this device, so nothing was saved. Try again.",
  invalid: "That didn't come through as a conversation. Reload the page and try again.",
  "tab-gone": "That tab was closed.",
  "tab-changed": "This tab moved to another conversation, so nothing was saved. Save again to keep the one on screen now.",
  "already-saving": "Still saving this conversation. Wait a moment, then look again.",
  "hubble-unreachable": "Hubble couldn't be opened. Check your connection and try again.",
  "no-response": "Hubble didn't answer. Open Hubble, then try again.",
  timeout: "Hubble didn't answer in time. Open Hubble, then try again.",
  "not-ready": "Hubble is still loading. Try again in a moment.",
  failed: "Something went wrong. Try again.",
  // Saving to Hubble Desktop (background.js → src/desktop-add.js).
  "no-project": "Hubble Desktop isn't open any more. Choose a project to save to Hubble on the web.",
  "desktop-cancelled": "Nothing saved — cancelled in Hubble Desktop.",
  "desktop-expired": "Nothing saved — no project was chosen in Hubble Desktop in time.",
  "desktop-failed": "Hubble Desktop couldn't keep the conversation, so nothing was saved. Try again.",
  "desktop-busy": "Hubble Desktop is busy. Finish what's open there, then try again.",
  "already-running": "Still saving the last conversation. Choose a project in Hubble Desktop first.",
  "invalid-payload": "Hubble Desktop couldn't take this conversation. Reload the page and try again.",
  "desktop-not-responding": "Hubble Desktop isn't responding. Try again, or close it to save to Hubble on the web.",
  "desktop-session-lost": "Hubble Desktop isn't responding. Try again, or close it to save to Hubble on the web.",
};

export function captureError(reason) {
  return CAPTURE_ERRORS[reason] ?? CAPTURE_ERRORS.failed;
}

/**
 * Where this conversation is already saved, in words — or "" when it is in no
 * project, or that is unknown (no Hubble tab to ask). `places` are the page's
 * answer to "saved" (findSavedConversation), re-checked by readSavedPlaces.
 */
export function describeSavedState(places) {
  if (!Array.isArray(places) || places.length === 0) return "";
  const names = places.map((place) => place.projectName || "a project");
  const where = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} other projects`;
  const title = places[0].title ? ` as “${places[0].title}”` : "";
  if (places.every((place) => !place.hasText)) return `In ${where}${title} as a link only. Save it to keep the conversation itself.`;
  return `Already saved in ${where}${title}. Saving again updates that copy.`;
}

/** Saved places as the page listed them, re-checked: a project, the item's title, and whether its text is kept. */
export function readSavedPlaces(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((place) => place && typeof place.workspaceId === "string" && place.workspaceId && typeof place.tabId === "string")
    .slice(0, 20)
    .map((place) => ({
      workspaceId: place.workspaceId,
      tabId: place.tabId,
      projectName: typeof place.projectName === "string" ? place.projectName.slice(0, 120) : "",
      title: typeof place.title === "string" ? place.title.slice(0, 120) : "",
      hasText: place.hasText === true,
    }));
}

/** The tab's title when it names this conversation ("Causes of WW1"), not just the app ("ChatGPT", "New chat"). */
export function conversationTitleOf(tab, name) {
  const title = typeof tab?.title === "string" ? tab.title.trim() : "";
  const lower = title.toLowerCase();
  const app = name.toLowerCase();
  let topic = title;
  for (const sep of [" - ", " – ", " | "]) {
    if (lower.endsWith(`${sep}${app}`)) topic = title.slice(0, title.length - sep.length - app.length);
    if (lower.startsWith(`${app}${sep}`)) topic = title.slice(app.length + sep.length);
  }
  topic = topic.trim();
  return topic && topic.toLowerCase() !== app && !/^new chat$/i.test(topic) && !lower.startsWith(`${app}:`) ? topic.slice(0, 80) : "";
}

/** "Saved to History IA · 14 turns" — what a save did, in words. */
export function describeCapture(result, projectName) {
  const turns = Number.isInteger(result?.turns) ? ` · ${result.turns} turn${result.turns === 1 ? "" : "s"}` : "";
  const cut = result?.truncated ? " · very long, so only the first part was kept" : "";
  // A long Claude or Perplexity chat keeps only the messages near the screen on the page, wherever it is scrolled.
  const older = result?.partial
    ? ". Only the part of this chat loaded on the page was saved — long chats load a few messages at a time. To keep all of it, import the app's data export in Hubble: Add → Import AI chats."
    : result?.olderNotLoaded
      ? ". Older messages hadn't loaded yet — scroll to the top of the chat and save again to include them."
      : "";
  if (result?.outcome === "updated") return `Updated the saved copy in ${projectName}${turns}${cut}${older}`;
  if (result?.outcome === "unchanged") return `Already saved in ${projectName} — nothing new since${older || "."}`;
  if (result?.outcome === "kept")
    return `${projectName} already has more of this conversation than the page shows, so the saved copy was kept.${result?.partial ? "" : " Scroll to the top to load the whole conversation, then save again."}`;
  return `Saved to ${projectName}${turns}${cut}${older}`;
}

const TYPE_WORDS = { conversation: "AI conversation", webpage: "Web page", pdf: "PDF", video: "Video", document: "Document", link: "Link", note: "Note", excerpt: "Excerpt" };

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload }).catch(() => ({ ok: false, error: "no-response" }));
}

/** Whether Save goes to Hubble Desktop: it is open, and new enough to take a conversation. */
async function desktopTakesConversations() {
  try {
    const status = await chrome.runtime.sendMessage({ type: MSG_DESKTOP_STATUS });
    return status?.available === true && status.conversations === true;
  } catch {
    return false;
  }
}

function memory(kind, args, openIfMissing = false) {
  return send(MSG_MEMORY_REQUEST, { kind, args, openIfMissing });
}

async function rememberedProject() {
  try {
    const stored = await chrome.storage?.local?.get(TARGET_PROJECT_KEY);
    return readStoredTarget(stored?.[TARGET_PROJECT_KEY]);
  } catch {
    return undefined;
  }
}

function rememberProject(project) {
  try {
    void chrome.storage?.local?.set({ [TARGET_PROJECT_KEY]: { id: project.id, name: project.name } });
  } catch {
    // Not remembered; chosen again next time.
  }
}

/** Projects as the page listed them, re-checked. */
export function readPanelProjects(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((project) => project && typeof project.id === "string" && project.id && typeof project.name === "string")
    .slice(0, 100)
    .map((project) => ({ id: project.id, name: project.name.slice(0, 120) || "Untitled project" }));
}

/** Search hits as the page listed them, re-checked: only a well-formed ref and a title are kept. */
export function readHits(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((hit) => {
    const ref = hit?.ref;
    const okRef = ref && ((ref.kind === "source" && typeof ref.tabId === "string") || (ref.kind === "note" && typeof ref.noteId === "string"));
    if (!okRef || typeof hit.title !== "string" || typeof hit.workspaceId !== "string") return [];
    return [
      {
        workspaceId: hit.workspaceId,
        ref: ref.kind === "source" ? { kind: "source", tabId: ref.tabId } : { kind: "note", noteId: ref.noteId },
        title: hit.title.slice(0, 200),
        type: typeof hit.type === "string" ? hit.type : "link",
        provider: typeof hit.provider === "string" ? hit.provider : undefined,
        snippet: typeof hit.snippet === "string" ? hit.snippet.slice(0, 240) : "",
        hasText: hit.hasText === true,
      },
    ];
  });
}

export function refKey(ref) {
  return ref.kind === "note" ? `n:${ref.noteId}` : `s:${ref.tabId}`;
}

export async function initAiPanel(activeTab, doc = document) {
  const el = (id) => doc.getElementById(id);
  const section = el("ai-section");
  if (!section || !activeTab?.url) return false;
  if (!aiProviderOf(activeTab.url)) return false;

  // The tab, and the conversation it is on now — replaced whenever the tab moves (`follow` below).
  let tab = activeTab;
  let provider = aiProviderOf(tab.url);
  let name = AI_PROVIDER_NAMES[provider];
  let identity = conversationIdentityOf(tab.url);
  let conversation = identity !== undefined;
  // The conversations this popup is saving right now, by identity: only the one on screen disables Save.
  const saving = new Set();
  const savingThis = () => Boolean(identity && saving.has(identity.key));
  const savedState = el("ai-saved");
  const select = el("ai-project-select");
  const captureButton = el("capture-button");
  const openButton = el("ai-open-hubble-button");
  const captureStatus = el("capture-status");
  const query = el("memory-query");
  const results = el("memory-results");
  const request = el("memory-request");
  const insertButton = el("insert-button");
  const copyButton = el("copy-button");
  const memoryStatus = el("memory-status");
  const chosen = new Set();
  let hits = [];
  let busy = false;
  // Hubble Desktop is open: Save goes there and the project is chosen there.
  // The project here then only scopes "Use your knowledge here", which stays
  // with Hubble on the web — the desktop bridge only takes things in.
  let toDesktop = false;
  // Hubble Desktop answered that it takes conversations; Save goes there whenever the tab is on one.
  let desktopOpen = false;

  section.hidden = false;
  const showPage = () => {
    el("ai-page").textContent = conversation ? `${name} · ${conversationTitleOf(tab, name) || "this conversation"}` : `${name} · open a conversation to save it`;
  };
  showPage();

  const say = (target, text) => {
    target.textContent = text;
    target.hidden = !text;
  };
  const projectId = () => select.value;
  const projectName = () => select.selectedOptions?.[0]?.textContent ?? "your project";

  function updateButtons() {
    captureButton.disabled = savingThis() || !conversation || (!toDesktop && !projectId());
    insertButton.disabled = busy || chosen.size === 0 || !projectId();
    copyButton.disabled = busy || chosen.size === 0 || !projectId();
  }

  function fillProjects(projects, preferredId) {
    select.innerHTML = "";
    const placeholder = doc.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a project…";
    select.appendChild(placeholder);
    for (const project of projects) {
      const option = doc.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      select.appendChild(option);
    }
    select.value = projects.some((project) => project.id === preferredId) ? preferredId : projects.length === 1 ? projects[0].id : "";
    updateButtons();
  }

  function showDesktopTarget() {
    captureButton.textContent = toDesktop ? "Save to Hubble Desktop" : "Save this conversation";
    if (toDesktop) say(captureStatus, conversation ? "Hubble Desktop is open. You'll choose the project there." : "");
  }

  async function loadProjects(openIfMissing) {
    const remembered = await rememberedProject();
    const answer = await memory("projects", {}, openIfMissing);
    if (answer?.ok) {
      const projects = readPanelProjects(answer.result?.projects);
      openButton.hidden = true;
      fillProjects(projects, remembered?.id ?? answer.result?.currentId);
      if (projects.length === 0 && !toDesktop) say(captureStatus, "Make a project in Hubble first.");
      return true;
    }
    // No Hubble open: the project last used still works — Hubble opens when the conversation is saved.
    fillProjects(remembered ? [{ id: remembered.id, name: remembered.name || "Your project" }] : [], remembered?.id);
    // Saving to Hubble Desktop needs no Hubble tab; only searching does.
    openButton.hidden = toDesktop;
    if (!toDesktop) say(captureStatus, remembered ? "Hubble isn't open; it will open to save the conversation." : "Open Hubble to choose a project.");
    return false;
  }

  function renderHits() {
    results.innerHTML = "";
    for (const hit of hits) {
      const key = refKey(hit.ref);
      const li = doc.createElement("li");
      li.className = "popup__result";
      const box = doc.createElement("input");
      box.type = "checkbox";
      box.checked = chosen.has(key);
      box.setAttribute("aria-label", `Use ${hit.title}`);
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(key);
        else chosen.delete(key);
        updateButtons();
      });
      const text = doc.createElement("span");
      const title = doc.createElement("span");
      title.textContent = hit.title;
      const meta = doc.createElement("span");
      meta.className = "popup__result-meta";
      meta.textContent = [AI_PROVIDER_NAMES[hit.provider], TYPE_WORDS[hit.type] ?? "Item", hit.hasText ? "" : "link only"].filter(Boolean).join(" · ");
      text.append(title, meta);
      li.append(box, text);
      li.addEventListener("click", (event) => {
        if (event.target !== box) box.click();
      });
      results.appendChild(li);
    }
  }

  let searchToken = 0;
  async function search() {
    const token = ++searchToken;
    if (!projectId()) {
      hits = [];
      renderHits();
      return;
    }
    const answer = await memory("search", { query: query.value.slice(0, 500), workspaceId: projectId() });
    if (token !== searchToken) return;
    if (!answer?.ok) {
      hits = [];
      renderHits();
      say(memoryStatus, answer?.error === "no-hubble-tab" ? "Open Hubble to search your projects." : captureError(answer?.error));
      return;
    }
    // Ticked items stay ticked while the search changes.
    const fresh = readHits(answer.result?.hits);
    const kept = hits.filter((hit) => chosen.has(refKey(hit.ref)) && !fresh.some((other) => refKey(other.ref) === refKey(hit.ref)));
    hits = [...kept, ...fresh];
    renderHits();
    say(memoryStatus, hits.length === 0 ? (query.value.trim() ? "Nothing in this project mentions that." : "Nothing saved in this project yet.") : "");
  }

  async function bundleText() {
    const refs = hits.filter((hit) => chosen.has(refKey(hit.ref))).map((hit) => hit.ref);
    const answer = await memory("bundle", { workspaceId: projectId(), refs, ...(request.value.trim() ? { request: request.value.slice(0, 2000) } : {}) });
    if (!answer?.ok || typeof answer.result?.text !== "string") return { error: answer?.error ?? "failed" };
    return { text: answer.result.text, items: refs.length };
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function use(mode) {
    if (busy) return;
    busy = true;
    updateButtons();
    say(memoryStatus, "Preparing…");
    try {
      const built = await bundleText();
      if (built.error) {
        say(memoryStatus, captureError(built.error));
        return;
      }
      if (mode === "insert") {
        const placed = await send(MSG_INSERT_CONTEXT, { tabId: tab.id, text: built.text });
        if (placed?.inserted) {
          say(memoryStatus, `Inserted into ${name}'s message box. Review it, then send it yourself.`);
          void memory("reused", { workspaceId: projectId(), items: built.items, provider, how: "inserted" });
          return;
        }
        // Not placed: copy instead, and say exactly that.
        if (await copy(built.text)) {
          say(memoryStatus, `Couldn't place it in ${name}'s message box, so it's copied instead — paste it there.`);
          void memory("reused", { workspaceId: projectId(), items: built.items, provider, how: "copied" });
        } else {
          say(memoryStatus, `Couldn't place it in the message box or copy it. In Hubble, use "Use in AI chat" to copy it from there.`);
        }
        return;
      }
      if (await copy(built.text)) {
        say(memoryStatus, `Copied. Paste it into ${name}'s message box.`);
        void memory("reused", { workspaceId: projectId(), items: built.items, provider, how: "copied" });
      } else {
        say(memoryStatus, `Chrome didn't allow copying. In Hubble, use "Use in AI chat" to copy it from there.`);
      }
    } finally {
      busy = false;
      updateButtons();
    }
  }

  // Where this conversation is already saved, asked of the Hubble page only when a Hubble tab is open (never opened
  // for this), and only ever about this conversation. An answer for one no longer on screen is dropped. Not asked
  // while Save goes to Hubble Desktop: the web page knows only its own projects, and Hubble Desktop's bridge
  // answers no questions (it only takes things in), so nothing is claimed about where Save is going.
  let lookupToken = 0;
  async function lookUpSaved() {
    const token = ++lookupToken;
    if (!savedState) return;
    say(savedState, "");
    if (!identity || toDesktop) return;
    const answer = await memory("saved", { url: tab.url });
    if (token !== lookupToken || !answer?.ok || answer.result?.conversation !== true) return;
    say(savedState, describeSavedState(readSavedPlaces(answer.result.saved)));
  }

  captureButton.addEventListener("click", async () => {
    if (!identity || savingThis() || (!toDesktop && !projectId())) return;
    const key = identity.key;
    saving.add(key);
    updateButtons();
    // Hubble Desktop comes to the front to ask for a project, which usually closes this popup: the page's toast then says how it went.
    say(captureStatus, toDesktop ? "Choose a project in Hubble Desktop…" : "Saving…");
    const answer = await send(MSG_CAPTURE_CONVERSATION, { tabId: tab.id, expectedKey: key, ...(projectId() ? { workspaceId: projectId() } : {}) });
    saving.delete(key);
    // The tab moved on while this saved: the answer is about a conversation no longer on screen (Hubble's own toast said how it went).
    if (identity?.key !== key) {
      updateButtons();
      return;
    }
    if (answer?.ok) {
      say(captureStatus, describeCapture(answer.result, answer.result?.project || projectName()));
      if (!answer.result?.desktop) openButton.hidden = true;
      updateButtons();
      void lookUpSaved();
      void search();
      return;
    }
    say(captureStatus, captureError(answer?.error));
    // Hubble Desktop closed since this popup opened: back to choosing a project for Hubble on the web.
    if (answer?.error === "no-project" && toDesktop) {
      toDesktop = false;
      desktopOpen = false;
      showDesktopTarget();
      await loadProjects(false);
      say(captureStatus, captureError("no-project"));
      void lookUpSaved();
    }
    updateButtons();
  });
  openButton.addEventListener("click", async () => {
    say(captureStatus, "Opening Hubble…");
    const ok = await loadProjects(true);
    if (ok) say(captureStatus, "");
    void search();
  });
  select.addEventListener("change", () => {
    const option = select.selectedOptions?.[0];
    if (option?.value) rememberProject({ id: option.value, name: option.textContent });
    chosen.clear();
    hits = [];
    updateButtons();
    void search();
  });
  let debounce;
  query.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void search(), 250);
  });
  insertButton.addEventListener("click", () => void use("insert"));
  copyButton.addEventListener("click", () => void use("copy"));
  el("memory-panel")?.addEventListener("toggle", () => {
    if (el("memory-panel").open && hits.length === 0) void search();
  });

  /**
   * The tab moved — another chat opened in it (in the app, or with back and forward), it reloaded, or another tab
   * came to the front: the panel starts over for the conversation it is on now. Nothing of the last one stays.
   */
  function follow(next) {
    if (!next?.url) return;
    const nextIdentity = aiProviderOf(next.url) ? conversationIdentityOf(next.url) : undefined;
    const moved = next.id !== tab.id || next.url !== tab.url;
    const sameConversation = next.id === tab.id && nextIdentity?.key === identity?.key && aiProviderOf(next.url) === provider;
    tab = next;
    if (!moved || sameConversation) {
      showPage();
      return;
    }
    lookupToken += 1;
    say(captureStatus, "");
    if (savedState) say(savedState, "");
    if (!aiProviderOf(tab.url)) {
      // Not an AI app any more: nothing here to save.
      identity = undefined;
      conversation = false;
      section.hidden = true;
      updateButtons();
      return;
    }
    provider = aiProviderOf(tab.url);
    name = AI_PROVIDER_NAMES[provider];
    identity = nextIdentity;
    conversation = identity !== undefined;
    toDesktop = conversation && desktopOpen;
    section.hidden = false;
    showPage();
    showDesktopTarget();
    updateButtons();
    void lookUpSaved();
  }
  try {
    chrome.tabs?.onUpdated?.addListener((tabId, change, updated) => {
      if (tabId === tab.id && (change.url || change.title)) follow({ ...tab, ...updated, id: tabId });
    });
    chrome.tabs?.onActivated?.addListener(async ({ tabId, windowId }) => {
      if (tab.windowId !== undefined && windowId !== tab.windowId) return;
      const next = await chrome.tabs.get(tabId).catch(() => undefined);
      if (next) follow(next);
    });
  } catch {
    // No tab events: the popup closes when the tab changes anyway, and Save re-checks the tab before reading it.
  }

  desktopOpen = await desktopTakesConversations();
  toDesktop = conversation && desktopOpen;
  showDesktopTarget();
  await loadProjects(false);
  void lookUpSaved();
  return true;
}
