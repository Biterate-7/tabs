// Local-dev origin. Must match the `host_permissions` entry and the
// `content_scripts` match pattern in manifest.json (manifest patterns are
// static, so those need updating by hand too if this changes).
//
// The production origin is NOT set here — it's substituted into this file's
// copy inside the packaged ZIP at build time, from the single canonical
// CANONICAL_PRODUCTION_ORIGIN in scripts/build-extension-zip.mjs. Change the
// production domain there, not here.
export const TABDUMP_ORIGIN = "http://localhost:3000";

// Message-passing constants shared across background/content/popup so a
// typo in one place can't silently desync from another.
export const MESSAGE_SOURCE = "tabdump-extension";
export const MSG_DUMP_TABS = "DUMP_TABS";
export const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";

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
// src/hooks/use-browser-connection.ts).
export const MSG_EXTENSION_PING = "TABDUMP_EXTENSION_PING";
export const MSG_EXTENSION_PONG = "TABDUMP_EXTENSION_PONG";

// Persisted (chrome.storage.session) record of the most recent MSG_DUMP_TABS
// run, keyed by this constant. Exists so a dump's outcome survives the
// popup that triggered it closing before background.js's sendResponse can
// reach it — e.g. the user clicking away, or Chrome's own popup-blur
// behavior — instead of the result being silently lost. See background.js's
// setDumpState() (the writer) and popup.js's init()/watchForDumpCompletion()
// (the readers).
export const DUMP_STATE_KEY = "tabdump_dump_state";

// A persisted "running" record older than this is treated as abandoned
// (e.g. the service worker was evicted mid-dump, or simply crashed) rather
// than genuinely still in flight, so a popup reopened long after never gets
// stuck waiting on a dump that will never resolve. Comfortably above
// dumpTabs()'s worst realistic duration (background.js's
// TAB_READY_TIMEOUT_MS plus sendImportToTab's retry backoff, ~8.5s).
export const DUMP_RUNNING_STALE_MS = 20000;

// A finished ("done"/"error") record older than this is treated as history
// rather than something to surface again on a fresh popup open — otherwise
// reopening the popup long after a past dump would misleadingly replay its
// result.
export const DUMP_RESULT_FRESH_MS = 15000;
