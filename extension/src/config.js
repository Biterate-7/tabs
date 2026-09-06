// Local-dev origin. Must match the `host_permissions` entry and the
// `content_scripts` match pattern in manifest.json (manifest patterns are
// static, so those need updating by hand too if this changes).
//
// The production origin is NOT set here — it's substituted into this file's
// copy inside the packaged ZIP at build time, from the single canonical
// CANONICAL_PRODUCTION_ORIGIN in scripts/build-extension-zip.mjs. Change the
// production domain there, not here.
export const TABDUMP_ORIGIN = "http://localhost:3000";

// The one route that mounts TabDump's app shell — and therefore the only
// route whose page can actually ingest a dump. The legal pages (/privacy,
// /terms, /cookies) are served from the same origin, so they match
// `content_scripts`/`host_permissions` and chrome.tabs.query's url filter
// just as well, but they never mount AppShell; a dump handed to one of them
// would land nowhere. findOrOpenTabDumpTab uses this to prefer (and, failing
// that, to open) a tab that can genuinely receive the payload.
//
// This is a preference, never a trust boundary: the real proof that a tab can
// ingest a dump is the ack it sends back (see MSG_TABDUMP_IMPORT_ACK), and a
// tab that doesn't ack falls back to a freshly opened one. So if the web app
// ever grows a second ingesting route, the worst this constant going stale
// can do is open one extra tab — never silently drop a dump.
export const TABDUMP_APP_PATH = "/";

// Message-passing constants shared across background/content/popup so a
// typo in one place can't silently desync from another.
export const MESSAGE_SOURCE = "tabdump-extension";
export const MSG_DUMP_TABS = "DUMP_TABS";
export const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";

// The page's half of the import handshake, posted back to content-script.js
// once the web app has actually taken ownership of a delivered batch —
// carrying the same `importId` the payload arrived with, plus how many tabs
// it accepted.
//
// This exists because "chrome.tabs.sendMessage resolved" only ever proved
// that the *content script* was attached, which says nothing about whether
// the React app behind it was listening yet. It isn't: measured against a
// production build served from localhost, useExtensionImport's `message`
// listener attaches between 1ms and 105ms AFTER the load event — i.e. always
// after the moment chrome.tabs.onUpdated reports `status: "complete"`, which
// is exactly when background.js used to fire the payload. A machine that
// already had a warm, hydrated TabDump tab open reused that tab and landed
// fine; on a fresh machine/profile the tab is always created from scratch,
// the payload lost that race, and the dump reported success with nothing
// imported. The ack is what turns "delivered" into "ingested".
export const MSG_TABDUMP_IMPORT_ACK = "TABDUMP_IMPORT_ACK";

// Posted by the page as soon as it can ingest an import (see
// src/hooks/use-extension-import.ts). content-script.js holds any payload
// that arrived before this and re-posts it on receipt, which is what closes
// the hydration race above rather than merely narrowing it.
export const MSG_TABDUMP_PAGE_READY = "TABDUMP_PAGE_READY";

// Popup → background: "activate and focus this tab now." Focus is the
// popup's call, never a side effect of the dump itself, because Chrome
// dismisses an open action-popup the instant the foreground tab changes — so
// a background-initiated focus routinely destroyed the popup before it could
// render the dump's outcome. See background.js's dumpTabs (which deliberately
// returns focus ids instead of using them) and popup.js's finishWithSuccess.
export const MSG_FOCUS_TABDUMP = "TABDUMP_FOCUS";

// Round-trip query the popup uses to ask the (already-open) TabDump page
// which candidate tabs are already in its currently selected workspace, so
// it can show "31 new · 16 already imported" instead of a raw count. Only
// answerable when a TabDump tab is already open — see background.js's
// checkImported for the fallback when one isn't.
export const MSG_CHECK_IMPORTED = "TABDUMP_CHECK_IMPORTED";
export const MSG_CHECK_IMPORTED_RESULT = "TABDUMP_CHECK_IMPORTED_RESULT";

// Generic typed command bridge for Ask Tabs browser control (see
// src/lib/browser/protocol.ts on the web app side, and browser-commands.js /
// browser-actions.js here for the extension side of this same round trip).
// The page posts a MSG_BROWSER_COMMAND with a unique id + an allowlisted
// action name + typed args; content-script.js relays it to background.js,
// which validates the action/args again (a content script is a transport,
// never a trust boundary) before touching any chrome.* API, then the result
// (or error) comes back tagged with the same id via MSG_BROWSER_COMMAND_RESULT.
export const MSG_BROWSER_COMMAND = "TABDUMP_BROWSER_COMMAND";
export const MSG_BROWSER_COMMAND_RESULT = "TABDUMP_BROWSER_COMMAND_RESULT";

// Connection-liveness ping: the page posts this (once on mount, then on a
// short interval while disconnected) and content-script.js answers
// immediately and entirely on its own — no background/chrome.* round trip
// needed, since the content script only ever runs at all when the extension
// is installed and enabled. That makes the pong itself the "extension is
// present" signal the UI's connection indicator relies on (see
// src/lib/browser/bridge.ts).
export const MSG_EXTENSION_PING = "TABDUMP_EXTENSION_PING";
export const MSG_EXTENSION_PONG = "TABDUMP_EXTENSION_PONG";

// ---------------------------------------------------------------------------
// Timing budgets
//
// Every one of these bounds a specific step that can genuinely hang, and the
// staleness thresholds below are DERIVED from them rather than picked — so a
// change to any single step can't silently leave the popup declaring a dump
// abandoned while it is still legitimately running (or the reverse).
// ---------------------------------------------------------------------------

// How long to wait for a freshly created tab to reach `status: "complete"`.
// The page might never finish loading at all (blocked request, offline,
// captive portal), so this can't be unbounded.
export const TAB_READY_TIMEOUT_MS = 8000;

// How long content-script.js holds an undelivered payload waiting for the
// page to announce readiness and ack it. Sized for a cold, uncached first
// load on a slow machine — the app's listener attaches within ~100ms of
// `load` on warm local hardware, but a cold CDN fetch of the JS bundle plus
// hydration on a low-end machine is a different order of magnitude. Only
// ever actually *spent* when the page genuinely never becomes ready (e.g. a
// route with no app shell, or a broken deployment), and it ends in a real
// error rather than a false success.
export const IMPORT_ACK_TIMEOUT_MS = 8000;

// A couple of short retries for the distinct, fail-fast case where
// chrome.tabs.sendMessage rejects outright because no content script is
// attached to the target tab yet. Never used for a page that answered and
// said it isn't ready — that's a definitive answer, not a transient one.
export const SEND_RETRY_DELAYS_MS = [150, 350];

// Worst realistic wall-clock duration of one dumpTabs() run: an existing tab
// that turns out to be unusable (a full ack timeout), then the fresh-tab
// fallback paying for a full page load and a second ack wait, plus the
// send-retry backoff on each of the two deliveries.
const RETRY_BACKOFF_MS = SEND_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
export const DUMP_WORST_CASE_MS =
  IMPORT_ACK_TIMEOUT_MS + TAB_READY_TIMEOUT_MS + IMPORT_ACK_TIMEOUT_MS + RETRY_BACKOFF_MS * 2;

// Persisted (chrome.storage.session) record of the most recent MSG_DUMP_TABS
// run, keyed by this constant. Exists so a dump's outcome survives the popup
// that triggered it closing before background.js's sendResponse can reach it
// — e.g. the user clicking away, or Chrome's own popup-blur behavior —
// instead of the result being silently lost. See background.js's
// setDumpState() (the writer) and popup.js's init()/watchForDumpCompletion()
// (the readers).
export const DUMP_STATE_KEY = "tabdump_dump_state";

// A persisted "running" record older than this is treated as abandoned (e.g.
// the service worker was evicted mid-dump, or simply crashed) rather than
// genuinely still in flight, so a popup reopened long after never gets stuck
// waiting on a dump that will never resolve. Derived from the worst case
// above plus slack, so it can never accidentally sit *below* a dump's real
// duration and declare a healthy dump dead.
export const DUMP_RUNNING_STALE_MS = DUMP_WORST_CASE_MS + 5000;

// A finished ("done"/"partial"/"error") record older than this is treated as
// history rather than something to surface again on a fresh popup open —
// otherwise reopening the popup long after a past dump would misleadingly
// replay its result.
export const DUMP_RESULT_FRESH_MS = 15000;

// The phases a dump moves through, persisted alongside its status so a popup
// that opens mid-dump can say what is actually happening instead of an
// indefinite "Dumping tabs…", and so a stuck dump is diagnosable from its
// last recorded phase. See popup.js's DUMP_PHASE_LABEL.
export const DUMP_PHASE = {
  QUERYING_TABS: "querying-tabs",
  RESOLVING_TAB: "resolving-tabdump-tab",
  DELIVERING: "delivering",
  RETRYING_IN_NEW_TAB: "retrying-in-new-tab",
  FINISHED: "finished",
};
