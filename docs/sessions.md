# Sessions

Save the tabs open in Chrome as a named session, close everything, and reopen
them together later — from Hubble's Home ("Pick up where you left off"), the
Sessions page, or by combining tabs from several sessions.

> A saved session is a snapshot. Nothing about the tabs open now changes it
> until the person explicitly edits it or replaces it.

## Where things live

| Piece | File |
| --- | --- |
| Types, limits | `src/lib/sessions/types.ts` |
| Pure reducers (create, rename, duplicate, delete, replace tabs, mark opened, "most recent") | `src/lib/sessions/model.ts` |
| Combining sessions into one launch (order, dedupe) | `src/lib/sessions/combine.ts` |
| Storage (localStorage, per account) | `src/lib/sessions/persistence.ts` |
| Reading Chrome's windows on the page; default names | `src/lib/sessions/capture.ts` |
| Opening tabs through the extension | `src/lib/sessions/restore.ts` |
| Wording for every outcome | `src/lib/sessions/messages.ts` |
| Sessions page, launcher, editor, save dialog, Home card | `src/components/sessions/` |
| Popup "Save session" → page | `extension/popup/popup.*`, `extension/background/background.js` (`saveSession`), `extension/src/sessions.js` |
| `open_session` command | `extension/src/browser-commands.js` (validator), `extension/src/browser-actions.js` (`openSession`) |

## Persistence

Local-first, like the rest of Hubble's personal content: one JSON document at
`tabdump:tab-sessions:v1` in this origin's localStorage, partitioned per
signed-in account (listed in `SCOPED_STORAGE_KEYS`). **Sessions do not sync
between devices or browsers** — the server sync engine is workspace-scoped and
adding an entity type would need a production schema migration.

- Every write is read-modify-write against what is stored *now*
  (`writeSessions`), so a session the extension saves into a background Hubble
  tab is never lost to a write from another tab. Other tabs re-render through
  the `storage` event.
- A write either succeeds or changes nothing: refused changes and storage
  failures (quota) leave the previous copy byte-for-byte intact.
- Edits carry the `revision` they were made against; a stale edit is refused
  ("changed in another tab") rather than overwriting.
- Unparseable stored data is copied to `…:unreadable-backup` once before it is
  first overwritten. Data written by a newer schema version is read-only.
- Stored data is re-validated on read: only http(s) addresses survive, ids are
  de-duplicated, empty sessions are dropped.

Only the address, the title it had, Chrome's http(s) icon and whether it was
pinned are kept. No page content, cookies or form values. Nothing is sent to a
server or an AI service.

## Saving

**From the popup** (needs an extension built from this change): popup → background
`HUBBLE_SAVE_SESSION` (popup-only; validated) → background reads the popup's
window, or every ordinary window when ticked → `save-session` page request
(`HUBBLE_PAGE_REQUEST`, the channel the memory features use; Hubble is opened
in the background if no tab has it) → the page re-validates
(`lib/memory/extension-protocol.ts`) and stores. The popup says "Saved" only on
the page's answer, and lists what was left out (browser pages, private tabs).

**From the website** ("Save current session"): the page reads Chrome through
the existing `list_browser_tabs` + `list_browser_windows` commands, so it works
with already-installed extensions. The window Hubble is in is chosen by
default; other ordinary windows can be ticked.

Both paths: private (incognito) windows are never read; browser-internal pages
(`chrome://`, new tabs, `file://`) are left out and counted; Hubble's own tabs
are left out silently.

## Opening

Always in a **new Chrome window**; existing tabs are never closed, moved or
navigated. The page sends one `open_session` command `{ requestId, tabs }`:

- validated in the extension: ≤ 200 tabs, http(s) only;
- opened one at a time, in order (the first creates the window);
- a repeated `requestId` gets the first run's result and opens nothing again;
- the page allows one launch at a time and asks before opening more than 15.

"Last opened" is recorded only after Chrome reports at least one tab opened.
Partial failures say "Opened 10 of 12 tabs". A connected extension that is slow
gets "Chrome hasn't confirmed yet", never a false failure.

On an extension built before this change (`open_session` unknown) the page falls back to
the older `open_tabs` command with a new window for up to 50 tabs, and asks for
an update above that. The fallback only runs after the newer command was
refused, so tabs are never opened twice.

## Combining

The launcher works on the sessions as they were when it opened. Sessions open
in the order they were ticked, each in its saved order. Exact duplicate
addresses are skipped by default (compared with `new URL(url).href` only —
queries and fragments are kept, since they often *are* the document); the
switch keeps intentional duplicates. "Save as new session" stores the
combination; the originals never change.

## Hubble Desktop

The desktop app cannot reach Chrome's tabs this way, so it shows no Sessions
row or Home card. Sessions saved in Chrome stay in that browser.

## Releasing

The website and the extension ship separately. The popup's "Save session" and
`open_session` need an extension build from this change; website saving and
opening (≤ 50 tabs) work with the extension already installed.

The extension's manifest version was **not** bumped in this change; bump it
(e.g. to 0.9.0) when releasing, so the served ZIP is distinguishable from 0.8.1.
