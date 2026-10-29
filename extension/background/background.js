import {
  TABDUMP_ORIGIN,
  TABDUMP_APP_PATH,
  MSG_DUMP_TABS,
  MSG_ADD_TO_PROJECT,
  MSG_TABDUMP_IMPORT,
  MSG_CHECK_IMPORTED,
  MSG_BROWSER_COMMAND,
  MSG_FOCUS_TABDUMP,
  DUMP_STATE_KEY,
  DUMP_PHASE,
  TAB_READY_TIMEOUT_MS,
  SEND_RETRY_DELAYS_MS,
  CONTENT_SCRIPT_FILE,
  TARGET_PROJECT_KEY,
  HUBBLE_FOCUS_KEY,
  MSG_PROJECT_FOCUS,
  MSG_SOURCE_STATUS,
  QUICK_ADD_COMMAND,
  MENU_ADD_TAB,
  MENU_ADD_PAGE,
  SOURCE_STATUS_POLL_MS,
  SOURCE_STATUS_POLL_LIMIT_MS,
  MSG_ADD_TO_DESKTOP,
  MSG_DESKTOP_STATUS,
  MSG_DESKTOP_ACTION,
  DESKTOP_STATE_KEY,
  DESKTOP_LAST_KEY,
  DESKTOP_SEEN_KEY,
  MENU_DESKTOP_TAB,
  MENU_DESKTOP_WINDOW,
  MENU_DESKTOP_PAGE,
  MSG_CAPTURE_CONVERSATION,
  MSG_MEMORY_REQUEST,
  MSG_INSERT_CONTEXT,
  MSG_PAGE_REQUEST,
  PAGE_READY_WAIT_MS,
  MSG_SAVE_SESSION,
  CAPTURE_JOBS_KEY,
  CAPTURE_RETRY_ALARM,
  MSG_CAPTURE_STATUS,
  MSG_CAPTURE_RETRY,
  PROJECTS_SNAPSHOT_KEY,
} from "../src/config.js";
import { createCaptureQueue, publicJob } from "../src/capture-queue.js";
import { PROJECT_EVENTS, applyProjectsReport, readProjectsReport, readProjectsSnapshot } from "../src/projects-sync.js";
import { pageFingerprint } from "../src/tab-matching.js";
import { aiProviderOf, checkPageRead, conversationIdentityOf, insertIntoComposer, readConversationFromPage } from "../src/ai-pages.js";
import { createTransferRunner, readTransferRequest, MSG_AI_PERMISSION_ANSWER, MSG_AI_TRANSFER, MSG_AI_TRANSFER_PROGRESS, TRANSFER_PROVIDERS, TRANSFER_TIMING } from "../src/ai-transfer.js";
import { hubbleTransferStep } from "../src/ai-transfer-page.js";
import { DESKTOP_LAUNCH_URL, findDesktop } from "../src/desktop.js";
import { createDesktopAdd, createDesktopSave } from "../src/desktop-add.js";
import { buildImportPayload } from "../src/tabs.js";
import { buildSessionCapture } from "../src/sessions.js";
import { CONTEXT_ACTIONS, validateBrowserCommand } from "../src/browser-commands.js";
import { createActivityCollector, isPaused, readContextSettings } from "../src/context-activity.js";
import { activityKeyOf, isDetectable } from "../src/context-sites.js";
import { BROWSER_ACTION_HANDLERS } from "../src/browser-actions.js";
import {
  readStoredTarget,
  resolveTarget,
  menuTitle,
  menuScope,
  describeAdding,
  isBlankTab,
  describeOutcome,
  describeStatuses,
  statusesSettled,
  showQuickAddToast,
} from "../src/quick-add.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Structured, single-prefixed logging for every stage of the dump pipeline
// (dump started, tab count detected, tabs skipped, messages sent/received,
// completion/error) — so a report of "dumping tabs failed" on some other
// machine can actually be diagnosed from the service worker's console
// (chrome://extensions → Hubble → "service worker" → Inspect) instead of
// guessed at.
//
// Deliberately never logs a tab's url or title: the diagnostic value is in
// the counts, ids and stage names, and a service-worker console that logs a
// user's whole open-tab list is a privacy problem in exchange for nothing.
function log(stage, data) {
  console.log(`[Hubble] ${stage}`, data ?? "");
}

// chrome.storage.session may be unavailable (very old Chrome, or a
// restricted profile) — every call through here is best-effort and never
// allowed to fail the dump itself; it only feeds popup.js's recovery path
// (see popup.js's init()/watchForDumpCompletion()), never the primary
// sendResponse result channel.
async function setDumpState(state) {
  const session = chrome.storage?.session;
  if (!session) return;
  try {
    await session.set({ [DUMP_STATE_KEY]: state });
  } catch (err) {
    log("dump-state-persist-failed", errorMessage(err));
  }
}

// Guards against two dumps racing each other — e.g. a duplicate click, or a
// second popup opened while a dump triggered from an earlier (possibly
// already-closed) popup is still in flight. Only one dumpTabs() run is ever
// allowed to be in progress at a time; a second request is told so
// immediately rather than being silently queued or allowed to interleave
// chrome.tabs calls with the first.
let activeDump = null;

/**
 * A "running" dump record found in storage at service-worker startup can
 * only be an orphan: this module's `activeDump` is null by definition on a
 * fresh worker, so whatever wrote that record belonged to a worker instance
 * that no longer exists (evicted mid-dump, crashed, or reloaded). Left
 * alone, it makes the next popup open sit on "Dumping tabs…" until its
 * staleness deadline expires — waiting on a result nothing will ever write.
 *
 * MV3 gives no event for "you were evicted", so this runs at module scope
 * rather than from onStartup/onInstalled, which cover only browser launch
 * and install/update respectively — neither fires for a plain eviction,
 * which is the common case.
 */
async function reconcileOrphanedDump() {
  const session = chrome.storage?.session;
  if (!session) return;
  try {
    const data = await session.get(DUMP_STATE_KEY);
    const state = data?.[DUMP_STATE_KEY];
    if (state?.status !== "running") return;
    log("orphaned-dump-reconciled", { phase: state.phase, startedAt: state.startedAt });
    await session.set({
      [DUMP_STATE_KEY]: {
        ...state,
        status: "error",
        ok: false,
        reason: "interrupted",
        finishedAt: Date.now(),
      },
    });
  } catch (err) {
    log("orphaned-dump-reconcile-failed", errorMessage(err));
  }
}

reconcileOrphanedDump();

// Renders any caught value into a plain, safe-to-display string. Every
// error surfaced this way originates locally (chrome.* API rejections, or
// this file's own thrown errors) — never a server response — so there's
// nothing secret in it, just something concrete enough to tell "content
// script never attached" apart from "tab failed to open" when a user
// reports "dumping tabs failed" with no other detail to go on.
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function newImportId() {
  return globalThis.crypto?.randomUUID?.() ?? `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Whether this tab is on the route that actually mounts Hubble's app shell.
 * Same-origin routes that don't (the /privacy, /terms and /cookies legal
 * pages) match chrome.tabs.query's url filter identically but can never
 * ingest a dump — handing one the payload used to look exactly like success.
 */
function isAppRouteUrl(url) {
  try {
    return new URL(url).pathname === TABDUMP_APP_PATH;
  } catch {
    return false;
  }
}

/**
 * Whether a rejected chrome.tabs.sendMessage means there was no content
 * script listening in that tab at all.
 *
 * Chrome words this one specific condition as "Could not establish
 * connection. Receiving end does not exist." It is materially different from
 * every other delivery failure — the message never reached any receiver, so
 * nothing about the page, the app or the payload is implicated — and it is
 * the one failure this extension can actually repair, by injecting the
 * content script itself. "The message port closed before a response was
 * received" is deliberately NOT matched: there a receiver existed and then
 * went away, which injecting a second copy would not fix.
 */
function isMissingReceiverError(err) {
  const message = errorMessage(err);
  return /Receiving end does not exist|Could not establish connection/i.test(message);
}

/**
 * Puts the content script into a tab that does not have one.
 *
 * This is the repair for the failure that made Hubble look broken on every
 * machine but the developer's. Chrome injects manifest-declared content
 * scripts only as a page loads, so a tab that was already open when the
 * extension was installed or reloaded never receives one — and onboarding's
 * own final step ("Return to Hubble and click the Hubble extension")
 * guarantees that the very first tab a new user dumps into is exactly such a
 * tab. Without this, that dump could only ever fail with Chrome's
 * "Receiving end does not exist", no matter how many times it was retried:
 * retrying a tab that will never be injected into is not a recovery, it is
 * the same failure spelled slower.
 *
 * Injecting the same file the manifest declares (CONTENT_SCRIPT_FILE) into
 * the same isolated world is idempotent by construction — content-script.js
 * refuses to register a second set of listeners (see `alreadyRegistered`
 * there) — so this is safe to call on a tab that turns out to have had one
 * after all, which a document_start injection racing this call can cause.
 */
async function ensureContentScriptInjected(tabId) {
  if (!chrome.scripting?.executeScript) {
    // Older Chrome, or the "scripting" permission missing from a hand-edited
    // manifest. Reported rather than thrown: the caller still has the
    // fresh-tab fallback, and a silent no-op here would make the resulting
    // failure unattributable.
    log("content-script-injection-unavailable", { tabId });
    return false;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
    log("content-script-injected", { tabId });
    return true;
  } catch (err) {
    // Injection is refused for a tab the extension has no host access to
    // (a chrome:// page, the Web Store, another origin) and for a tab that
    // has since closed. Neither is recoverable here.
    log("content-script-injection-failed", { tabId, detail: errorMessage(err) });
    return false;
  }
}

/**
 * Delivers `payload` to one specific tab and resolves to what actually
 * happened there.
 *
 * Three failure modes are kept apart, because they call for three different
 * responses — and because collapsing them is what made every cross-machine
 * report arrive as the same undiagnosable "Hubble didn't respond":
 *
 *  - sendMessage rejecting with "Receiving end does not exist" means no
 *    content script is attached to that tab. Transient during a page load, so
 *    it is worth a couple of short retries — but PERMANENT for a tab that was
 *    already open when the extension was installed, which no number of
 *    retries can fix. So once the retries are spent, the script is injected
 *    and delivery is attempted once more against a receiver now known to
 *    exist. Only if that also fails is this reported as content-script-missing.
 *  - sendMessage rejecting for any other reason is a genuine delivery failure
 *    against a receiver that did exist.
 *  - a content script that answers `{ ok: false }` has given a definitive
 *    answer — the page behind it never became able to ingest the batch.
 *    Retrying the same tab would just burn another full ack timeout, so this
 *    returns immediately and lets the caller try a different tab instead.
 */
async function deliverImportToTab(tabId, importId, payload, context = {}) {
  const { windowId, phase } = context;
  let lastError;

  // Reads the content script's answer, or records why there wasn't one.
  // Returns a settled delivery result, or undefined to mean "try again".
  async function attemptSend(attempt) {
    // Deliberately origin-only, never the tab's actual url: enough to prove
    // which origin was targeted (the whole failure class is "the message went
    // somewhere the content script does not run") without logging a page the
    // user is looking at.
    log("send-message", { tabId, windowId, origin: TABDUMP_ORIGIN, phase, attempt });
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: MSG_TABDUMP_IMPORT, importId, payload });

      // A content script from a build predating the ack handshake answers
      // `undefined`. Treat that as unproven rather than as success — the
      // whole point of the handshake is that "the message was accepted by
      // *something*" is not evidence the app ingested it.
      if (!response) return { delivered: false, reason: "no-ack", detail: "The Hubble page did not confirm the import." };
      if (response.ok) {
        const duplicates = Number(response.duplicates) || 0;
        return {
          delivered: true,
          accepted: Number(response.accepted) || 0,
          ...(duplicates > 0 ? { duplicates } : {}),
          // The page took the batch but has no project with the target id (deleted since it was remembered).
          ...(response.reason === "project-missing" ? { projectMissing: true } : {}),
        };
      }
      return {
        delivered: false,
        reason: response.reason === "page-not-ready" ? "page-not-ready" : "no-ack",
        detail: `Hubble page reported "${response.reason}".`,
      };
    } catch (err) {
      lastError = err;
      return undefined;
    }
  }

  let attempt = 0;
  for (const delay of [0, ...SEND_RETRY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    const settled = await attemptSend(++attempt);
    if (settled) return settled;
  }

  // Every attempt was rejected. If that is because nothing is listening in
  // this tab, it is repairable exactly once, right here.
  if (isMissingReceiverError(lastError)) {
    log("content-script-missing", { tabId, windowId, origin: TABDUMP_ORIGIN, phase, attempts: attempt });
    if (await ensureContentScriptInjected(tabId)) {
      const settled = await attemptSend(++attempt);
      if (settled) return settled;
    }
  }

  // Reported as two distinct reasons so the popup can tell the user the one
  // thing that actually helps: a missing receiver is fixed by reloading the
  // page (or the extension), which is useless advice for anything else.
  return {
    delivered: false,
    reason: isMissingReceiverError(lastError) ? "content-script-missing" : "delivery-failed",
    detail: errorMessage(lastError),
  };
}

// Newly-created tabs need their content script to have attached before a
// message can land. `status: "complete"` fires around the page's `load`
// event, and the content script is registered `run_at: "document_start"`,
// which injects before the page's own scripts run — so by the time a tab
// reports "complete" its content script is necessarily already there.
//
// This used to be `document_idle`, and this comment used to claim the same
// guarantee for it. That was simply false: Chrome documents document_idle as
// injecting "between document_end and immediately after the window.onload
// event fires", i.e. it is explicitly allowed to land AFTER the moment
// `status: "complete"` reports. On a warm machine the script won that race
// and everything worked; on a cold one — a fresh profile, an uncached bundle,
// slower hardware, all at once on a first install — it lost, and the dump
// failed with Chrome's "Receiving end does not exist" against a tab that had
// visibly finished loading. document_start removes the race rather than
// widening the retry window around it; the script touches only `window`, so
// it has nothing to wait for the DOM for.
//
// It says nothing about the React app behind it, which demonstrably attaches
// its own listener AFTER `load` — that gap is closed by the ack handshake in
// content-script.js, not here.
//
// Bounded two ways so this can never hang `dumpTabs()` forever: a timeout
// (the page might never finish loading — blocked request, offline, etc.)
// and an onRemoved listener (the user might close the tab before it loads).
// Either one always cleans up both listeners.
function waitForTabComplete(tabId, timeoutMs = TAB_READY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    }

    function finish(outcome) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish("complete");
    }

    function onRemoved(removedTabId) {
      if (removedTabId === tabId) finish("removed");
    }

    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // A tab can reach "complete" in the gap between chrome.tabs.create()
    // resolving and these listeners attaching — a cached page routinely beats
    // an await. The onUpdated event is then already gone, and without this
    // re-check the load costs the full TAB_READY_TIMEOUT_MS before being
    // misreported as a load timeout on a page that had in fact loaded fine.
    // Ordered after addListener so a completion landing *during* the re-check
    // is still caught by the listener; finish() is idempotent, so both firing
    // is harmless.
    const recheck = chrome.tabs.get?.(tabId);
    if (recheck?.then) {
      recheck.then(
        (tab) => {
          if (tab?.status === "complete") finish("complete");
        },
        () => finish("removed")
      );
    }
  });
}

/**
 * Opens a brand-new Hubble tab and waits for it to finish loading.
 * Resolves to `{ tabId, windowId }`.
 *
 * Deliberately never activates the tab or focuses its window.
 * chrome.tabs.create()'s default `active: true` puts a brand-new tab in the
 * foreground *immediately*, and Chrome dismisses an open action-popup the
 * instant the foreground tab changes — which would kill the popup before
 * dumpTabs() has finished its remaining async work. Activation is the
 * popup's own call, once it has rendered a result (see MSG_FOCUS_TABDUMP).
 */
async function openHubbleTab() {
  const created = await chrome.tabs.create({ url: TABDUMP_ORIGIN, active: false });
  const outcome = await waitForTabComplete(created.id);
  if (outcome === "removed") throw new Error("The Hubble tab was closed before it finished loading.");
  return { tabId: created.id, windowId: created.windowId, loadOutcome: outcome };
}

/**
 * Picks the already-open Hubble tab most likely to be able to ingest a
 * dump, or `undefined` when there isn't one.
 *
 * Ordering, most to least preferred:
 *   1. the app route, currently active — the tab the user is actually looking at
 *   2. the app route, in the background
 * A same-origin tab that isn't on the app route (a legal page) is never
 * chosen: it can't mount the app shell, so handing it the payload would
 * always end in a wasted ack timeout followed by the fresh-tab fallback.
 * Opening a usable tab straight away is both faster and less confusing.
 *
 * A tab Chrome has discarded (Memory Saver) comes last: it has no page and no
 * content script until it is reloaded, so asking it anything only ever fails.
 */
function pickIngestibleTab(matches) {
  const appRoute = matches.filter((tab) => typeof tab.url === "string" && isAppRouteUrl(tab.url));
  const live = appRoute.filter((tab) => !tab.discarded);
  return live.find((tab) => tab.active) ?? live[0] ?? appRoute[0];
}

/**
 * The tabs to dump. `windowId` comes from the popup, which knows exactly
 * which window it was opened over and has already shown the user a preview
 * of that window's tabs.
 *
 * Falling back to `currentWindow: true` here is a genuinely different query:
 * a service worker has no window of its own, so Chrome resolves "current"
 * to the last-focused window. That is *usually* the popup's window, but it
 * is an inference about browser state rather than a fact — and when it is
 * wrong (several windows, focus moved between the popup opening and the
 * click landing) the user gets a silent wrong answer: a confident "Dumped 31
 * tabs" listing some other window's tabs entirely. Passing the id makes the
 * common path exact and leaves the inference only for a caller that has none.
 */
function windowQuery(windowId) {
  return Number.isInteger(windowId) ? { windowId } : { currentWindow: true };
}

/**
 * Which tabs a run takes. A dump takes the whole window; "Add to project"
 * (Hubble 2.0) takes the tab the person is looking at, or the tabs they
 * selected (ctrl/shift-click in the tab strip — Chrome's `highlighted`).
 */
/** Exactly these tabs (quick add from a right-clicked tab or page). A tab closed since is simply not there. */
async function getTabs(tabIds) {
  const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => undefined)));
  return tabs.filter(Boolean);
}

function scopeQuery(scope, windowId) {
  if (scope === "current") return { ...windowQuery(windowId), active: true };
  if (scope === "selected") return { ...windowQuery(windowId), highlighted: true };
  return windowQuery(windowId);
}

/** A project target as the popup sent it, re-checked: an id and a name, nothing else. */
function readTarget(target) {
  if (!target || typeof target !== "object") return undefined;
  const workspaceId = typeof target.workspaceId === "string" && target.workspaceId.length > 0 && target.workspaceId.length <= 200 ? target.workspaceId : undefined;
  if (!workspaceId) return undefined;
  const name = typeof target.name === "string" ? target.name.slice(0, 200) : "";
  return { workspaceId, name };
}

async function dumpTabs(excludeUrls, windowId, options = {}) {
  const startedAt = Date.now();
  const importId = newImportId();
  const target = readTarget(options.target);
  const tabIds = Array.isArray(options.tabIds) ? options.tabIds.filter(Number.isInteger).slice(0, 50) : undefined;
  const scope = tabIds ? "tabs" : options.scope === "current" || options.scope === "selected" ? options.scope : "window";
  log("dump-started", { excludeCount: excludeUrls?.length ?? 0, importId, scope, toProject: Boolean(target) });

  // The tab the person was looking at when the run started (its id and a fingerprint of its address — never the
  // address): a popup opened later replays this run's result only over that same page, never over another
  // conversation the tab or window has moved to since.
  let shownTab;
  async function persist(patch) {
    // `via` lets the popup tell a quick add (already reported by its own toast) from a run it should replay.
    await setDumpState({ startedAt, importId, ...(target ? { target } : {}), ...(options.via ? { via: options.via } : {}), ...(shownTab ? { shownTab } : {}), ...patch });
  }

  await persist({ status: "running", phase: DUMP_PHASE.QUERYING_TABS });

  let chromeTabs;
  try {
    chromeTabs = tabIds ? await getTabs(tabIds) : await chrome.tabs.query(scopeQuery(scope, windowId));
    const active = Array.isArray(chromeTabs) ? chromeTabs.find((tab) => tab?.active && Number.isInteger(tab.id) && typeof tab.url === "string") : undefined;
    if (active) shownTab = { id: active.id, page: pageFingerprint(active.url) };
  } catch (err) {
    const result = { ok: false, status: "error", reason: "tab-query-failed", count: 0, detail: errorMessage(err) };
    log("tab-query-failed", result.detail);
    await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    return { result };
  }

  const payload = buildImportPayload(chromeTabs, excludeUrls);
  const counts = {
    count: payload.tabs.length,
    skippedRestricted: payload.skippedRestricted,
    skippedAlreadyImported: payload.skippedAlreadyImported,
  };
  log("tabs-detected", { totalOpenTabs: chromeTabs.length, ...counts });

  if (payload.tabs.length === 0) {
    // Only blank tabs (a new tab, about:blank): nothing to add, which is not Chrome refusing anything.
    const blankOnly = chromeTabs.length > 0 && chromeTabs.every(isBlankTab);
    const result = { ok: false, status: "error", reason: "no-importable-tabs", ...counts, ...(blankOnly ? { blankOnly } : {}) };
    await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    return { result };
  }

  // A project target travels with the batch; the page checks it names one of its own projects.
  const wire = { tabs: payload.tabs, ...(target ? { target: { workspaceId: target.workspaceId, as: "sources" } } : {}) };

  // Attempt 1: an already-open, app-route Hubble tab, when there is one.
  await persist({ status: "running", phase: DUMP_PHASE.RESOLVING_TAB, ...counts });

  let existing;
  try {
    existing = pickIngestibleTab(await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` }));
  } catch (err) {
    // Not fatal on its own: we can still open a fresh tab below. Recorded so
    // a profile where the url-filtered query is unexpectedly failing is
    // diagnosable rather than merely looking like "no Hubble tab open".
    log("tabdump-tab-lookup-failed", errorMessage(err));
  }

  if (existing?.id !== undefined) {
    log("tabdump-tab-reused", { tabId: existing.id, windowId: existing.windowId });
    await persist({ status: "running", phase: DUMP_PHASE.DELIVERING, ...counts });

    const attempt = await deliverImportToTab(existing.id, importId, wire, {
      windowId: existing.windowId,
      phase: DUMP_PHASE.DELIVERING,
    });
    log("delivery-attempted", { tabId: existing.id, ...attempt });
    if (attempt.delivered) {
      return finishDelivered(attempt, existing.id, existing.windowId);
    }
    log("reused-tab-unusable", { tabId: existing.id, reason: attempt.reason });
  }

  // Attempt 2: a fresh tab. Reached either because no usable Hubble tab was
  // open, or because the one that was open turned out not to be able to
  // ingest (stale service-worker-less page, a crashed renderer, a build
  // mid-deploy). Retrying in a known-good tab is the difference between a
  // recoverable hiccup and a dump that silently vanishes.
  await persist({
    status: "running",
    phase: existing ? DUMP_PHASE.RETRYING_IN_NEW_TAB : DUMP_PHASE.RESOLVING_TAB,
    ...counts,
  });

  let opened;
  try {
    opened = await openHubbleTab();
    log("tabdump-tab-opened", { tabId: opened.tabId, windowId: opened.windowId, loadOutcome: opened.loadOutcome });
  } catch (err) {
    // chrome.tabs.create itself failed — distinct from a *found* tab simply
    // not answering, so this never gets misreported as "Hubble didn't
    // respond".
    const result = {
      ok: false,
      status: "error",
      reason: "tab-open-failed",
      ...counts,
      detail: errorMessage(err),
    };
    log("tabdump-tab-open-failed", result.detail);
    await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    return { result };
  }

  await persist({ status: "running", phase: DUMP_PHASE.DELIVERING, ...counts });
  const attempt = await deliverImportToTab(opened.tabId, importId, wire, {
    windowId: opened.windowId,
    phase: DUMP_PHASE.DELIVERING,
  });
  log("delivery-attempted", { tabId: opened.tabId, ...attempt });

  if (attempt.delivered) {
    return finishDelivered(attempt, opened.tabId, opened.windowId);
  }

  // A tab that never reached `status: "complete"` is a materially different
  // diagnosis from one that loaded and then didn't answer: it means the
  // Hubble origin itself couldn't be reached (offline, DNS, a captive
  // portal, a deployment that's down), which no amount of retrying in-page
  // will fix. Reporting the load timeout instead of the downstream "no
  // content script answered" is the difference between an actionable error
  // and a misleading one.
  const timedOutLoading = opened.loadOutcome === "timeout";
  const result = {
    ok: false,
    status: "error",
    reason: timedOutLoading ? "tab-load-timeout" : attempt.reason,
    ...counts,
    detail: timedOutLoading
      ? `${TABDUMP_ORIGIN} did not finish loading within ${TAB_READY_TIMEOUT_MS}ms.`
      : attempt.detail,
    focusTabId: opened.tabId,
    focusWindowId: opened.windowId,
  };
  await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
  log("dump-finished", result);
  return { result };

  async function finishDelivered(attempt, tabId, windowId) {
    // Acked, but with nothing taken: the app received the batch and parsed
    // zero usable tabs out of it. That is a failure, not a success with a
    // zero — reporting it as "Dumped 0 tabs" is exactly the kind of
    // false-positive this whole handshake exists to eliminate.
    // Into a project, a tab that is already one of its sources is not a failure: it is already there.
    const duplicates = target ? attempt.duplicates ?? 0 : 0;
    const nothingImported = attempt.accepted === 0 && duplicates === 0;
    const projectMissing = Boolean(target && attempt.projectMissing);
    const partial = !nothingImported && attempt.accepted + duplicates < payload.tabs.length;

    const result = {
      ok: !nothingImported,
      status: nothingImported ? "error" : partial ? "partial" : "done",
      ...counts,
      accepted: attempt.accepted,
      ...(duplicates > 0 ? { alreadyInProject: duplicates } : {}),
      ...(target ? { target } : {}),
      ...(nothingImported ? { reason: projectMissing ? "project-missing" : "nothing-imported" } : {}),
      focusTabId: tabId,
      focusWindowId: windowId,
    };
    await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    log("dump-finished", result);
    // The addresses and titles go back to quick add (to name the source and follow its reading) but never into the persisted record.
    return { result, urls: payload.tabs.map((tab) => tab.url), titles: payload.tabs.map((tab) => tab.title ?? "") };
  }
}

// Calling sendResponse on a message port whose other end (the popup) has
// already closed throws in some Chrome versions — without this guard, that
// throw would propagate out of the .then() below, land in the trailing
// .catch(), and call sendResponse a *second* time with a different payload.
// The dump's real result was already computed either way; a dead port just
// means nobody's listening for it anymore (see setDumpState/DUMP_STATE_KEY
// for how a freshly reopened popup recovers that result instead).
function safeSendResponse(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (err) {
    log("send-response-failed", errorMessage(err));
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG_DUMP_TABS && message?.type !== MSG_ADD_TO_PROJECT) return undefined;

  if (activeDump) {
    log("dump-rejected-already-running", {});
    safeSendResponse(sendResponse, { ok: false, status: "error", reason: "already-running", count: 0 });
    return true;
  }

  // "Add to project" (Hubble 2.0) is the same run with a scope and a target: one delivery path, one ack.
  if (message.type === MSG_ADD_TO_PROJECT && !readTarget(message.payload?.target)) {
    safeSendResponse(sendResponse, { ok: false, status: "error", reason: "no-project", count: 0 });
    return true;
  }
  const run = (
    message.type === MSG_ADD_TO_PROJECT
      ? dumpTabs(undefined, message.payload?.windowId, { scope: message.payload?.scope, tabIds: message.payload?.tabIds, target: message.payload?.target })
      : dumpTabs(message.payload?.excludeUrls, message.payload?.windowId)
  )
    .then(({ result }) => {
      // Nothing else happens after this. Activating or focusing the Hubble
      // tab from here would close the popup the instant Chrome noticed the
      // foreground tab change — routinely before the popup had rendered this
      // very result, which is what made a working dump look like "Dumping
      // tabs…, then the popup vanished and nothing happened". Focus is now
      // the popup's own call, once it has something on screen; see
      // MSG_FOCUS_TABDUMP below and popup.js's finishWithSuccess.
      safeSendResponse(sendResponse, result);
    })
    .catch((err) => {
      console.error("Hubble: dumpTabs failed", err);
      const result = { ok: false, status: "error", reason: "unexpected-error", count: 0, detail: errorMessage(err) };
      safeSendResponse(sendResponse, result);
      setDumpState({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    })
    .finally(() => {
      activeDump = null;
    });

  activeDump = run;
  return true; // keep the message channel open for the async sendResponse
});

/**
 * Popup-driven activation of the Hubble tab, sent once the popup has
 * rendered a dump's outcome and is about to close itself. Validated rather
 * than trusted: the ids come back through the popup, so they're re-checked
 * for shape here before reaching chrome.tabs/chrome.windows.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG_FOCUS_TABDUMP) return undefined;

  const { tabId, windowId } = message.payload ?? {};
  if (!Number.isInteger(tabId)) {
    safeSendResponse(sendResponse, { ok: false, reason: "invalid-tab-id" });
    return undefined;
  }

  (async () => {
    try {
      await chrome.tabs.update(tabId, { active: true });
      if (Number.isInteger(windowId)) await chrome.windows.update(windowId, { focused: true });
      safeSendResponse(sendResponse, { ok: true });
    } catch (err) {
      // The tab or window has been closed since the dump finished. Reported
      // rather than swallowed, though the popup treats it as non-fatal — the
      // dump itself already succeeded and its result is what matters.
      log("focus-failed", errorMessage(err));
      safeSendResponse(sendResponse, { ok: false, reason: "focus-failed", detail: errorMessage(err) });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});

// Answers "which of these urls are already in the currently selected
// workspace?" by relaying to an *already open* Hubble tab's content
// script — deliberately never opens or focuses one just to check, since
// that would be a surprising side effect of simply opening the popup.
// Genuinely unknowable without an open tab (or if the page doesn't answer
// in time), in which case the popup falls back to its plain wording.
async function checkImported(urls) {
  const existing = pickIngestibleTab(await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` }));
  if (!existing) return { ok: false, reason: "no-tabdump-tab" };

  function ask() {
    return chrome.tabs.sendMessage(existing.id, { type: MSG_CHECK_IMPORTED, payload: { urls } });
  }

  try {
    return (await ask()) ?? { ok: false, reason: "no-response" };
  } catch (err) {
    // Same pre-install tab, same repair as the dump path: without it the
    // popup quietly loses its "31 new · 16 already imported" breakdown on
    // exactly the tabs a new user has open, and falls back to plain counts
    // for a reason nothing records.
    if (!isMissingReceiverError(err) || !(await ensureContentScriptInjected(existing.id))) {
      return { ok: false, reason: isMissingReceiverError(err) ? "content-script-missing" : "delivery-failed" };
    }
    try {
      return (await ask()) ?? { ok: false, reason: "no-response" };
    } catch {
      return { ok: false, reason: "content-script-missing" };
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG_CHECK_IMPORTED) return undefined;

  checkImported(message.payload?.urls ?? [])
    .then((response) => safeSendResponse(sendResponse, response))
    .catch(() => safeSendResponse(sendResponse, { ok: false, reason: "unexpected-error" }));

  return true; // keep the message channel open for the async sendResponse
});

/**
 * Ask Tabs browser control: the single dispatch point for every
 * TABDUMP_BROWSER_COMMAND relayed up from content-script.js. Two checks
 * happen before any chrome.* API is touched, in order: (1) is `action` one
 * of the allowlisted names in BROWSER_ACTION_HANDLERS at all, and (2) does
 * `args` pass that action's own validator. A content script (or, further
 * back, the web page) is never trusted just because the message arrived
 * through the expected channel — see AGENTS.md section 14.
 */
async function handleBrowserCommand({ id, action, args }, sender) {
  const senderTabId = sender?.tab?.id;
  const validated = validateBrowserCommand(action, args);
  if (!validated.ok) {
    return { id, ok: false, error: validated.error };
  }
  // Context detection answers only Hubble's own page (top frame, Hubble's origin) — never a frame or another site.
  // Nor a Hubble tab in a private window: what Chrome keeps for context is the ordinary profile's, never the private one's.
  if (CONTEXT_ACTIONS.includes(action) && (!fromHubblePage(sender) || sender?.tab?.incognito === true)) {
    return { id, ok: false, error: "Only Hubble can ask for this." };
  }

  const handler = CONTEXT_HANDLERS[action] ?? BROWSER_ACTION_HANDLERS[action];
  if (!handler) {
    // Unreachable in practice (validateBrowserCommand's allowlist and this
    // handler map are drawn from the same action names), but a defensive
    // fallback beats ever assuming a validated name is dispatchable.
    return { id, ok: false, error: `No handler registered for "${action}".` };
  }

  try {
    // senderTabId is only meaningful to openUrl's reuseCurrentTab handling
    // (see browser-actions.js) — every other handler ignores this second arg.
    const result = await handler(validated.args, { senderTabId });
    return { id, ok: true, result };
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : "Browser command failed." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== MSG_BROWSER_COMMAND) return undefined;

  const payload = message.payload ?? {};
  if (typeof payload.id !== "string" || typeof payload.action !== "string") {
    safeSendResponse(sendResponse, {
      id: typeof payload.id === "string" ? payload.id : "",
      ok: false,
      error: "Malformed browser command.",
    });
    return undefined;
  }

  handleBrowserCommand(payload, sender)
    .then((response) => safeSendResponse(sendResponse, response))
    .catch(() => safeSendResponse(sendResponse, { id: payload.id, ok: false, error: "Unexpected error running browser command." }));

  return true; // keep the message channel open for the async sendResponse
});

// ---------------------------------------------------------------------------
// Quick add (Hubble 2.0): the tab you are on → your Hubble project, without
// the popup. Three entry points, one run:
//
//   right-click a tab in the tab strip → "Add to History IA"   (contexts: tab)
//   right-click the page itself        → "Add to History IA"   (contexts: page)
//   the keyboard shortcut (Alt+Shift+H by default)
//
// Each is the same dumpTabs() run the popup's "Add to project" makes — same
// delivery, same ack, same source-ingestion pipeline in the page, same
// duplicate detection — with feedback shown where the person is: a small
// toast in the page they are looking at (allowed there by activeTab, because
// they just used the menu or the shortcut), falling back to the toolbar
// badge on pages Chrome does not let extensions touch.
//
// This is the closest supported stand-in for dragging a tab out of the tab
// strip onto Hubble, which Chrome does not expose: see quick-add.js.
// ---------------------------------------------------------------------------

async function storedTarget() {
  try {
    const stored = await chrome.storage.local.get(TARGET_PROJECT_KEY);
    return readStoredTarget(stored?.[TARGET_PROJECT_KEY]);
  } catch {
    return undefined;
  }
}

function lastErrorIgnored() {
  // Reading lastError is what tells Chrome the failure was handled (a menu that already exists, a removed one).
  void chrome.runtime.lastError;
}

/**
 * (Re)creates the menu items: "Add to <project>" (Hubble Web), and — once
 * Hubble Desktop has been seen on this computer — "Add to Hubble Desktop".
 * With both, Chrome groups them under one "Hubble" entry.
 */
async function refreshMenus() {
  if (!chrome.contextMenus) return;
  const title = menuTitle(await storedTarget());
  const desktop = await desktopSeen();
  await new Promise((resolve) => chrome.contextMenus.removeAll(() => resolve(lastErrorIgnored())));
  chrome.contextMenus.create({ id: MENU_ADD_TAB, title, contexts: ["tab"] }, lastErrorIgnored);
  chrome.contextMenus.create({ id: MENU_ADD_PAGE, title, contexts: ["page"], documentUrlPatterns: ["http://*/*", "https://*/*"] }, lastErrorIgnored);
  if (!desktop) return;
  chrome.contextMenus.create({ id: MENU_DESKTOP_TAB, title: "Add to Hubble Desktop", contexts: ["tab"] }, lastErrorIgnored);
  chrome.contextMenus.create({ id: MENU_DESKTOP_WINDOW, title: "Add all tabs in this window to Hubble Desktop", contexts: ["tab"] }, lastErrorIgnored);
  chrome.contextMenus.create({ id: MENU_DESKTOP_PAGE, title: "Add to Hubble Desktop", contexts: ["page"], documentUrlPatterns: ["http://*/*", "https://*/*"] }, lastErrorIgnored);
}

chrome.runtime.onInstalled?.addListener(() => void refreshMenus().then(noticeDesktop));
chrome.runtime.onStartup?.addListener(() => void refreshMenus().then(noticeDesktop));
chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === "local" && (changes?.[TARGET_PROJECT_KEY] || changes?.[DESKTOP_SEEN_KEY])) void refreshMenus();
});

let badgeTimer;

/** For pages a toast cannot be shown on (chrome://, the Web Store, a PDF viewer): the toolbar icon says it instead. */
async function showBadge(toast) {
  if (!chrome.action) return;
  clearTimeout(badgeTimer);
  try {
    await chrome.action.setBadgeBackgroundColor({ color: toast.tone === "error" ? "#c62828" : toast.tone === "working" ? "#6b6b6b" : "#1a7f37" });
    await chrome.action.setBadgeText({ text: toast.tone === "error" ? "!" : toast.tone === "working" ? "…" : "✓" });
    await chrome.action.setTitle({ title: [toast.title, toast.source, toast.detail, toast.status].filter(Boolean).join(" — ") });
  } catch {
    return;
  }
  if (toast.tone === "working") return;
  badgeTimer = setTimeout(() => {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    chrome.action.setTitle({ title: "Hubble" }).catch(() => {});
  }, 6000);
}

/** Shows (or updates) the toast in `tabId`. Resolves whether the page could show it. */
async function showToast(tabId, toast) {
  if (Number.isInteger(tabId) && chrome.scripting?.executeScript) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: showQuickAddToast, args: [toast] });
      return true;
    } catch (err) {
      log("quick-add-toast-unavailable", { tabId, detail: errorMessage(err) });
    }
  }
  await showBadge(toast);
  return false;
}

/** Statuses as the page reported them, re-checked: a known status and an optional short reason each. */
function readStatuses(raw) {
  if (!Array.isArray(raw)) return undefined;
  const known = new Set(["pending", "processing", "ready", "partial", "failed"]);
  return raw
    .filter((entry) => entry && known.has(entry.status))
    .slice(0, 50)
    .map((entry) => ({ status: entry.status, ...(typeof entry.detail === "string" && entry.detail ? { detail: entry.detail.slice(0, 160) } : {}) }));
}

async function askSourceStatus(hubbleTabId, workspaceId, urls) {
  try {
    const response = await chrome.tabs.sendMessage(hubbleTabId, { type: MSG_SOURCE_STATUS, payload: { workspaceId, urls } });
    return response?.ok ? readStatuses(response.statuses) : undefined;
  } catch {
    return undefined;
  }
}

// Each quick add owns the toast until the next one starts; a stale follow-up stops writing.
let quickAddGeneration = 0;

/**
 * Keeps the toast saying how reading is going, in the project home's own
 * words, until every source has settled or the budget runs out (then Hubble
 * itself has the rest):
 *
 *   ◌ Adding to History IA…        →   ✓ Added to History IA
 *     Britannica — Cuban crisis           Britannica — Cuban crisis
 *     Reading source…                     Ready · 1,840 words
 */
async function followReading({ generation, toastTabId, hubbleTabId, workspaceId, urls, reading, done }) {
  const deadline = Date.now() + SOURCE_STATUS_POLL_LIMIT_MS;
  let shown = reading.status;
  while (generation === quickAddGeneration) {
    const statuses = await askSourceStatus(hubbleTabId, workspaceId, urls);
    if (generation !== quickAddGeneration) return;
    const line = describeStatuses(statuses);
    const settled = statusesSettled(statuses);
    const timedOut = Date.now() >= deadline;
    // No answer, or Hubble holds none of these addresses as sources: nothing more to follow from here.
    if (!statuses || statuses.length === 0 || settled || timedOut) {
      const status = settled
        ? line
        : !timedOut
          ? "Hubble is reading it now."
          : line && !line.startsWith("Reading")
            ? `${line} · see the rest in Hubble`
            : "Still reading. See its status in Hubble.";
      await showToast(toastTabId, { ...done, status, dismissAfterMs: 6000 });
      return;
    }
    if (line && line !== shown) {
      shown = line;
      await showToast(toastTabId, { ...reading, status: line });
    }
    await sleep(SOURCE_STATUS_POLL_MS);
  }
}

/**
 * One quick add. `tabIds` names exact tabs; otherwise `scope: "selected"`
 * takes the window's selected tabs (just the active one when nothing else is
 * selected). `toastTabId` is the tab the person is looking at.
 */
async function quickAdd({ scope, tabIds, windowId, toastTabId }) {
  const generation = ++quickAddGeneration;
  const target = await storedTarget();
  if (!target) {
    await showToast(toastTabId, { ...describeOutcome({ ok: false, reason: "no-project" }), dismissAfterMs: 7000 });
    return { ok: false, reason: "no-project" };
  }
  const named = { workspaceId: target.id, name: target.name };
  if (activeDump) {
    await showToast(toastTabId, { ...describeOutcome({ ok: false, reason: "already-running", target: named }), dismissAfterMs: 5000 });
    return { ok: false, reason: "already-running" };
  }

  await showToast(toastTabId, describeAdding(named));
  const run = dumpTabs(undefined, windowId, { scope, tabIds, target: named, via: "quick-add" });
  activeDump = run;
  let outcome;
  try {
    outcome = await run;
  } catch (err) {
    outcome = { result: { ok: false, status: "error", reason: "unexpected-error", detail: errorMessage(err) } };
  } finally {
    activeDump = null;
  }

  const { result, urls, titles } = outcome;
  // One source: say which, by the title Chrome showed on its tab.
  const source = urls?.length === 1 && titles?.[0] ? titles[0].slice(0, 160) : undefined;
  const focus = Number.isInteger(result.focusTabId) ? { tabId: result.focusTabId, windowId: result.focusWindowId } : undefined;
  // Every outcome names the project, including failures that happen before the run knows its target.
  const done = { ...describeOutcome({ ...result, target: result.target ?? named }), ...(source ? { source } : {}), ...(focus ? { focus } : {}) };
  // Only a new source has reading to follow; a duplicate was read when it first came in.
  if (done.tone !== "done" || !focus || !urls?.length) {
    await showToast(toastTabId, { ...done, dismissAfterMs: result.ok ? 6000 : 8000 });
    return result;
  }
  const reading = { ...describeAdding(named), ...(source ? { source } : {}), ...(done.detail ? { detail: done.detail } : {}), status: "Reading source…", focus };
  const visible = await showToast(toastTabId, reading);
  // No toast to keep current (a Chrome page): the toolbar icon says it was added, and Hubble shows the reading.
  if (!visible) {
    await showToast(toastTabId, { ...done, dismissAfterMs: 6000 });
    return result;
  }
  await followReading({ generation, toastTabId, hubbleTabId: focus.tabId, workspaceId: target.id, urls, reading, done });
  return result;
}

async function activeTabIn(windowId) {
  try {
    const [tab] = await chrome.tabs.query(Number.isInteger(windowId) ? { active: true, windowId } : { active: true, lastFocusedWindow: true });
    return tab;
  } catch {
    return undefined;
  }
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_DESKTOP_TAB || info.menuItemId === MENU_DESKTOP_WINDOW || info.menuItemId === MENU_DESKTOP_PAGE) {
    const context = info.menuItemId === MENU_DESKTOP_PAGE ? "page" : "tab";
    const selection = info.menuItemId === MENU_DESKTOP_WINDOW ? { scope: "window", windowId: tab?.windowId } : menuScope(tab, context);
    (async () => {
      const toastTabId = context === "page" ? tab?.id : (await activeTabIn(selection.windowId))?.id;
      await runDesktopAdd({ ...selection, toastTabId });
    })().catch((err) => log("desktop-add-failed", errorMessage(err)));
    return;
  }
  if (info.menuItemId !== MENU_ADD_TAB && info.menuItemId !== MENU_ADD_PAGE) return;
  const context = info.menuItemId === MENU_ADD_TAB ? "tab" : "page";
  const { scope, tabIds, windowId } = menuScope(tab, context);
  (async () => {
    // The toast goes where the person is looking: the window's active tab (a right-clicked tab may be in the background).
    const toastTabId = context === "page" ? tab?.id : (await activeTabIn(windowId))?.id;
    await quickAdd({ scope, tabIds, windowId, toastTabId });
  })().catch((err) => log("quick-add-failed", errorMessage(err)));
});

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== QUICK_ADD_COMMAND) return;
  (async () => {
    const active = tab ?? (await activeTabIn());
    await quickAdd({ scope: "selected", windowId: active?.windowId, toastTabId: active?.id });
  })().catch((err) => log("quick-add-failed", errorMessage(err)));
});

/** The quick-add shortcut as Chrome has it now (the person can change or clear it at chrome://extensions/shortcuts). */
async function quickAddShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((entry) => entry.name === QUICK_ADD_COMMAND)?.shortcut ?? "";
  } catch {
    return "";
  }
}

/**
 * The Hubble page saying which project is on screen (relayed by the content
 * script, so only ever from the Hubble origin). The project the person is
 * looking at in Hubble becomes quick add's target (see resolveTarget).
 * Answered with the shortcut, so Hubble can show the real one.
 */
// Reports from several Hubble tabs land here one at a time, so two arriving together can't write over each other.
let projectsChain = Promise.resolve();

/**
 * Keeps the extension's copy of the person's projects (src/projects-sync.js)
 * current from one Hubble page report. Resolves to the project list the rest
 * of the report should be judged against: the report's own when it is the
 * newest, or the stored one when this tab had not caught up yet.
 */
function recordProjectsReport(payload) {
  const run = projectsChain.then(async () => {
    const report = readProjectsReport(payload);
    // A page from before revisions existed: its list is all there is.
    if (!report) return payload?.projects;
    const stored = readProjectsSnapshot((await chrome.storage.local.get(PROJECTS_SNAPSHOT_KEY))?.[PROJECTS_SNAPSHOT_KEY]);
    const applied = applyProjectsReport(stored, report, Date.now());
    if (!applied.accepted) return applied.reason === "stale" ? stored.projects : report.projects;
    await chrome.storage.local.set({ [PROJECTS_SNAPSHOT_KEY]: applied.snapshot });
    if (applied.changes.length > 0) {
      // Kinds and counts only: never a project's name.
      const counts = {};
      for (const change of applied.changes) counts[change.type] = (counts[change.type] ?? 0) + 1;
      log("projects-changed", { revision: report.revision, projects: report.projects.length, ...counts });
    }
    const deleted = applied.changes.filter((change) => change.type === PROJECT_EVENTS.DELETED).map((change) => change.id);
    if (deleted.length > 0) await captureQueue.projectsDeleted(deleted);
    return report.projects;
  });
  projectsChain = run.catch(() => {});
  return run;
}

async function handleProjectFocus(payload) {
  const stored = await chrome.storage.local.get([TARGET_PROJECT_KEY, HUBBLE_FOCUS_KEY]);
  const previous = readStoredTarget(stored?.[TARGET_PROJECT_KEY]);
  const focus = payload?.focus && typeof payload.focus.id === "string" ? { id: payload.focus.id } : undefined;
  const projects = await recordProjectsReport(payload).catch((err) => {
    log("projects-snapshot-failed", errorMessage(err));
    return payload?.projects;
  });
  const { target, lastFocusId } = resolveTarget({
    stored: previous,
    lastFocusId: typeof stored?.[HUBBLE_FOCUS_KEY] === "string" ? stored[HUBBLE_FOCUS_KEY] : undefined,
    focus,
    projects,
    visible: payload?.visible === true,
  });
  const changed = target?.id !== previous?.id || target?.name !== previous?.name;
  const writes = {
    ...(changed && target ? { [TARGET_PROJECT_KEY]: target } : {}),
    ...(lastFocusId ? { [HUBBLE_FOCUS_KEY]: lastFocusId } : {}),
  };
  if (Object.keys(writes).length > 0) await chrome.storage.local.set(writes);
  if (changed && !target) await chrome.storage.local.remove(TARGET_PROJECT_KEY);
  // A Hubble page that reports is up and holds its projects: any conversation waiting to be saved can go now.
  void flushCaptures("hubble-ready");
  return { ok: true, shortcut: await quickAddShortcut(), ...(target ? { target } : {}) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== MSG_PROJECT_FOCUS) return undefined;
  // Only the Hubble page itself may say what is open in Hubble.
  if (typeof sender?.url !== "string" || !sender.url.startsWith(`${TABDUMP_ORIGIN}/`)) {
    safeSendResponse(sendResponse, { ok: false, reason: "not-hubble" });
    return undefined;
  }
  handleProjectFocus(message.payload)
    .then((response) => safeSendResponse(sendResponse, response))
    .catch((err) => safeSendResponse(sendResponse, { ok: false, reason: "unexpected-error", detail: errorMessage(err) }));
  return true;
});

// ---------------------------------------------------------------------------
// Hubble Desktop: tabs straight into the desktop app, with no website in
// between. Three entry points, one run (src/desktop-add.js):
//
//   right-click a tab  → Hubble ▸ Add to Hubble Desktop / Add all tabs in this window…
//   right-click a page → Hubble ▸ Add to Hubble Desktop
//   the popup          → Hubble Desktop ▸ Add this tab / selected / all
//
// Hubble Desktop open: the batch goes over loopback and Hubble asks which
// project. Closed: hubble://import opens it, and the run waits for it to
// start. Not installed or not answering: the toast says so and offers Hubble
// Web — never a silent nothing. Hubble Web (everything above) is unchanged.
// ---------------------------------------------------------------------------

const DESKTOP_ACTION_LABELS = { retry: "Try again", web: "Open Hubble Web" };

async function desktopSeen() {
  try {
    const stored = await chrome.storage.local.get(DESKTOP_SEEN_KEY);
    return stored?.[DESKTOP_SEEN_KEY] === true;
  } catch {
    return false;
  }
}

async function markDesktopSeen() {
  if (await desktopSeen()) return;
  try {
    // storage.onChanged then adds the Hubble Desktop menu items.
    await chrome.storage.local.set({ [DESKTOP_SEEN_KEY]: true });
  } catch {
    // Not remembered: the menu items wait until the next time.
  }
}

/** A quiet look for Hubble Desktop when Chrome starts, so its menu items appear without opening the popup first. */
async function noticeDesktop() {
  try {
    if (await findDesktop()) await markDesktopSeen();
  } catch {
    // Not open; nothing to show.
  }
}

async function setDesktopState(state) {
  try {
    await chrome.storage?.session?.set({ [DESKTOP_STATE_KEY]: state });
  } catch {
    // Only the popup's view of it; the toast still says how it went.
  }
}

// Where the current desktop add reports, and what it last showed there.
let desktopToastTabId;
let desktopShown;

/**
 * Shows a desktop add's progress or outcome: a toast in the page the person
 * is on (the badge on Chrome's own pages), and the record the popup reads.
 * Called on every poll — which is also what keeps this service worker awake
 * while the person chooses a project — but the toast only changes when its
 * words do.
 */
async function showDesktop(toast) {
  const { final, actions, ...words } = toast;
  const view = {
    ...words,
    ...(actions?.length ? { actions: actions.map((action) => ({ action, label: DESKTOP_ACTION_LABELS[action] ?? action })) } : {}),
    ...(final ? { dismissAfterMs: toast.tone === "error" ? 15000 : 6000 } : {}),
  };
  await setDesktopState({ status: final ? "finished" : "running", toast: view, updatedAt: Date.now() });
  const key = JSON.stringify(view);
  if (key === desktopShown) return;
  desktopShown = key;
  await showToast(desktopToastTabId, view);
}

/**
 * Opens hubble://import, which Windows hands to Hubble Desktop (registered by
 * its installer). Navigating the tab the person is on is what typing the
 * address in the omnibox does: Chrome asks "Open Hubble?" the first time and
 * the page itself stays where it is. The URL carries nothing.
 */
async function launchDesktop() {
  try {
    const tab = Number.isInteger(desktopToastTabId) ? await chrome.tabs.get(desktopToastTabId) : await activeTabIn();
    if (!Number.isInteger(tab?.id)) return false;
    await chrome.tabs.update(tab.id, { url: DESKTOP_LAUNCH_URL });
    return true;
  } catch (err) {
    log("desktop-launch-failed", errorMessage(err));
    return false;
  }
}

async function collectTabs({ scope, tabIds, windowId }) {
  return Array.isArray(tabIds) && tabIds.length > 0 ? getTabs(tabIds.filter(Number.isInteger).slice(0, 500)) : chrome.tabs.query(scopeQuery(scope, windowId));
}

const desktopAdd = createDesktopAdd({
  collectTabs,
  launch: launchDesktop,
  show: showDesktop,
  markSeen: markDesktopSeen,
  wasSeen: desktopSeen,
  fetch: (...args) => globalThis.fetch(...args),
  sleep,
  log,
});

/** Which tabs a run takes, re-checked: a known scope, whole-number ids and a window. */
function readDesktopSelection(raw) {
  const scope = ["current", "selected", "window"].includes(raw?.scope) ? raw.scope : "current";
  const tabIds = Array.isArray(raw?.tabIds) ? raw.tabIds.filter(Number.isInteger).slice(0, 500) : undefined;
  const windowId = Number.isInteger(raw?.windowId) ? raw.windowId : undefined;
  return { scope, ...(tabIds?.length ? { tabIds } : {}), ...(windowId !== undefined ? { windowId } : {}) };
}

async function runDesktopAdd({ toastTabId, ...selection }) {
  desktopToastTabId = toastTabId;
  desktopShown = undefined;
  const last = readDesktopSelection(selection);
  try {
    await chrome.storage?.session?.set({ [DESKTOP_LAST_KEY]: last });
  } catch {
    // Retry then falls back to the person's current tab.
  }
  return desktopAdd(last);
}

/**
 * "Open Hubble Web" after Hubble Desktop couldn't be reached: the same tabs,
 * into the project last open in Hubble on the web (quick add), or — with no
 * project to send to — Hubble Web itself, to choose one.
 */
async function addWithHubbleWeb(last, toastTabId) {
  if (await storedTarget()) return quickAdd({ ...last, toastTabId });
  await chrome.tabs.create({ url: TABDUMP_ORIGIN, active: true });
  return { ok: false, reason: "no-project" };
}

async function lastDesktopSelection() {
  try {
    const stored = await chrome.storage.session.get(DESKTOP_LAST_KEY);
    return readDesktopSelection(stored?.[DESKTOP_LAST_KEY]);
  } catch {
    return readDesktopSelection(undefined);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MSG_DESKTOP_STATUS) {
    (async () => {
      const found = await findDesktop().catch(() => undefined);
      if (found) await markDesktopSeen();
      return { ok: true, available: Boolean(found), conversations: Boolean(found?.conversations), seen: Boolean(found) || (await desktopSeen()) };
    })().then((response) => safeSendResponse(sendResponse, response));
    return true;
  }

  if (message?.type === MSG_ADD_TO_DESKTOP) {
    (async () => {
      const selection = readDesktopSelection(message.payload);
      const toastTabId = (await activeTabIn(selection.windowId))?.id;
      return runDesktopAdd({ ...selection, toastTabId });
    })()
      .then((outcome) => safeSendResponse(sendResponse, outcome))
      .catch((err) => safeSendResponse(sendResponse, { reason: "unexpected-error", detail: errorMessage(err) }));
    return true;
  }

  if (message?.type === MSG_DESKTOP_ACTION) {
    // Only this extension's own toast and popup (a page can't message the extension at all).
    if (sender?.id !== chrome.runtime.id) return undefined;
    const action = message.payload?.action;
    if (action !== "retry" && action !== "web") return undefined;
    (async () => {
      const last = await lastDesktopSelection();
      const toastTabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : (await activeTabIn(last.windowId))?.id;
      return action === "retry" ? runDesktopAdd({ ...last, toastTabId }) : addWithHubbleWeb(last, toastTabId);
    })()
      .then((outcome) => safeSendResponse(sendResponse, outcome ?? { ok: true }))
      .catch((err) => safeSendResponse(sendResponse, { reason: "unexpected-error", detail: errorMessage(err) }));
    return true;
  }

  return undefined;
});

// ---------------------------------------------------------------------------
// Cross-AI memory: the conversation on an AI app's page into a project, and a
// project's knowledge back into an AI app's message box.
//
//   Save        popup -> here -> executeScript(readConversationFromPage) on the
//               tab the person is looking at (allowed by the activeTab grant
//               their click gave) -> Hubble Desktop, when it is open (the
//               person picks the project there; src/desktop-add.js), or else
//               the Hubble page saves it (kind "capture")
//   Search/use  popup -> here -> the Hubble page (kind "search" / "bundle")
//   Insert      popup -> here -> executeScript(insertIntoComposer) on that tab.
//               It types; it never sends.
//
// Every answer the Hubble page gives was re-validated there; every reason a
// step fails comes back to the popup as a reason, never as a success.
// ---------------------------------------------------------------------------

function newRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Sends one request to the Hubble page and resolves to its answer:
 * { ok: true, result } or { ok: false, error }. `openIfMissing` opens Hubble
 * (in the background) when no tab has it — only for something the person
 * just asked for. A page still loading answers "not-ready" and is asked
 * again for a few seconds.
 */
async function askHubblePage(kind, args, { openIfMissing = false } = {}) {
  let tab;
  try {
    tab = pickIngestibleTab(await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` }));
  } catch {
    tab = undefined;
  }
  // Discarded by Chrome (Memory Saver): nothing is running there to answer. Reloaded only for something the person just asked for.
  if (tab?.discarded) {
    if (!openIfMissing) return { ok: false, error: "no-hubble-tab" };
    try {
      await chrome.tabs.reload(tab.id);
      if ((await waitForTabComplete(tab.id)) === "removed") tab = undefined;
    } catch {
      tab = undefined;
    }
  }
  if (!tab) {
    if (!openIfMissing) return { ok: false, error: "no-hubble-tab" };
    try {
      const opened = await openHubbleTab();
      tab = { id: opened.tabId, windowId: opened.windowId };
    } catch {
      return { ok: false, error: "hubble-unreachable" };
    }
  }

  const deadline = Date.now() + PAGE_READY_WAIT_MS;
  let injected = false;
  for (;;) {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: MSG_PAGE_REQUEST, payload: { requestId: newRequestId(), kind, args } });
    } catch (err) {
      // A tab opened before the extension was installed has no content script: repaired once, as for a dump.
      if (!injected && isMissingReceiverError(err) && (await ensureContentScriptInjected(tab.id))) {
        injected = true;
        continue;
      }
      response = undefined;
    }
    const retry = !response || response.error === "not-ready";
    if (!retry) return { ...response, hubbleTabId: tab.id };
    if (Date.now() >= deadline) return { ok: false, error: response ? "not-ready" : "no-response" };
    await sleep(500);
  }
}

// What each AI app's tab last showed of its desktop save: each save reports in its own tab, so two at once never cross.
const saveShown = new Map();

/** A desktop save's progress or outcome, as a toast in the AI app's page `tabId` — only when its words change. */
async function showSaveToast(tabId, toast) {
  const { final, ...words } = toast;
  const view = { ...words, ...(final ? { dismissAfterMs: toast.tone === "error" ? 15000 : 6000 } : {}) };
  const key = JSON.stringify(view);
  if (saveShown.get(tabId) === key) return;
  saveShown.set(tabId, key);
  if (final) saveShown.delete(tabId);
  await showToast(tabId, view);
}

const desktopSave = createDesktopSave({
  show: async () => {},
  fetch: (...args) => globalThis.fetch(...args),
  sleep,
  log,
});

/**
 * A desktop save's outcome as the popup takes a save's answer: what was
 * saved and where, or a reason it turns into words.
 */
function answerFromDesktop(outcome) {
  if (outcome.status === "done" && outcome.saved) {
    return { ok: true, result: { outcome: outcome.saved, turns: outcome.turns, truncated: outcome.truncated, project: outcome.project, desktop: true } };
  }
  const reason = outcome.status ?? outcome.reason;
  return { ok: false, error: ["cancelled", "expired", "failed", "done"].includes(reason) ? `desktop-${reason === "done" ? "failed" : reason}` : reason };
}

// The conversations being saved right now, by identity (conversationIdentityOf): the same one twice is refused
// while the first is still on its way, and any other conversation — from the same app or not — is never held up.
const capturesInFlight = new Set();

/**
 * Saves the conversation in `tabId`: to Hubble Desktop when it is open (the
 * person picks the project there), otherwise to `workspaceId` through the
 * Hubble page, as before.
 *
 * `expectedKey` is the conversation the popup showed. When the tab has moved
 * to another conversation since (a chat switched inside the app, back or
 * forward), nothing is saved and the popup is told (`tab-changed`), so a
 * click on "Save" for one chat never saves a different one.
 */
async function captureConversation({ tabId, workspaceId, expectedKey }) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "tab-gone" };
  }
  if (!tab?.url || !aiProviderOf(tab.url)) return { ok: false, error: "not-supported" };
  const identity = conversationIdentityOf(tab.url);
  if (!identity) return { ok: false, error: "not-a-conversation" };
  if (expectedKey !== undefined && expectedKey !== identity.key) return { ok: false, error: "tab-changed" };
  if (capturesInFlight.has(identity.key)) return { ok: false, error: "already-saving" };
  capturesInFlight.add(identity.key);
  try {
    return await captureIdentified(tabId, tab, identity, workspaceId);
  } finally {
    capturesInFlight.delete(identity.key);
  }
}

async function captureIdentified(tabId, tab, identity, workspaceId, { viaDesktop = true } = {}) {
  let read;
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readConversationFromPage });
    read = injection?.result;
  } catch (err) {
    log("capture-read-failed", { detail: errorMessage(err) });
    return { ok: false, error: "page-unreadable" };
  }
  const checked = checkPageRead(read);
  // Counts and reasons only: what the conversation says is never logged.
  if (!checked.ok) {
    // A null result is Chrome swallowing an error thrown in the page; `detail` is the reader's own error, never page text.
    log("capture-read-refused", { reason: checked.error, provider: aiProviderOf(tab.url), detail: typeof read?.detail === "string" ? read.detail : read == null ? "no result" : undefined });
    return { ok: false, error: checked.error };
  }
  // The page moved to another conversation while it was read (a chat switched in the app): what was read may be
  // either chat's, so nothing is saved.
  if (typeof read?.url === "string" && conversationIdentityOf(read.url)?.key !== identity.key) {
    log("capture-read-moved", { provider: identity.provider });
    return { ok: false, error: "tab-changed" };
  }
  log("capture-read", { provider: identity.provider, turns: checked.turns.length, partial: checked.partial });
  // The address Chrome reports wins over the page's own: it is what the person is looking at.
  const capture = { url: tab.url, title: checked.title || tab.title || "", turns: checked.turns };

  // A save Hubble on the web asked for (context suggestions) stays with Hubble on the web.
  if (viaDesktop) {
    saveShown.delete(tabId);
    const sentToDesktop = await desktopSave(
      { ...capture, provider: identity.provider, key: identity.key, truncated: read?.truncated === true },
      { show: (toast) => showSaveToast(tabId, toast) }
    );
    if (!sentToDesktop.fallback) {
      return withReadNotes(answerFromDesktop(sentToDesktop), checked);
    }
  }
  // Hubble Desktop isn't open: Hubble on the web, into the project chosen in the popup — as a job that is written
  // down before it is delivered, so a closed popup, a stopped worker or a Hubble page that answers late loses nothing.
  if (!workspaceId) return { ok: false, error: "no-project" };
  const notes = { ...(checked.olderNotLoaded ? { olderNotLoaded: true } : {}), ...(checked.partial ? { partial: true } : {}) };
  const job = await captureQueue.submit({ key: identity.key, provider: identity.provider, workspaceId, projectName: await snapshotProjectName(workspaceId), capture, truncated: read?.truncated === true, notes });
  return answerFromJob(job);
}

/** What was saved was what was on screen; the popup says when that was not the whole chat. */
function withReadNotes(answer, checked) {
  if (!answer?.ok || !(checked.olderNotLoaded || checked.partial)) return answer;
  return { ...answer, result: { ...answer.result, ...(checked.olderNotLoaded ? { olderNotLoaded: true } : {}), ...(checked.partial ? { partial: true } : {}) } };
}

/**
 * A save job's state as the popup takes a save's answer. `ok: true` only for a
 * job the Hubble page said is on disk; one still waiting says so (`queued`)
 * along with why its last delivery failed, so the popup never shows "Saved"
 * for something that is merely on its way.
 */
function answerFromJob(job) {
  if (!job || (!job.status && job.error)) return { ok: false, error: job?.error ?? "failed" };
  const view = publicJob(job);
  const hubble = job.hubbleTabId !== undefined ? { hubbleTabId: job.hubbleTabId } : {};
  if (job.status === "saved") return { ok: true, result: { ...job.result, ...(job.notes ?? {}) }, job: view, ...hubble };
  return { ok: false, error: job.error ?? "failed", job: view, ...(job.status === "queued" || job.status === "saving" ? { queued: true } : {}), ...hubble };
}

/** A project's name as Hubble last reported it, so a save reopened later can still say where it went. */
async function snapshotProjectName(workspaceId) {
  return (await projectsSnapshot())?.projects.find((project) => project.id === workspaceId)?.name;
}

async function projectsSnapshot() {
  try {
    return readProjectsSnapshot((await chrome.storage.local.get(PROJECTS_SNAPSHOT_KEY))?.[PROJECTS_SNAPSHOT_KEY]);
  } catch {
    return undefined;
  }
}

// chrome.storage.local, when this Chrome has it; the queue keeps working from memory when it doesn't.
const captureStorage = {
  get: async () => {
    const local = globalThis.chrome?.storage?.local;
    return local ? (await local.get(CAPTURE_JOBS_KEY))?.[CAPTURE_JOBS_KEY] : undefined;
  },
  set: async (jobs) => {
    await globalThis.chrome?.storage?.local?.set({ [CAPTURE_JOBS_KEY]: jobs });
  },
};

let captureRetryTimer;

/**
 * Wakes the queue for its next retry: a timer while this worker is awake, and
 * an alarm in case Chrome stops the worker first (alarms are never sooner than
 * 30 seconds, so the timer does the short waits).
 */
function scheduleCaptureRetry(at) {
  clearTimeout(captureRetryTimer);
  captureRetryTimer = setTimeout(() => void flushCaptures("timer"), Math.max(0, at - Date.now()));
  try {
    globalThis.chrome?.alarms?.create(CAPTURE_RETRY_ALARM, { when: Math.max(at, Date.now() + 30000) })?.catch?.(() => {});
  } catch {
    // No alarms: the timer, the next Hubble page report and the next worker start still deliver it.
  }
}

const captureQueue = createCaptureQueue({
  storage: captureStorage,
  deliver: (job, { openIfMissing }) => askHubblePage("capture", { workspaceId: job.workspaceId, captureId: job.id, capture: job.capture }, { openIfMissing }),
  schedule: scheduleCaptureRetry,
  isProjectKnown: async (workspaceId) => Boolean((await projectsSnapshot())?.projects.some((project) => project.id === workspaceId)),
  newId: newRequestId,
  log,
});

function flushCaptures(reason) {
  return captureQueue.flush({ reason }).catch((err) => log("capture-flush-failed", { reason, detail: errorMessage(err) }));
}

// Registered at module scope, as MV3 requires for an event that wakes a stopped worker.
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === CAPTURE_RETRY_ALARM) void flushCaptures("alarm");
});

// A fresh worker (Chrome started, or the last one was stopped mid-save): pick up whatever was left waiting.
void captureQueue
  .reconcile()
  .then(() => flushCaptures("startup"))
  .catch((err) => log("capture-reconcile-failed", errorMessage(err)));

async function insertContext({ tabId, text }) {
  if (typeof text !== "string" || text.length === 0 || text.length > 200000) return { inserted: false, reason: "invalid" };
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { inserted: false, reason: "tab-gone" };
  }
  if (!tab?.url || !aiProviderOf(tab.url)) return { inserted: false, reason: "not-supported" };
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: insertIntoComposer, args: [text] });
    return injection?.result ?? { inserted: false, reason: "not-inserted" };
  } catch (err) {
    log("insert-failed", { detail: errorMessage(err) });
    return { inserted: false, reason: "page-unreadable" };
  }
}

const MEMORY_KINDS = new Set(["projects", "saved", "search", "bundle", "reused"]);

/**
 * Sessions: "Save session" from the popup. Reads the tabs of the popup's
 * window (or every ordinary window), then asks the Hubble page to store them
 * — opening Hubble in the background when no tab has it, since the person
 * just asked. Success is only ever Hubble's answer that it stored them.
 */
async function saveSession({ windowId, allWindows, name, workspaceId }) {
  let windows;
  try {
    windows = allWindows ? await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }) : [await chrome.windows.get(windowId, { populate: true })];
  } catch (err) {
    log("session-read-failed", { detail: errorMessage(err) });
    return { ok: false, error: "window-unreadable" };
  }
  if (!allWindows && windows[0]?.incognito) return { ok: false, error: "private-window" };
  const { tabs, restricted, privateTabs, tooMany } = buildSessionCapture(windows, TABDUMP_ORIGIN);
  const leftOut = { restricted, privateTabs, tooMany };
  if (tabs.length === 0) return { ok: false, error: "empty", leftOut };
  const answer = await askHubblePage("save-session", { tabs, ...(name ? { name } : {}), ...(workspaceId ? { workspaceId } : {}) }, { openIfMissing: true });
  if (!answer.ok) return { ok: false, error: answer.error, leftOut };
  const saved = answer.result ?? {};
  return {
    ok: true,
    session: { name: typeof saved.name === "string" ? saved.name : "", tabs: Number.isInteger(saved.tabs) ? saved.tabs : 0 },
    leftOut: { ...leftOut, dropped: Number.isInteger(saved.dropped) ? saved.dropped : 0 },
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own popup: a page can't message the extension, and a content script isn't asked to.
  if (sender?.id !== chrome.runtime.id || sender?.tab) return undefined;

  if (message?.type === MSG_CAPTURE_CONVERSATION) {
    const tabId = message.payload?.tabId;
    const workspaceId = message.payload?.workspaceId;
    const expectedKey = message.payload?.expectedKey;
    // No project is fine: Hubble Desktop asks for one. Hubble on the web needs one (captureConversation says so).
    if (
      !Number.isInteger(tabId) ||
      (workspaceId !== undefined && (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 200)) ||
      (expectedKey !== undefined && (typeof expectedKey !== "string" || !expectedKey || expectedKey.length > 300))
    ) {
      safeSendResponse(sendResponse, { ok: false, error: "invalid" });
      return undefined;
    }
    captureConversation({ tabId, workspaceId, ...(expectedKey !== undefined ? { expectedKey } : {}) })
      .then((answer) => safeSendResponse(sendResponse, answer))
      .catch((err) => safeSendResponse(sendResponse, { ok: false, error: "failed", detail: errorMessage(err) }));
    return true;
  }

  if (message?.type === MSG_CAPTURE_STATUS) {
    const key = message.payload?.key;
    if (typeof key !== "string" || !key || key.length > 300) {
      safeSendResponse(sendResponse, { ok: false, error: "invalid" });
      return undefined;
    }
    captureQueue
      .forConversation(key)
      .then((job) => safeSendResponse(sendResponse, { ok: true, ...(job ? { job } : {}) }))
      .catch(() => safeSendResponse(sendResponse, { ok: false, error: "failed" }));
    return true;
  }

  if (message?.type === MSG_CAPTURE_RETRY) {
    const id = message.payload?.id;
    if (typeof id !== "string" || !id || id.length > 100) {
      safeSendResponse(sendResponse, { ok: false, error: "invalid" });
      return undefined;
    }
    captureQueue
      .retry(id)
      .then((job) => safeSendResponse(sendResponse, job ? answerFromJob(job) : { ok: false, error: "not-found" }))
      .catch((err) => safeSendResponse(sendResponse, { ok: false, error: "failed", detail: errorMessage(err) }));
    return true;
  }

  if (message?.type === MSG_MEMORY_REQUEST) {
    const kind = message.payload?.kind;
    if (!MEMORY_KINDS.has(kind)) {
      safeSendResponse(sendResponse, { ok: false, error: "invalid" });
      return undefined;
    }
    askHubblePage(kind, message.payload?.args ?? {}, { openIfMissing: message.payload?.openIfMissing === true })
      .then((answer) => safeSendResponse(sendResponse, answer))
      .catch((err) => safeSendResponse(sendResponse, { ok: false, error: "failed", detail: errorMessage(err) }));
    return true;
  }

  if (message?.type === MSG_SAVE_SESSION) {
    const { windowId, allWindows, name, workspaceId } = message.payload ?? {};
    const validName = name === undefined || (typeof name === "string" && name.length <= 500);
    const validProject = workspaceId === undefined || (typeof workspaceId === "string" && workspaceId.length > 0 && workspaceId.length <= 200);
    if ((!allWindows && !Number.isInteger(windowId)) || !validName || !validProject) {
      safeSendResponse(sendResponse, { ok: false, error: "invalid" });
      return undefined;
    }
    saveSession({ windowId, allWindows: allWindows === true, name: name?.trim() || undefined, workspaceId })
      .then((answer) => safeSendResponse(sendResponse, answer))
      .catch((err) => safeSendResponse(sendResponse, { ok: false, error: "failed", detail: errorMessage(err) }));
    return true;
  }

  if (message?.type === MSG_INSERT_CONTEXT) {
    const tabId = message.payload?.tabId;
    if (!Number.isInteger(tabId)) {
      safeSendResponse(sendResponse, { inserted: false, reason: "invalid" });
      return undefined;
    }
    insertContext({ tabId, text: message.payload?.text })
      .then((answer) => safeSendResponse(sendResponse, answer))
      .catch(() => safeSendResponse(sendResponse, { inserted: false, reason: "failed" }));
    return true;
  }

  return undefined;
});

// ---------------------------------------------------------------------------
// Use in AI: a transfer the person started in Hubble — chosen context and
// uploaded files into a new ChatGPT, Claude, Gemini or Perplexity chat
// (src/ai-transfer.js runs it; src/ai-transfer-page.js is each step in the
// AI app's page).
//
//   Hubble page -> content script -> here (only from a Hubble tab) -> runner
//   progress:  runner -> chrome.tabs.sendMessage(that Hubble tab) -> page
//
// Access to an AI app is an optional host permission, asked for the first
// time it is needed, in permissions/grant.html — Chrome only asks from a
// click in an extension page. Nothing the transfer carries is logged.
// ---------------------------------------------------------------------------

/** Waiting permission windows, by opId. */
const permissionWaits = new Map();

function permissionContains(origins) {
  return chrome.permissions.contains({ origins }).catch(() => false);
}

/** Opens the permission window and resolves with the person's answer: "granted", "denied" or "timeout". */
async function requestProviderPermission(provider, origins, opId, purpose = "transfer") {
  let windowId;
  try {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL(`permissions/grant.html?provider=${encodeURIComponent(provider)}&op=${encodeURIComponent(opId)}${purpose === "context" ? "&purpose=context" : ""}`),
      type: "popup",
      width: 480,
      height: 440,
      focused: true,
    });
    windowId = created?.id;
  } catch (err) {
    log("ai-permission-window-failed", { detail: errorMessage(err) });
    return "denied";
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = async (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      permissionWaits.delete(opId);
      chrome.permissions.onAdded?.removeListener(onAdded);
      chrome.windows.onRemoved?.removeListener(onRemoved);
      // The grant itself is the truth, whatever the window said.
      resolve((await permissionContains(origins)) ? "granted" : answer);
    };
    const onAdded = () => {
      void permissionContains(origins).then((has) => has && finish("granted"));
    };
    const onRemoved = (removedId) => {
      if (removedId === windowId) void finish("denied");
    };
    const timer = setTimeout(() => {
      if (Number.isInteger(windowId)) chrome.windows.remove(windowId).catch(() => {});
      void finish("timeout");
    }, TRANSFER_TIMING.permissionMs);
    permissionWaits.set(opId, (granted) => void finish(granted ? "granted" : "denied"));
    chrome.permissions.onAdded?.addListener(onAdded);
    chrome.windows.onRemoved?.addListener(onRemoved);
  });
}

/**
 * Keeps the service worker awake while a transfer waits on a page or on the
 * person (an extension API call resets Chrome's idle timer). The transfer's
 * record in chrome.storage.session is what survives if it stops anyway.
 */
function keepWorkerAlive() {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo?.().catch?.(() => {});
  }, 20000);
  return () => clearInterval(timer);
}

const transfers = createTransferRunner({
  tabs: {
    query: (query) => chrome.tabs.query(query),
    get: (tabId) => chrome.tabs.get(tabId),
    create: (props) => chrome.tabs.create(props),
    update: (tabId, props) => chrome.tabs.update(tabId, props),
  },
  windows: { update: (windowId, props) => chrome.windows.update(windowId, props) },
  hasPermission: permissionContains,
  requestPermission: requestProviderPermission,
  waitForTab: waitForTabComplete,
  step: async (tabId, name, args) => {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: hubbleTransferStep, args: [name, args] });
    return injection?.result;
  },
  store: {
    get: async (key) => (await chrome.storage.session.get(key))?.[key],
    set: (key, value) => chrome.storage.session.set({ [key]: value }),
  },
  now: () => Date.now(),
  log,
  keepAlive: keepWorkerAlive,
});

/** Whether a message came from Hubble's own page (its top frame), the only place a transfer may start. */
function fromHubblePage(sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || (sender.frameId ?? 0) !== 0) return false;
  try {
    return new URL(sender.url || sender.tab.url || "").origin === TABDUMP_ORIGIN;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MSG_AI_PERMISSION_ANSWER) {
    // Only the extension's own permission window answers.
    const page = typeof sender?.url === "string" ? sender.url : "";
    if (sender?.id !== chrome.runtime.id || sender?.tab?.url?.startsWith?.("http") || !page.startsWith(chrome.runtime.getURL("permissions/grant.html"))) return undefined;
    permissionWaits.get(message.payload?.opId)?.(message.payload?.granted === true);
    safeSendResponse(sendResponse, { ok: true });
    return undefined;
  }

  if (message?.type !== MSG_AI_TRANSFER) return undefined;
  const opId = typeof message.payload?.opId === "string" ? message.payload.opId.slice(0, 100) : "";
  if (!fromHubblePage(sender)) {
    safeSendResponse(sendResponse, { opId, ok: false, error: "invalid" });
    return undefined;
  }
  const read = readTransferRequest(message.payload);
  if (!read.ok) {
    safeSendResponse(sendResponse, { opId, ok: false, error: "invalid" });
    return undefined;
  }
  const hubbleTabId = sender.tab.id;
  const report = (state) => {
    chrome.tabs.sendMessage(hubbleTabId, { type: MSG_AI_TRANSFER_PROGRESS, payload: { opId: read.request.opId, state } }).catch(() => {});
  };
  transfers
    .run(read.request, { senderTab: sender.tab, report })
    .then((result) => safeSendResponse(sendResponse, result))
    .catch(() => safeSendResponse(sendResponse, { opId: read.request.opId, ok: false, error: "failed" }));
  return true;
});


// ---------------------------------------------------------------------------
// Context detection (src/context-activity.js): what Chrome shows the person,
// kept so Hubble can suggest which project it belongs to and help them pick
// work up again. Off until they choose in Hubble; every event below is
// checked against that choice before anything is kept.
//
//   tab events ──► collector (chrome.storage.local) ──► HUBBLE_CONTEXT_CHANGED nudge
//   Hubble page ──► get_context_activity / settings / forget / clear (browser commands, Hubble's page only)
//
// Nothing here logs a title, an address or what a page says.
// ---------------------------------------------------------------------------

/** The AI apps whose optional host permission Chrome has granted right now. */
async function grantedContextProviders() {
  const granted = [];
  for (const [provider, config] of Object.entries(TRANSFER_PROVIDERS)) {
    if (await permissionContains(config.origins)) granted.push(provider);
  }
  return granted;
}

let contextNudgeTimer;
/** Tells open Hubble pages that activity changed — at most every few seconds, carrying nothing. */
function nudgeHubblePages() {
  if (contextNudgeTimer) return;
  contextNudgeTimer = setTimeout(async () => {
    contextNudgeTimer = undefined;
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` });
    } catch {
      tabs = [];
    }
    for (const tab of tabs) {
      if (Number.isInteger(tab.id) && !tab.discarded) chrome.tabs.sendMessage(tab.id, { type: "HUBBLE_CONTEXT_CHANGED" }).catch(() => {});
    }
  }, 3000);
}

const contextActivity = createActivityCollector({
  storage: {
    get: async (key) => (await chrome.storage.local.get(key))?.[key],
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
  },
  sessionStorage: chrome.storage?.session
    ? {
        get: async (key) => (await chrome.storage.session.get(key))?.[key],
        set: (key, value) => chrome.storage.session.set({ [key]: value }),
      }
    : undefined,
  now: () => Date.now(),
  newEpoch: newRequestId,
  hubbleOrigin: TABDUMP_ORIGIN,
  hasHostPermission: (provider) => (TRANSFER_PROVIDERS[provider] ? permissionContains(TRANSFER_PROVIDERS[provider].origins) : Promise.resolve(false)),
  readConversation: async (tabId) => {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readConversationFromPage });
    return injection?.result;
  },
  getTab: (tabId) => chrome.tabs.get(tabId).catch(() => undefined),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  notify: nudgeHubblePages,
  log,
});

// A conversation is read a few seconds after it settles, so a reply still streaming in is not half-read.
const CONTEXT_READ_DELAY_MS = 4000;
const contextReadTimers = new Map();
function scheduleContextRead(tab) {
  if (!Number.isInteger(tab?.id) || !conversationIdentityOf(tab.url ?? "")) return;
  clearTimeout(contextReadTimers.get(tab.id));
  contextReadTimers.set(
    tab.id,
    setTimeout(() => {
      contextReadTimers.delete(tab.id);
      void chrome.tabs
        .get(tab.id)
        .then((latest) => latest && contextActivity.maybeReadConversation(latest))
        .catch(() => {});
    }, CONTEXT_READ_DELAY_MS)
  );
}

// Registered at module scope, as MV3 requires for events that wake a stopped worker.
chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (tab?.incognito || changeInfo?.discarded) return;
  if (changeInfo?.status === "complete") {
    // A page that loads in the tab in front is where the person is now (they followed a link or typed an address).
    void contextActivity.observe(tab, { inFront: tab?.active === true }).then((record) => record && scheduleContextRead(tab));
  } else if (typeof changeInfo?.title === "string") {
    contextActivity.observeTitleChange(tabId);
  }
});

chrome.tabs.onActivated?.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then((tab) => contextActivity.observe(tab, { activated: true }).then((record) => record && scheduleContextRead(tab)))
    .catch(() => {});
});

chrome.windows?.onFocusChanged?.addListener((windowId) => {
  // Chrome lost focus: the visit to the tab in front ends here.
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    void contextActivity.observe(null, { activated: true });
    return;
  }
  void chrome.tabs
    .query({ active: true, windowId })
    .then(([tab]) => tab && contextActivity.observe(tab, { activated: true }))
    .catch(() => {});
});

chrome.permissions?.onRemoved?.addListener(() => {
  void grantedContextProviders().then((granted) => contextActivity.permissionsChanged(granted));
});

/** Each open, ordinary, detectable tab: its activity key (for this store) and its address (the page keys it its own way). */
async function openContextKeys(settings) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return { keys: new Set(), urls: [] };
  }
  const keys = new Set();
  const urls = [];
  for (const tab of tabs) {
    if (tab.incognito || typeof tab.url !== "string") continue;
    if (!isDetectable(tab.url, { ...settings, paused: false }, { hubbleOrigin: TABDUMP_ORIGIN })) continue;
    const key = activityKeyOf(tab.url);
    if (key) keys.add(key);
    if (urls.length < 500) urls.push(tab.url);
  }
  return { keys, urls };
}

async function contextSettingsAnswer() {
  const settings = await contextActivity.settings();
  let incognitoAllowed = false;
  try {
    incognitoAllowed = (await chrome.extension?.isAllowedIncognitoAccess?.()) === true;
  } catch {
    incognitoAllowed = false;
  }
  return { settings, granted: await grantedContextProviders(), incognitoAllowed, version: chrome.runtime.getManifest?.().version ?? "" };
}

/** Every open tab, once — the one in front last, so it holds the focus. */
async function observeOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) if (!tab.active) await contextActivity.observe(tab);
  for (const tab of tabs) if (tab.active) await contextActivity.observe(tab, { inFront: true });
}

/**
 * Context ownership. Activity and consent live in this Chrome profile, which
 * several Hubble accounts may use (a shared family or school computer). Every
 * command carries the asking account's random context id (validated in
 * browser-commands.js); only the account that opted in is answered. Another
 * account sees detection as not set up and receives nothing kept; when it
 * opts in itself, what was kept for the previous one is cleared first.
 */
/** Settings as an account is shown them: never which account owns them. */
function withoutOwner(settings) {
  const shown = { ...settings };
  delete shown.owner;
  return shown;
}

function ownsActivity(settings, owner) {
  return typeof settings.owner === "string" && settings.owner === owner;
}

async function contextSettingsFor(owner) {
  const answer = await contextSettingsAnswer();
  if (!answer.settings.owner || answer.settings.owner === owner) return { ...answer, settings: withoutOwner(answer.settings) };
  // Someone else's choice: this account hasn't chosen, and isn't told what the other chose.
  return { ...answer, settings: withoutOwner(readContextSettings(undefined)), otherAccount: true };
}

/** Context detection's commands, after validateBrowserCommand and the Hubble-page check in handleBrowserCommand. */
const CONTEXT_HANDLERS = {
  get_context_settings: ({ owner }) => contextSettingsFor(owner),

  set_context_settings: async ({ settings, owner }) => {
    const before = await contextActivity.settings();
    const patch = withoutOwner(settings);
    // A different account choosing: the previous account's activity goes before anything is kept for this one.
    const transfer = typeof before.owner === "string" && before.owner !== owner;
    if (transfer) await contextActivity.clear();
    const after = transfer
      ? await contextActivity.updateSettings(readContextSettings({ ...patch, owner }), { replace: true })
      : await contextActivity.updateSettings(readContextSettings({ ...before, ...patch, owner }));
    // Just turned on (or resumed, or a new account): the tabs already open are what the person is working on now.
    const detecting = (value) => value.mode !== "off" && !isPaused(value, Date.now());
    if (detecting(after) && (transfer || !detecting(before))) await observeOpenTabs();
    return contextSettingsFor(owner);
  },

  /** Opens the permission window for one AI app; resolves with what Chrome actually granted. */
  request_context_access: async ({ provider }) => {
    const config = TRANSFER_PROVIDERS[provider];
    if (await permissionContains(config.origins)) return { provider, granted: true };
    const answer = await requestProviderPermission(provider, config.origins, newRequestId(), "context");
    const granted = answer === "granted";
    if (granted) void contextActivity.permissionsChanged(await grantedContextProviders());
    return { provider, granted, answer };
  },

  get_context_activity: async ({ since, epoch, owner }) => {
    const settings = await contextActivity.settings();
    // Not this account's activity (or nobody's yet): nothing at all, not even what is open now.
    if (!ownsActivity(settings, owner)) {
      const empty = await contextActivity.list({ since: 0, epoch: "" });
      return { epoch: empty.epoch, seq: 0, reset: true, records: [], removed: [], openUrls: [] };
    }
    // Off or paused: what is open now is not noticed either.
    const noticing = settings.mode !== "off" && !isPaused(settings, Date.now());
    const [changes, open] = await Promise.all([contextActivity.list({ since, epoch }), noticing ? openContextKeys(settings) : { keys: new Set(), urls: [] }]);
    return { ...changes, records: changes.records.map((record) => ({ ...record, open: open.keys.has(record.key) })), openUrls: open.urls };
  },

  forget_context_activity: async ({ keys, owner }) => (ownsActivity(await contextActivity.settings(), owner) ? contextActivity.forget(keys) : { forgotten: 0 }),

  // Clearing is allowed only to the account it belongs to; another account has nothing here to clear.
  clear_context_activity: async ({ owner }) => (ownsActivity(await contextActivity.settings(), owner) ? contextActivity.clear() : { epoch: "not-yours" }),

  /**
   * Saves the open conversation at `url` into `workspaceId` through the same
   * job Save to Hubble uses (read the page → capture queue → the Hubble page
   * saves it). Only with Chrome's permission for that AI app: this runs from
   * a click in Hubble, not in the AI app's tab, so activeTab doesn't apply.
   */
  capture_context_conversation: async ({ url, workspaceId, owner }) => {
    if (!ownsActivity(await contextActivity.settings(), owner)) return { ok: false, error: "not-yours" };
    const identity = conversationIdentityOf(url);
    if (!identity) return { ok: false, error: "not-a-conversation" };
    const config = TRANSFER_PROVIDERS[identity.provider];
    if (!config || !(await permissionContains(config.origins))) return { ok: false, error: "no-permission" };
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      tabs = [];
    }
    const tab = tabs.find((entry) => !entry.incognito && typeof entry.url === "string" && conversationIdentityOf(entry.url)?.key === identity.key);
    if (!tab) return { ok: false, error: "not-open" };
    if (capturesInFlight.has(identity.key)) return { ok: false, error: "already-saving" };
    capturesInFlight.add(identity.key);
    try {
      return await captureIdentified(tab.id, tab, identity, workspaceId, { viaDesktop: false });
    } finally {
      capturesInFlight.delete(identity.key);
    }
  },
};

