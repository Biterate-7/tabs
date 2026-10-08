// Quick add (Hubble 2.0): putting the tab you are on into your Hubble project
// without opening the popup — from the tab strip's own right-click menu, the
// page's right-click menu, or a keyboard shortcut.
//
// Why not a drag from the tab strip: Chrome's tab strip does not take part in
// HTML drag and drop. Dragging a tab moves it between windows; no web page
// (Hubble included) receives a drop event or any data, and no extension API
// reports a tab-strip drag starting, hovering or ending. The closest supported
// interaction with an *actual* Chrome tab is its context menu
// (chrome.contextMenus, `contexts: ["tab"]`), which hands the extension the
// very tab that was right-clicked. See docs/project-context.md §4.
//
// Everything here is pure, so it is tested without a browser; background.js
// does the chrome.* calls.

/** The project quick add sends to, as stored: `{ id, name }`. An older popup stored a bare id. */
export function readStoredTarget(raw) {
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 200) return { id: raw, name: "" };
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 200) return undefined;
  return { id: raw.id, name: typeof raw.name === "string" ? raw.name.slice(0, 120) : "" };
}

/** A project list as the Hubble page reported it, re-checked: ids and names only. */
export function readProjectList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((project) => project && typeof project.id === "string" && project.id.length > 0 && project.id.length <= 200 && typeof project.name === "string")
    .slice(0, 200)
    .map((project) => ({ id: project.id, name: project.name.slice(0, 120) || "Untitled project" }));
}

/**
 * Which project quick add sends to, after the Hubble page reports the project
 * on screen.
 *
 * The project the person is looking at in Hubble is the current project: a
 * report from a *visible* Hubble page (opened, switched to, or come back to)
 * sets it. Choosing a project in the popup sets it too, until they next look
 * at Hubble. A hidden Hubble tab — one the extension opened in the background
 * to deliver a batch — only counts when it reports a *different* project from
 * the last one Hubble reported (the person switched there). A remembered
 * project that no longer exists is dropped, never sent to.
 *
 * Returns `{ target, lastFocusId }` to store; `target` is undefined only when
 * Hubble has no project to offer at all.
 */
export function resolveTarget({ stored, lastFocusId, focus, projects, visible = false }) {
  const known = readProjectList(projects);
  const focused = focus && known.find((project) => project.id === focus.id);
  const remembered = stored && known.find((project) => project.id === stored.id);
  if (focused && (visible || focused.id !== lastFocusId)) return { target: focused, lastFocusId: focused.id };
  if (remembered) return { target: remembered, lastFocusId: focused?.id ?? lastFocusId };
  return { target: focused, lastFocusId: focused?.id ?? lastFocusId };
}

/** The context-menu wording: names the project, so the person sees where the tab will go before choosing. */
export function menuTitle(target) {
  if (!target) return "Add to a Hubble project…";
  const name = target.name.length > 40 ? `${target.name.slice(0, 39)}…` : target.name;
  return `Add to ${name || "Hubble project"}`;
}

/**
 * Which tabs a right-click on a tab-strip tab adds. Chrome's own tab menu acts
 * on every selected tab when the right-clicked one is part of the selection
 * ("Move 3 tabs to new window"), so this does the same; a right-click on an
 * unselected tab means just that tab.
 */
export function menuScope(clickedTab, menuContext) {
  if (menuContext === "tab" && clickedTab?.highlighted) return { scope: "selected", windowId: clickedTab.windowId };
  return { scope: "tabs", tabIds: Number.isInteger(clickedTab?.id) ? [clickedTab.id] : [], windowId: clickedTab?.windowId };
}

// While a source is being read its detail is noise ("Reading source…" says it); once read, the detail is the point ("Ready · 1,840 words").
// A tab with nothing in it yet: Chrome's new tab page, or about:blank.
const BLANK_URLS = new Set(["", "about:blank", "chrome://newtab/", "chrome://new-tab-page/", "chrome-search://local-ntp/local-ntp.html", "edge://newtab/"]);

/** Whether a tab is blank — so refusing it can say "nothing to add" rather than blaming Chrome. */
export function isBlankTab(tab) {
  return !tab?.url || BLANK_URLS.has(tab.url);
}

const STATUS_WORDS = { pending: "Reading source…", processing: "Reading source…", ready: "Ready", partial: "Saved", failed: "Couldn't read" };
const READING = new Set(["pending", "processing"]);
const TERMINAL = new Set(["ready", "partial", "failed"]);

/** Whether every reported source has finished reading (ready, saved with a reason, or failed). */
export function statusesSettled(statuses) {
  return Array.isArray(statuses) && statuses.length > 0 && statuses.every((entry) => TERMINAL.has(entry?.status));
}

/** The toast's status line: what Hubble made of the source(s), in the project home's own words ("Reading source…" → "Ready · 1,840 words"). */
export function describeStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) return undefined;
  if (statuses.length === 1) {
    const [only] = statuses;
    const words = STATUS_WORDS[only.status];
    if (!words) return undefined;
    return only.detail && !READING.has(only.status) ? `${words} · ${only.detail}` : words;
  }
  const counts = {};
  for (const entry of statuses) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const parts = [];
  if (counts.ready) parts.push(`${counts.ready} ready`);
  if (counts.partial) parts.push(`${counts.partial} saved without text`);
  if (counts.failed) parts.push(`${counts.failed} couldn't be read`);
  const reading = (counts.pending ?? 0) + (counts.processing ?? 0);
  if (reading) parts.push(`${reading} being read`);
  return parts.join(" · ");
}

/** The toast while a quick add is on its way, and while Hubble reads what it added: "Adding to History IA…". */
export function describeAdding(target) {
  return { tone: "working", title: `Adding to ${target?.name || "your project"}…` };
}

/**
 * The toast for a finished quick add, from background.js's run result —
 * always naming the project, so the person sees where the tab went:
 *
 *   Added to History IA          Already in History IA                    Couldn't add to History IA
 *   <source title>               This source is already in the project.   <why, and what to do>
 *   Ready · 1,840 words
 *
 * `tone` is "done", "same" (already there), or "error". The source title and
 * status line are added by background.js, which knows the tab and asks Hubble.
 */
export function describeOutcome(result) {
  const name = result?.target?.name || "your project";
  if (result?.ok) {
    const added = result.accepted ?? 0;
    const already = result.alreadyInProject ?? 0;
    const skipped = result.skippedRestricted ?? 0;
    const notes = [];
    if (added > 0 && already > 0) notes.push(`${already} already there`);
    if (skipped > 0) notes.push(`${skipped} Chrome page${skipped === 1 ? "" : "s"} skipped`);
    if (added === 0) {
      const which = already > 1 ? "These sources are" : "This source is";
      return { tone: "same", title: `Already in ${name}`, detail: [`${which} already in the project.`, ...notes].join(" · ") };
    }
    return {
      tone: "done",
      title: added === 1 ? `Added to ${name}` : `Added ${added} sources to ${name}`,
      detail: notes.join(" · ") || undefined,
    };
  }
  if (result?.reason === "no-project") {
    return { tone: "error", title: "Open a project in Hubble first", detail: "Tabs go to the project you have open in Hubble." };
  }
  const title = `Couldn't add to ${name}`;
  switch (result?.reason) {
    case "project-missing":
      return { tone: "error", title, detail: `${name} isn't in Hubble any more. Open the project you want, then try again.` };
    case "no-importable-tabs":
      return result.blankOnly
        ? { tone: "error", title, detail: "A blank tab has nothing to add. Open a page in it first." }
        : { tone: "error", title, detail: "Chrome's own pages can't be read. Web pages, PDFs and videos can." };
    case "nothing-imported":
      return { tone: "error", title, detail: "Only web pages, PDFs and videos with a web address can be sources." };
    case "already-running":
      return { tone: "error", title, detail: "Still adding the last one. Try again in a moment." };
    case "tab-load-timeout":
      return { tone: "error", title, detail: "Hubble didn't open. Check your connection and try again." };
    default:
      return { tone: "error", title, detail: "Hubble didn't answer. Reload the Hubble page and try again." };
  }
}

/**
 * The in-page toast. Injected with chrome.scripting.executeScript into the
 * tab the person is looking at — allowed there only because they just used
 * the menu or shortcut (activeTab) — so it must be self-contained: no
 * closures, no imports. Calling it again updates the same toast in place.
 *
 * A closed shadow root keeps the page's styles out and the page's scripts
 * away from it; nothing about the page is read.
 */
export function showQuickAddToast(toast) {
  const HOST_ID = "hubble-quick-add-toast";
  let host = document.getElementById(HOST_ID);
  let root = host?.__hubbleRoot;
  if (!host || !root) {
    host?.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    root = host.attachShadow({ mode: "closed" });
    Object.defineProperty(host, "__hubbleRoot", { value: root });
    root.innerHTML = `
      <style>
        .t{box-sizing:border-box;width:min(320px,calc(100vw - 32px));padding:10px 12px;border-radius:8px;
          font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#26251e;background:#f7f7f4;
          border:1px solid rgba(38,37,30,.12);box-shadow:0 6px 24px rgba(38,37,30,.16);display:flex;gap:10px;align-items:flex-start}
        @media (prefers-color-scheme: dark){.t{color:#edecec;background:#1b1913;border-color:rgba(237,236,236,.14);box-shadow:0 6px 24px rgba(0,0,0,.5)}}
        .i{flex:none;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;color:#fff;background:#6b6b6b;margin-top:2px}
        .t[data-tone=done] .i{background:#17775a}.t[data-tone=error] .i{background:#bf2a50}.t[data-tone=working] .i{background:transparent;border:1.5px solid rgba(127,127,127,.35);border-top-color:rgba(127,127,127,.9);animation:s 1.2s linear infinite;width:12px;height:12px;margin-top:3px}
        @keyframes s{to{transform:rotate(360deg)}}
        @media (prefers-reduced-motion: reduce){.t[data-tone=working] .i{animation:none}}
        .b{min-width:0;flex:1}.h{font-weight:500;overflow-wrap:anywhere}.s{margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .d,.st{font-size:12px;opacity:.65;margin-top:1px;overflow-wrap:anywhere}
        .a{display:flex;gap:6px;margin-top:8px}
        button{font:inherit;font-size:12px;border-radius:6px;padding:3px 9px;cursor:pointer;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit}
        button:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
        .x{border:0;padding:0 4px;font-size:16px;line-height:1;opacity:.6}
        [hidden]{display:none!important}
      </style>
      <div class="t" role="status" aria-live="polite"><div class="i" aria-hidden="true"></div>
        <div class="b"><div class="h"></div><div class="s"></div><div class="d"></div><div class="st"></div><div class="a"><button type="button" class="o">Open in Hubble</button></div></div>
        <button type="button" class="x" aria-label="Dismiss">×</button></div>`;
    root.querySelector(".x").addEventListener("click", () => host.remove());
    root.querySelector(".o").addEventListener("click", () => {
      const focus = host.__hubbleFocus;
      host.remove();
      if (focus && globalThis.chrome?.runtime?.sendMessage) chrome.runtime.sendMessage({ type: "TABDUMP_FOCUS", payload: focus }).catch(() => {});
    });
    (document.body ?? document.documentElement).appendChild(host);
  }
  const card = root.querySelector(".t");
  card.dataset.tone = toast.tone;
  root.querySelector(".i").textContent = toast.tone === "error" ? "!" : toast.tone === "working" ? "" : "✓";
  root.querySelector(".h").textContent = toast.title;
  for (const [selector, text] of [[".s", toast.source], [".d", toast.detail], [".st", toast.status]]) {
    const line = root.querySelector(selector);
    line.textContent = text ?? "";
    line.hidden = !text;
  }
  host.__hubbleFocus = toast.focus;
  root.querySelector(".o").hidden = !toast.focus;
  // Follow-ups a Hubble Desktop add offers ("Try again", "Open Hubble Web"): each tells the extension which, nothing more.
  const actions = root.querySelector(".a");
  for (const old of actions.querySelectorAll("[data-action]")) old.remove();
  for (const { action, label } of toast.actions ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = label;
    button.addEventListener("click", () => {
      host.remove();
      if (globalThis.chrome?.runtime?.sendMessage) chrome.runtime.sendMessage({ type: "HUBBLE_DESKTOP_ACTION", payload: { action } }).catch(() => {});
    });
    actions.appendChild(button);
  }
  actions.hidden = !toast.focus && !(toast.actions ?? []).length;
  clearTimeout(host.__hubbleTimer);
  if (toast.dismissAfterMs) host.__hubbleTimer = setTimeout(() => host.remove(), toast.dismissAfterMs);
}
