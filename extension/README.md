# TabDump Tab Reuse Bridge

A tiny Manifest V3 Chrome extension that lets the TabDump web app focus an
already-open browser tab instead of opening a duplicate. It has no UI of its
own and does nothing on its own -- it only responds to messages from the
TabDump origins listed in `manifest.json`'s `externally_connectable`.

It is a thin, privileged bridge only: `background.js` contains no URL
normalization or matching logic. All matching happens in the web app, in
`src/lib/tabs/extension-bridge.ts`. The extension only ever lists open tabs
(`chrome.tabs.query({})`, fresh on every request, never cached) or focuses
one by id. It never reads page content and never persists anything.

## Load it (developer mode)

1. Open `chrome://extensions` in Chrome.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select this `extension/` folder.
4. Copy the "Id" Chrome assigns the extension (shown on its card).
5. Set that value as `NEXT_PUBLIC_TABDUMP_EXTENSION_ID` in your `.env.local`,
   then restart `npm run dev`.

Without step 5, TabDump works exactly as before -- every saved tab just
opens in a new browser tab. The extension is entirely optional.

## Permissions

Only `"tabs"` -- to list open tabs' URLs/window ids and to activate a tab and
focus its window. No `host_permissions`, no content scripts, no page access,
no `storage`, no `history`, no `cookies`, no `<all_urls>`.

## Message protocol

Three message types, validated in `background.js` against both the sender's
origin and the message shape; anything else is rejected:

- `PING` → `{ ok: true }` -- liveness check.
- `LIST_TABS` → an array of `{ id, url?, windowId, lastAccessed? }` for every
  currently open tab (a live `chrome.tabs.query({})` snapshot, not stored).
- `FOCUS_TAB` (`{ tabId, windowId }`) → `{ ok: true }` on success, or
  `{ ok: false, error }` if the tab no longer exists (e.g. closed by the user
  between `LIST_TABS` and `FOCUS_TAB`) -- never an uncaught error.
