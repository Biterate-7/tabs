import {
  MSG_DUMP_TABS,
  MSG_ADD_TO_PROJECT,
  TARGET_PROJECT_KEY,
  MSG_CHECK_IMPORTED,
  MSG_FOCUS_TABDUMP,
  DUMP_STATE_KEY,
  DUMP_PHASE,
  DUMP_RUNNING_STALE_MS,
  DUMP_RESULT_FRESH_MS,
  QUICK_ADD_COMMAND,
  MSG_ADD_TO_DESKTOP,
  MSG_DESKTOP_STATUS,
  MSG_DESKTOP_ACTION,
  DESKTOP_STATE_KEY,
} from "../src/config.js";
import { buildImportPayload } from "../src/tabs.js";
import { readStoredTarget } from "../src/quick-add.js";

const els = {
  loading: document.getElementById("state-loading"),
  ready: document.getElementById("state-ready"),
  dumping: document.getElementById("state-dumping"),
  success: document.getElementById("state-success"),
  error: document.getElementById("state-error"),
  tabCount: document.getElementById("tab-count"),
  importStatus: document.getElementById("import-status"),
  dumpingMessage: document.getElementById("dumping-message"),
  successCount: document.getElementById("success-count"),
  successDetail: document.getElementById("success-detail"),
  errorMessage: document.getElementById("error-message"),
  errorDetail: document.getElementById("error-detail"),
  preview: document.getElementById("tab-preview"),
  dumpButton: document.getElementById("dump-button"),
  openButton: document.getElementById("open-button"),
  retryButton: document.getElementById("retry-button"),
  projectSection: document.getElementById("project-section"),
  projectSelect: document.getElementById("project-select"),
  projectUnavailable: document.getElementById("project-unavailable"),
  addCurrentButton: document.getElementById("add-current-button"),
  addSelectedButton: document.getElementById("add-selected-button"),
  successDump: document.getElementById("success-dump"),
  successProject: document.getElementById("success-project"),
  quickAddHint: document.getElementById("quick-add-hint"),
  projectName: document.getElementById("project-name"),
  desktopSection: document.getElementById("desktop-section"),
  desktopStatus: document.getElementById("desktop-status"),
  desktopCurrentButton: document.getElementById("desktop-current-button"),
  desktopSelectedButton: document.getElementById("desktop-selected-button"),
  desktopWindowButton: document.getElementById("desktop-window-button"),
  webButton: document.getElementById("web-button"),
};

const ALL_STATES = [els.loading, els.ready, els.dumping, els.success, els.error];
const PREVIEW_LIMIT = 5;

// How long a rendered success stays on screen before the popup focuses the
// Hubble tab and closes itself. Focusing is what actually dismisses the
// popup (Chrome closes an action popup as soon as the foreground tab
// changes), so this is the window in which the user gets to read the result
// — which is exactly what a background-initiated focus used to steal.
const SUCCESS_DWELL_MS = 900;

// The window this popup was opened over. Captured from the very tabs the
// user is being shown a preview of, so the dump can name that exact window
// instead of leaving the background service worker to infer a "current"
// window it does not have one of — see background.js's windowQuery.
let currentWindowId;

// Populated once detectTabs() has learned which candidate urls are already
// in the currently selected workspace (undefined until then, or if that
// couldn't be determined at all — see askHubble).
let alreadyImportedUrls;

// Where to send the user once they're done reading a result: set from
// whichever dump outcome this popup ends up rendering, whether that came
// back on this popup's own sendMessage or was recovered from storage after
// an earlier popup closed.
let focusTarget;

function showState(state) {
  for (const el of ALL_STATES) el.hidden = el !== state;
}

function renderPreview(tabs) {
  els.preview.innerHTML = "";

  for (const tab of tabs.slice(0, PREVIEW_LIMIT)) {
    const li = document.createElement("li");
    try {
      li.textContent = new URL(tab.url).hostname;
    } catch {
      li.textContent = tab.url;
    }
    els.preview.appendChild(li);
  }

  if (tabs.length > PREVIEW_LIMIT) {
    const li = document.createElement("li");
    li.textContent = `+${tabs.length - PREVIEW_LIMIT} more`;
    li.className = "popup__preview-more";
    els.preview.appendChild(li);
  }
}

/**
 * Asks the background worker (which relays through an already-open
 * Hubble tab's content script into the page itself) which of these urls
 * are already in the currently selected workspace — and, since Hubble 2.0,
 * the person's projects for "Add to a project". Both are `undefined` —
 * rather than thrown or guessed — whenever that genuinely can't be
 * determined (no Hubble tab open, or it didn't answer in time), so callers
 * fall back to the plain "N tabs detected" wording instead of showing a
 * wrong new/existing split.
 */
async function askHubble(urls) {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG_CHECK_IMPORTED, payload: { urls } });
    if (!response?.ok) return { existing: undefined, projects: undefined };
    return { existing: new Set(response.existingUrls), projects: readProjects(response.projects) };
  } catch {
    return { existing: undefined, projects: undefined };
  }
}

/** Projects as the page listed them, re-checked: an id and a name each. */
export function readProjects(raw) {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((project) => project && typeof project.id === "string" && project.id && typeof project.name === "string")
    .slice(0, 100)
    .map((project) => ({ id: project.id, name: project.name.slice(0, 120) || "Untitled project", sources: Number.isInteger(project.sources) ? project.sources : 0 }));
}

// The tabs "Add to project" would take: this window's active tab, and the highlighted ones.
let projectTabs = { current: 0, selected: 0 };

// The project last opened in Hubble (or chosen here) — the same one quick add (the tab's right-click menu, the shortcut) uses.
async function rememberedProject() {
  try {
    const stored = await chrome.storage?.local?.get(TARGET_PROJECT_KEY);
    return readStoredTarget(stored?.[TARGET_PROJECT_KEY]);
  } catch {
    return undefined;
  }
}

function rememberProject(target) {
  try {
    void chrome.storage?.local?.set({ [TARGET_PROJECT_KEY]: { id: target.workspaceId, name: target.name } });
  } catch {
    // Not remembered: the person chooses again next time, nothing else changes.
  }
}

/** "Alt+Shift+H" as Chrome reports it → "Alt + Shift + H". */
function formatShortcut(shortcut) {
  return shortcut
    .split("+")
    .map((key) => key.trim())
    .filter(Boolean)
    .join(" + ");
}

/** Teaches the quicker way in once there is a project: "Right-click any tab to add it directly. Alt + Shift + H". */
async function renderQuickAddHint() {
  if (!els.quickAddHint) return;
  if (!chosenProject()) {
    els.quickAddHint.hidden = true;
    return;
  }
  let shortcut = "";
  try {
    const commands = await chrome.commands?.getAll?.();
    shortcut = commands?.find((entry) => entry.name === QUICK_ADD_COMMAND)?.shortcut ?? "";
  } catch {
    // No shortcut to mention; the menu still works.
  }
  els.quickAddHint.textContent = "Right-click any tab to add it directly.";
  if (shortcut) {
    const key = document.createElement("kbd");
    key.className = "popup__kbd";
    key.textContent = formatShortcut(shortcut);
    els.quickAddHint.append(" ", key);
  }
  els.quickAddHint.hidden = false;
}

async function renderProjects(listed) {
  if (!els.projectSection) return;
  const remembered = await rememberedProject();
  // No Hubble tab to ask: the project Hubble last had open is still where a tab goes (Hubble opens to take it).
  const projects = listed ?? (remembered ? [{ id: remembered.id, name: remembered.name || "Your project", sources: 0 }] : undefined);
  if (!projects || projects.length === 0) {
    els.projectSection.hidden = true;
    if (els.projectUnavailable) els.projectUnavailable.hidden = projectTabs.current === 0;
    return;
  }
  if (els.projectUnavailable) els.projectUnavailable.hidden = true;
  els.projectSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a project…";
  els.projectSelect.appendChild(placeholder);
  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    els.projectSelect.appendChild(option);
  }
  // The project open in Hubble (or last chosen here), and only one that still exists.
  els.projectSelect.value = remembered && projects.some((project) => project.id === remembered.id) ? remembered.id : "";
  els.projectSection.hidden = false;
  updateProjectButtons();
  void renderQuickAddHint();
}

function updateProjectButtons() {
  const chosen = Boolean(els.projectSelect?.value);
  // "Add to History IA" — or, with nothing open in Hubble yet, a choice to make first.
  if (els.projectName) {
    const heading = els.projectName.parentElement;
    if (chosen) {
      heading.firstChild.textContent = "Add to ";
      els.projectName.textContent = chosenProject().name;
    } else {
      heading.firstChild.textContent = "Choose a project to add to";
      els.projectName.textContent = "";
    }
  }
  els.addCurrentButton.disabled = !chosen || projectTabs.current === 0;
  els.addSelectedButton.hidden = projectTabs.selected < 2;
  els.addSelectedButton.disabled = !chosen;
  els.addSelectedButton.textContent = "Add selected tabs";
  els.addSelectedButton.title = `Adds the ${projectTabs.selected} tabs selected in this window`;
}

function chosenProject() {
  const option = els.projectSelect?.selectedOptions?.[0];
  if (!option || !option.value) return undefined;
  return { workspaceId: option.value, name: option.textContent };
}

let addInFlight = false;

async function addToProject(scope) {
  const target = chosenProject();
  if (!target || addInFlight) return;
  addInFlight = true;
  showDumping(DUMP_PHASE.QUERYING_TABS);
  const detachPhaseWatch = watchDumpPhase();
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG_ADD_TO_PROJECT, payload: { windowId: currentWindowId, scope, target } });
    detachPhaseWatch();
    if (response?.reason === "already-running") watchForDumpCompletion(Date.now());
    else renderDumpOutcome(response ?? {});
  } catch (err) {
    detachPhaseWatch();
    showError({ message: "Lost contact with the Hubble extension. Reopen this popup to see what happened.", detail: err instanceof Error ? err.message : String(err) });
  } finally {
    addInFlight = false;
  }
}

function updateReadyUi(tabs, existingUrls) {
  els.tabCount.textContent = String(tabs.length);
  renderPreview(tabs);

  if (!existingUrls) {
    els.importStatus.hidden = true;
    els.dumpButton.disabled = tabs.length === 0;
    els.dumpButton.textContent = "Dump tabs →";
    return;
  }

  const newCount = tabs.filter((t) => !existingUrls.has(t.url)).length;
  const existingCount = tabs.length - newCount;

  els.importStatus.hidden = false;
  els.importStatus.textContent =
    existingCount === 0 ? "All new" : `${newCount} new · ${existingCount} already imported`;

  if (tabs.length > 0 && newCount === 0) {
    els.dumpButton.disabled = true;
    els.dumpButton.textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"} already imported`;
  } else {
    els.dumpButton.disabled = tabs.length === 0;
    els.dumpButton.textContent = existingCount > 0 ? `Dump ${newCount} new tab${newCount === 1 ? "" : "s"} →` : "Dump tabs →";
  }
}

async function detectTabs() {
  showState(els.loading);
  alreadyImportedUrls = undefined;

  const chromeTabs = await chrome.tabs.query({ currentWindow: true });
  currentWindowId = chromeTabs.find((tab) => Number.isInteger(tab.windowId))?.windowId;
  const payload = buildImportPayload(chromeTabs);
  const readable = new Set(payload.tabs.map((tab) => tab.tabId));
  projectTabs = {
    current: chromeTabs.filter((tab) => tab.active && readable.has(tab.id)).length,
    selected: chromeTabs.filter((tab) => tab.highlighted && readable.has(tab.id)).length,
  };

  updateReadyUi(payload.tabs, undefined);
  showState(els.ready);
  void renderDesktop(payload.tabs.length);

  if (payload.tabs.length === 0) return;

  const answer = await askHubble(payload.tabs.map((t) => t.url));
  // The user may have already clicked Dump by the time this resolves;
  // showState(els.ready) again would be wrong if they've moved on.
  if (els.ready.hidden) return;
  alreadyImportedUrls = answer.existing;
  updateReadyUi(payload.tabs, answer.existing);
  await renderProjects(answer.projects);
}

// What the user sees while a dump is in flight, per background.js's
// persisted phase. Concrete enough that a dump stuck on one of these is
// diagnosable from the popup alone, without opening the service worker's
// console.
const DUMP_PHASE_LABEL = {
  [DUMP_PHASE.QUERYING_TABS]: "Reading your open tabs…",
  [DUMP_PHASE.RESOLVING_TAB]: "Opening Hubble…",
  [DUMP_PHASE.DELIVERING]: "Handing your tabs to Hubble…",
  [DUMP_PHASE.RETRYING_IN_NEW_TAB]: "The open Hubble tab didn't respond — retrying in a new one…",
};

function showDumping(phase) {
  els.dumpingMessage.textContent = DUMP_PHASE_LABEL[phase] ?? "Dumping tabs…";
  showState(els.dumping);
}

// Maps a failed MSG_DUMP_TABS response's `reason` to copy a user can act
// on. Each reason corresponds to a distinct failure point in the pipeline
// (see background.js's dumpTabs) so "it didn't work" reports can actually
// be told apart: a same-origin page that can't mount the app looks nothing
// like the Hubble origin being unreachable, which looks nothing like
// Hubble's own tab-open call failing outright.
function describeDumpFailure(response) {
  switch (response?.reason) {
    case "no-importable-tabs":
      return { message: response.target ? "This page can't be added — Chrome's own pages aren't readable by extensions." : "No importable tabs in this window." };
    case "tab-query-failed":
      return { message: "Chrome wouldn't let Hubble read this window's tabs.", detail: response.detail };
    case "tab-open-failed":
      return { message: "Couldn't open or find the Hubble tab.", detail: response.detail };
    case "tab-load-timeout":
      return { message: "Hubble didn't finish loading. Check your connection and try again.", detail: response.detail };
    // Distinct from every other delivery failure, and the only one with a
    // cause the user can see: Chrome injects a manifest-declared content
    // script only as a page loads, so a Hubble tab that was already open
    // when the extension was installed or reloaded has no receiver in it.
    // background.js now injects one itself before reporting this, so reaching
    // this copy means even that was refused — which a reload does fix, and
    // "Hubble didn't respond" gave no hint of.
    case "content-script-missing":
      return {
        message: "Hubble's extension script isn't running in that tab. Reload the Hubble page and try again.",
        detail: response.detail,
      };
    case "delivery-failed":
      return {
        message: "Hubble didn't respond in that tab. Reload the Hubble page and try again.",
        detail: response.detail,
      };
    case "page-not-ready":
    case "no-ack":
      return {
        message: "Hubble opened but never confirmed the import. Reload the Hubble page and try again.",
        detail: response.detail,
      };
    case "nothing-imported":
      return {
        message: response.target
          ? `Hubble couldn't add this to ${response.target.name || "the project"} — only web pages, PDFs and videos with a web address can be sources.`
          : "Hubble received the tabs but couldn't import any of them.",
        detail: response.detail,
      };
    case "no-project":
      return { message: "Choose a project to add to first." };
    case "interrupted":
      return { message: "The previous dump was interrupted before it finished. Please try again." };
    case "already-running":
      return { message: "A dump is already in progress. Please wait for it to finish." };
    case "unexpected-error":
      return { message: "Something unexpected went wrong while dumping.", detail: response.detail };
    default:
      return { message: "Couldn't reach Hubble. Is it running?", detail: response?.reason };
  }
}

// Best-effort read of background.js's persisted dump-state record (see
// config.js's DUMP_STATE_KEY). Used on popup open to recover from the
// previous popup instance having closed mid-dump — e.g. because it lost
// focus — before its chrome.runtime.sendMessage response could arrive.
// Never throws: chrome.storage.session may simply be unavailable, in which
// case the popup falls back to its old behavior of always starting fresh.
async function getPersistedDumpState() {
  const session = chrome.storage?.session;
  if (!session) return undefined;
  try {
    const data = await session.get(DUMP_STATE_KEY);
    return data?.[DUMP_STATE_KEY];
  } catch {
    return undefined;
  }
}

/**
 * Activates the Hubble tab a dump landed in. Sent from here rather than
 * done by background.js at the end of the dump, because focusing a tab is
 * what closes this popup — doing it from the background reliably destroyed
 * the popup before it could render anything, which is exactly what "Dumping
 * tabs…, then the popup vanished" looked like from the user's side.
 *
 * Best-effort: the tab may have been closed in the meantime. The dump
 * already succeeded either way, so a failure here never becomes an error
 * state.
 */
async function focusHubble() {
  if (!focusTarget || !Number.isInteger(focusTarget.tabId)) return;
  try {
    await chrome.runtime.sendMessage({ type: MSG_FOCUS_TABDUMP, payload: focusTarget });
  } catch {
    // Background worker unreachable (extension reloading). Nothing to do:
    // the user still has the Hubble tab open, just not in front.
  }
}

// Renders a finished dump-state record exactly like a direct MSG_DUMP_TABS
// response would — used both by dumpTabs() below (the popup that actually
// triggered the dump, when it survives to see the response) and by
// watchForDumpCompletion() (a freshly reopened popup picking up a dump that
// finished after its predecessor had already closed).
function renderDumpOutcome(state) {
  if (state.focusTabId !== undefined) {
    focusTarget = { tabId: state.focusTabId, windowId: state.focusWindowId };
  }

  if (state.ok) {
    finishWithSuccess(state);
  } else {
    showError(describeDumpFailure(state));
  }
}

/**
 * Reports how many tabs actually landed, plus anything that didn't — a
 * partial import and a clean one must never look identical, and neither may
 * quietly hide the browser pages Chrome wouldn't let the extension read.
 */
function successDetail(state) {
  const notes = [];
  const attempted = state.count ?? 0;
  const accepted = state.accepted ?? attempted;
  // Into a project, a tab that was already a source was taken, not lost.
  const unread = attempted - accepted - (state.alreadyInProject ?? 0);
  if (unread > 0) notes.push(`${unread} couldn't be read as a link`);
  if (state.skippedRestricted) notes.push(`${state.skippedRestricted} browser page${state.skippedRestricted === 1 ? "" : "s"} skipped`);
  if (state.skippedAlreadyImported) notes.push(`${state.skippedAlreadyImported} already imported`);
  if (state.alreadyInProject && state.accepted > 0) notes.push(`${state.alreadyInProject} already in the project`);
  return notes.join(" · ");
}

function finishWithSuccess(state) {
  els.successCount.textContent = String(state.accepted ?? state.count ?? 0);
  // Into a project (Hubble 2.0): say where it went, and what was already there.
  if (els.successProject && els.successDump) {
    const toProject = Boolean(state.target);
    els.successDump.hidden = toProject;
    els.successProject.hidden = !toProject;
    if (toProject) {
      const added = state.accepted ?? 0;
      const name = state.target.name || "your project";
      els.successProject.textContent =
        added > 0 ? `Added ${added} source${added === 1 ? "" : "s"} to ${name}` : `Already in ${name}`;
    }
  }
  const detail = successDetail(state);
  els.successDetail.textContent = detail;
  els.successDetail.hidden = !detail;
  showState(els.success);
  setTimeout(() => {
    focusHubble().finally(() => window.close());
  }, SUCCESS_DWELL_MS);
}

/**
 * Subscribes to changes to background.js's persisted dump record, calling
 * `handler(state)` with each new value. Returns a detach function, or
 * `undefined` when the API isn't available at all.
 *
 * Deliberately the TOP-LEVEL `chrome.storage.onChanged`, not
 * `chrome.storage.session.onChanged`. A StorageArea's own onChanged passes
 * its listener a single `changes` argument and no `areaName` (see MDN's
 * storage.StorageArea.onChanged) — so a listener written against the
 * two-argument `(changes, areaName)` signature sees `areaName === undefined`,
 * filters out every event it is handed, and never fires at all in a real
 * browser. It looks perfectly healthy under a test double that supplies the
 * second argument anyway, which is exactly how this shipped: the popup's
 * whole "reopen me to see how the dump ended" recovery path was inert, and a
 * popup that Chrome closed mid-dump had no way back to the result. The
 * top-level event genuinely does carry `areaName`, so filtering on it here
 * is real.
 */
function onDumpStateChange(handler) {
  const onChanged = chrome.storage?.onChanged;
  if (!onChanged) return undefined;

  function listener(changes, areaName) {
    if (areaName !== "session") return;
    const next = changes?.[DUMP_STATE_KEY]?.newValue;
    if (next) handler(next);
  }

  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}

// Watches for background.js to finish (or fail) a dump that was already
// running when this popup opened, so the user isn't left staring at
// "Dumping tabs…" forever just because the popup that started it is gone.
//
// `referenceStartedAt` anchors the abandonment deadline below — pass the
// dump's actual persisted `startedAt` when known (recovering an in-flight
// dump on popup open), or omit it to mean "starting now" (attaching to a
// dump that was only just reported as already running via a direct
// MSG_DUMP_TABS response, e.g. from a double-click racing background.js's
// own concurrency guard).
function watchForDumpCompletion(referenceStartedAt) {
  let settled = false;

  const detach = onDumpStateChange((state) => {
    // Still running: keep waiting, but reflect whichever phase it just moved
    // into so the user can see progress rather than a frozen message.
    if (state.status === "running") {
      showDumping(state.phase);
      return;
    }
    finish(state);
  });

  if (!detach) {
    // No storage.onChanged support to lean on — the dump is still running
    // in the background either way, but this popup instance has no way to
    // learn when it finishes. Reflect that rather than hanging silently.
    showError({ message: "A dump is already in progress. Reopen Hubble in a moment to see the result." });
    return;
  }

  function finish(state) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    detach();
    renderDumpOutcome(state);
  }

  // Close the narrow race where the dump already finished (and wrote its
  // result) in the gap between this popup's earlier storage read and the
  // subscription just above — onChanged only fires for changes made *after*
  // a listener is registered, so a completion landing in that gap would
  // otherwise never be observed by this popup instance, leaving it stuck on
  // "Dumping tabs…" even though the result is sitting right there in
  // storage.
  getPersistedDumpState().then((current) => {
    if (current && current.status !== "running") finish(current);
  });

  // Never wait indefinitely: if background.js's service worker was evicted
  // or crashed mid-dump, nothing will ever write a terminal state, and
  // onChanged would otherwise never fire — leaving the popup stuck exactly
  // like the original bug this whole recovery path exists to fix. Bounded
  // by the same staleness budget init() uses to judge a *persisted* running
  // record abandoned, anchored to when the dump actually started.
  const deadline = (referenceStartedAt ?? Date.now()) + DUMP_RUNNING_STALE_MS;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    detach();
    showError({ message: "The previous dump didn't finish. Please try again." });
  }, Math.max(0, deadline - Date.now()));
}

function showError({ message, detail }) {
  els.errorMessage.textContent = message;
  els.errorDetail.textContent = detail ?? "";
  els.errorDetail.hidden = !detail;
  // "Open Hubble Web" belongs only to a Hubble Desktop failure, and Try again then retries that.
  retryAction = detectTabs;
  if (els.webButton) els.webButton.hidden = true;
  showState(els.error);
}

/* ---- Hubble Desktop ------------------------------------------------------
 * Tabs straight into Hubble Desktop on this computer (background.js runs it;
 * see src/desktop-add.js). Shown once Hubble Desktop has been seen, so a
 * person who only uses Hubble Web sees no change. The person picks the
 * project in Hubble Desktop itself, which usually comes to the front and
 * closes this popup — the toast in the page then carries the outcome.
 * ------------------------------------------------------------------------- */

let retryAction = detectTabs;

async function renderDesktop(readableCount) {
  if (!els.desktopSection) return;
  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: MSG_DESKTOP_STATUS });
  } catch {
    status = undefined;
  }
  if (els.ready.hidden || !(status?.available === true || status?.seen === true)) return;
  els.desktopStatus.textContent = status.available ? "· open" : "· opens when you add";
  els.desktopCurrentButton.disabled = projectTabs.current === 0;
  els.desktopSelectedButton.hidden = projectTabs.selected < 2;
  els.desktopSelectedButton.textContent = `Add ${projectTabs.selected} selected`;
  els.desktopWindowButton.disabled = readableCount === 0;
  els.desktopWindowButton.textContent = `Add all ${readableCount}`;
  els.desktopSection.hidden = false;
}

/** Mirrors background.js's live desktop record into the progress state. Returns a detach function. */
function watchDesktopState() {
  const onChanged = chrome.storage?.onChanged;
  if (!onChanged) return () => {};
  function listener(changes, areaName) {
    const next = changes?.[DESKTOP_STATE_KEY]?.newValue;
    if (areaName !== "session" || next?.status !== "running" || !next.toast) return;
    els.dumpingMessage.textContent = [next.toast.title, next.toast.detail].filter(Boolean).join(" — ");
  }
  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}

function showDesktopOutcome(outcome, scope) {
  const toast = outcome?.toast;
  if (!toast) {
    showError({ message: "Hubble Desktop isn't responding.", detail: outcome?.detail });
  } else if (toast.tone === "error") {
    showError({ message: toast.title, detail: toast.detail });
    const actions = (toast.actions ?? []).map((action) => (typeof action === "string" ? action : action.action));
    if (actions.includes("retry")) retryAction = () => addToDesktop(scope);
    if (els.webButton) els.webButton.hidden = !actions.includes("web");
  } else {
    if (els.successDump) els.successDump.hidden = true;
    els.successProject.hidden = false;
    els.successProject.textContent = toast.title;
    els.successDetail.textContent = toast.detail ?? "";
    els.successDetail.hidden = !toast.detail;
    els.openButton.hidden = true;
    showState(els.success);
  }
}

let desktopInFlight = false;

async function addToDesktop(scope) {
  if (desktopInFlight) return;
  desktopInFlight = true;
  els.dumpingMessage.textContent = "Connecting to Hubble Desktop…";
  showState(els.dumping);
  const detach = watchDesktopState();
  try {
    const outcome = await chrome.runtime.sendMessage({ type: MSG_ADD_TO_DESKTOP, payload: { scope, windowId: currentWindowId } });
    showDesktopOutcome(outcome, scope);
  } catch (err) {
    showError({ message: "Lost contact with the Hubble extension. Please try again.", detail: err instanceof Error ? err.message : String(err) });
  } finally {
    detach();
    desktopInFlight = false;
  }
}

// Guards against a genuine double-click (two `click` events dispatched in
// quick succession against the same button, before the first handler's
// showDumping() has actually taken it off-screen) sending two
// MSG_DUMP_TABS requests. background.js's own concurrency guard would
// reject the second one regardless, but without this, that rejection would
// flip this popup from "Dumping tabs…" to a dead-end error — even though
// the real (first) dump is still proceeding fine in the background.
let dumpInFlight = false;

async function dumpTabs() {
  if (dumpInFlight) return;
  dumpInFlight = true;
  showDumping(DUMP_PHASE.QUERYING_TABS);
  // Phase updates for the dump this popup started arrive the same way they
  // do for one it merely inherited: through the persisted record. Attaching
  // here means the "Opening Hubble…" / "Handing your tabs over…" progress
  // is visible in the common case too, not only after a popup reopen.
  const detachPhaseWatch = watchDumpPhase();
  try {
    // Re-collects fresh tabs at click time (rather than reusing the popup's
    // initial snapshot) in case anything changed while the popup was open.
    // excludeUrls carries forward whatever "already imported" set detectTabs
    // learned, so a dump never re-sends tabs already in the workspace.
    const response = await chrome.runtime.sendMessage({
      type: MSG_DUMP_TABS,
      payload: {
        windowId: currentWindowId,
        excludeUrls: alreadyImportedUrls ? Array.from(alreadyImportedUrls) : undefined,
      },
    });
    detachPhaseWatch();
    if (response?.reason === "already-running") {
      // A dump is genuinely already in flight — most likely a narrow race
      // this popup can't otherwise prevent. Attach to its real outcome
      // instead of dead-ending on an error the user has no useful action
      // for; renderDumpOutcome() takes it from here once it resolves.
      watchForDumpCompletion(Date.now());
    } else {
      renderDumpOutcome(response ?? {});
    }
  } catch (err) {
    detachPhaseWatch();
    // chrome.runtime.sendMessage itself rejected/threw — the background
    // service worker never answered at all (distinct from it answering with
    // an error result, handled above), e.g. right after an extension
    // reload/update invalidates this popup's connection. The dump may still
    // be running, so point at the recovery path rather than implying it died.
    showError({
      message: "Lost contact with the Hubble extension. Reopen this popup to see how the dump ended.",
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    dumpInFlight = false;
  }
}

/** Mirrors background.js's persisted phase into the dumping state. Returns a detach function. */
function watchDumpPhase() {
  const detach = onDumpStateChange((state) => {
    if (state.status === "running") showDumping(state.phase);
  });
  return detach ?? (() => {});
}

els.dumpButton.addEventListener("click", dumpTabs);
els.projectSelect?.addEventListener("change", () => {
  const target = chosenProject();
  if (target) rememberProject(target);
  updateProjectButtons();
  void renderQuickAddHint();
});
els.addCurrentButton?.addEventListener("click", () => addToProject("current"));
els.addSelectedButton?.addEventListener("click", () => addToProject("selected"));
els.retryButton.addEventListener("click", () => retryAction());
els.desktopCurrentButton?.addEventListener("click", () => addToDesktop("current"));
els.desktopSelectedButton?.addEventListener("click", () => addToDesktop("selected"));
els.desktopWindowButton?.addEventListener("click", () => addToDesktop("window"));
els.webButton?.addEventListener("click", () => {
  // The same tabs, to Hubble Web (background.js decides: the project last open there, or Hubble Web to choose one).
  void chrome.runtime.sendMessage({ type: MSG_DESKTOP_ACTION, payload: { action: "web" } }).catch(() => {});
  window.close();
});
els.openButton.addEventListener("click", () => {
  focusHubble().finally(() => window.close());
});

// Runs once on every popup open, before the normal detectTabs() flow, to
// recover from a dump that's still running (or that already finished)
// somewhere this popup instance didn't witness — most commonly because the
// popup that started it closed before background.js's response could
// arrive. Without this, reopening the popup would silently show "ready" as
// if nothing had happened, inviting a duplicate dump.
async function init() {
  const state = await getPersistedDumpState();

  if (state?.status === "running") {
    if (Date.now() - state.startedAt < DUMP_RUNNING_STALE_MS) {
      showDumping(state.phase);
      watchForDumpCompletion(state.startedAt);
      return;
    }
    // Older than any real dump should take — the service worker that was
    // running it was most likely evicted or crashed mid-dump. Let the user
    // retry instead of waiting on a result that will never arrive.
    showError({ message: "The previous dump didn't finish. Please try again." });
    return;
  }

  // A quick add (the tab's right-click menu, the shortcut) already said how it went in its own toast:
  // replaying it here would only bounce the person to Hubble when they opened the popup for something else.
  if (state?.finishedAt !== undefined && state.via !== "quick-add" && Date.now() - state.finishedAt < DUMP_RESULT_FRESH_MS) {
    renderDumpOutcome(state);
    return;
  }

  detectTabs();
}

init();
