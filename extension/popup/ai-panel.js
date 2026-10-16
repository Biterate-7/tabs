import { MSG_CAPTURE_CONVERSATION, MSG_INSERT_CONTEXT, MSG_MEMORY_REQUEST, TARGET_PROJECT_KEY } from "../src/config.js";
import { AI_PROVIDER_NAMES, aiProviderOf, isConversationUrl } from "../src/ai-pages.js";
import { readStoredTarget } from "../src/quick-add.js";

/**
 * The popup's AI-app section: on ChatGPT, Claude, Gemini or Perplexity,
 *
 *   Save this conversation   reads the conversation on screen (only now,
 *                            only this tab) into the project chosen here
 *   Use your knowledge here  searches that project, builds context from the
 *                            items ticked, and inserts it into the message
 *                            box — or copies it, and says which happened
 *
 * Everything that changes data happens in the Hubble page; this only asks
 * and reports. Every failure is said in words, with the fallback that works.
 */

/** What to say for each reason a save can fail. */
export const CAPTURE_ERRORS = {
  "not-supported": "Hubble can save conversations from ChatGPT, Claude, Gemini and Perplexity.",
  "not-a-conversation": "Open a conversation to save it — this page isn't one.",
  "no-messages": "Hubble couldn't find the messages on this page (the app may have changed its layout). Copy the conversation and paste it in Hubble: Add → Paste a conversation.",
  "empty-conversation": "There are no messages in this conversation yet. If it's still loading, wait a moment and try again.",
  empty: "Hubble couldn't find the messages on this page. Copy the conversation and paste it in Hubble: Add → Paste a conversation.",
  "page-unreadable": "Chrome didn't let Hubble read this page. Reload it and try again, or paste the conversation in Hubble.",
  "read-failed": "Hubble couldn't read this conversation's layout. Copy the conversation and paste it in Hubble: Add → Paste a conversation.",
  "project-missing": "That project isn't in Hubble any more. Choose another one.",
  "storage-failed": "Hubble couldn't keep the conversation on this device, so nothing was saved. Try again.",
  invalid: "That didn't come through as a conversation. Reload the page and try again.",
  "tab-gone": "That tab was closed.",
  "hubble-unreachable": "Hubble couldn't be opened. Check your connection and try again.",
  "no-response": "Hubble didn't answer. Open Hubble, then try again.",
  timeout: "Hubble didn't answer in time. Open Hubble, then try again.",
  "not-ready": "Hubble is still loading. Try again in a moment.",
  failed: "Something went wrong. Try again.",
};

export function captureError(reason) {
  return CAPTURE_ERRORS[reason] ?? CAPTURE_ERRORS.failed;
}

/** "Saved to History IA · 14 turns" — what a save did, in words. */
export function describeCapture(result, projectName) {
  const turns = Number.isInteger(result?.turns) ? ` · ${result.turns} turn${result.turns === 1 ? "" : "s"}` : "";
  const cut = result?.truncated ? " · very long, so only the first part was kept" : "";
  // A long Claude or Perplexity chat keeps only the messages near the screen on the page, wherever it is scrolled.
  const older = result?.partial
    ? ". Only the part of this chat loaded on the page was saved — long chats load a few messages at a time. To keep all of it, import the app's data export or paste the conversation in Hubble."
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
  const provider = aiProviderOf(activeTab.url);
  if (!provider) return false;

  const name = AI_PROVIDER_NAMES[provider];
  const conversation = isConversationUrl(activeTab.url);
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

  section.hidden = false;
  el("ai-page").textContent = conversation ? `${name} · this conversation` : `${name} · open a conversation to save it`;

  const say = (target, text) => {
    target.textContent = text;
    target.hidden = !text;
  };
  const projectId = () => select.value;
  const projectName = () => select.selectedOptions?.[0]?.textContent ?? "your project";

  function updateButtons() {
    captureButton.disabled = busy || !conversation || !projectId();
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

  async function loadProjects(openIfMissing) {
    const remembered = await rememberedProject();
    const answer = await memory("projects", {}, openIfMissing);
    if (answer?.ok) {
      const projects = readPanelProjects(answer.result?.projects);
      openButton.hidden = true;
      fillProjects(projects, remembered?.id ?? answer.result?.currentId);
      if (projects.length === 0) say(captureStatus, "Make a project in Hubble first.");
      return true;
    }
    // No Hubble open: the project last used still works — Hubble opens when the conversation is saved.
    fillProjects(remembered ? [{ id: remembered.id, name: remembered.name || "Your project" }] : [], remembered?.id);
    openButton.hidden = false;
    say(captureStatus, remembered ? "Hubble isn't open; it will open to save the conversation." : "Open Hubble to choose a project.");
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
        const placed = await send(MSG_INSERT_CONTEXT, { tabId: activeTab.id, text: built.text });
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

  captureButton.addEventListener("click", async () => {
    if (busy || !projectId()) return;
    busy = true;
    updateButtons();
    say(captureStatus, "Saving…");
    const answer = await send(MSG_CAPTURE_CONVERSATION, { tabId: activeTab.id, workspaceId: projectId() });
    busy = false;
    updateButtons();
    say(captureStatus, answer?.ok ? describeCapture(answer.result, projectName()) : captureError(answer?.error));
    if (answer?.ok) {
      openButton.hidden = true;
      void search();
    }
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

  await loadProjects(false);
  return true;
}
