# Hubble browser extension

A thin Manifest V3 Chrome/Chromium extension: collects the current window's
tabs and hands them to the Hubble web app via its existing ingestion
pipeline. No build step — plain JavaScript, loaded unpacked.

## Load it locally

1. Make sure the Hubble web app is running (`npm run dev`, default `http://localhost:3000`).
2. Open `chrome://extensions`.
3. Enable "Developer mode" (top right).
4. Click "Load unpacked" and select this `extension/` directory.
5. Click the Hubble icon in the toolbar, then "Dump tabs →".

## How it works

```
popup click → background.js collects + filters the named window's tabs
            → finds an app-route Hubble tab, or opens one
            → content-script.js posts the payload into the page AND HOLDS
              THE MESSAGE CHANNEL OPEN
            → src/hooks/use-extension-import.ts feeds the existing
              parse/categorize/dedupe pipeline, then ACKS with the number
              of tabs it actually accepted
            → only that ack completes the delivery; the popup reports it
popup renders the result → THEN asks background.js to focus the Hubble tab
```

Three properties of that flow are load-bearing, each fixing a way the dump
used to fail silently on a machine that wasn't the developer's:

**Delivery means ingestion, not transport.** `chrome.tabs.sendMessage`
resolving only ever proved a *content script* was attached. The React app
behind it attaches its `message` listener strictly after the page's `load`
event — measured at 1–105ms after `loadEventEnd` against a production build
over localhost — while background.js delivers at exactly `load` (that's what
`status: "complete"` means). So on every freshly opened tab the payload was
posted into a document with nothing listening, was lost, and the dump
reported success anyway. A machine that already had a warm Hubble tab open
reused it and never hit this; a fresh install always did. The content script
now holds the batch until the page announces `TABDUMP_PAGE_READY` and acks
it, so ordering stops mattering, and a page that never becomes ready
produces a real error instead of a phantom success.

**Only a route that mounts the app can receive a dump.** `/privacy`,
`/terms` and `/cookies` are served from the same origin, so they match
`content_scripts`, `host_permissions` and `chrome.tabs.query`'s url filter
exactly like the app does — but they never mount `AppShell`. background.js
prefers an app-route tab and opens one when there isn't any; the ack is the
backstop if that preference is ever wrong.

**Focus belongs to the popup.** Chrome dismisses an open action popup the
instant the foreground tab changes, so background.js activating the Hubble
tab at the end of a dump destroyed the popup before it could paint the
result — the user saw "Dumping tabs…", then nothing, even when the dump had
worked. The popup now renders first and requests focus (`TABDUMP_FOCUS`)
on its way out.

The dump never depends on the popup surviving: every phase is written to
`chrome.storage.session`, so a popup that Chrome closed mid-dump can be
reopened to see the live phase or the final outcome. A `running` record found
at service-worker startup is an orphan by definition (a fresh worker has no
dump in flight) and is reconciled to `interrupted` rather than left to strand
the next popup.

Opening the popup also runs a second, read-only round trip so it can show
"31 new · 16 already imported" instead of a raw count, and so "Dump" only
sends the new ones:

```
popup opens → background.js asks an *already-open* Hubble tab
              (never opens one just to check)
            → content-script.js relays the candidate urls into the page
            → src/hooks/use-extension-workspace-query.ts compares them
              against the currently selected workspace (same normalizeUrl
              the workspace's own duplicate detection uses) and replies
            → popup falls back to the plain wording if no Hubble tab is
              open, or it doesn't answer in time
```

## Ask Tabs browser control

Ask Tabs (the AI assistant in the web app) can also control the user's real
Chrome tabs/windows — listing them, opening/closing tabs, pinning, moving
tabs between windows, creating a window — through this same extension. This
is a second, generic typed-command bridge alongside the tab-dump one above:

```
Ask Tabs (Gemini, server-side)
      ↓ (validated action name + typed args)
web app (src/lib/browser/bridge.ts) — posts a TABDUMP_BROWSER_COMMAND
      ↓
content-script.js — pure relay, does not interpret the command at all
      ↓
background.js — the ONLY place that decides what's allowed:
      1. is `action` one of the names in browser-commands.js's allowlist?
      2. does `args` pass that action's own validator?
      ↓ (only if both pass)
browser-actions.js — calls the actual chrome.tabs / chrome.windows API
      ↓
TABDUMP_BROWSER_COMMAND_RESULT flows back through the same chain
```

The Gemini-facing action layer (server-side, in the web app's
`src/lib/actions/browser-*.ts`) can only ever validate arguments and — for
read actions — answer from a browser snapshot the page already fetched. It
never touches `chrome.*` itself; only this extension does that, and only for
the fixed allowlist in `extension/src/browser-commands.js`:
`list_browser_tabs`, `get_active_tab`, `list_browser_windows`, `open_url`,
`open_tabs`, `close_tab`, `close_tabs`, `pin_tab`, `unpin_tab`,
`move_tabs_to_window`, `create_browser_window`. There is no "run arbitrary
JavaScript" or "click this element" command, and never will be as part of
this allowlist design — see AGENTS.md's Chrome Browser Control spec for the
full scope boundary.

Connection detection (the 🟢/⚪ indicator in Ask Tabs) is a lightweight
ping/pong: the page pings on an interval while disconnected, and
content-script.js answers immediately on its own — no background/chrome.*
round trip needed, since the content script only runs at all when the
extension is installed and enabled.

### Why no new permissions were needed

The manifest's existing `"permissions": ["tabs"]` already covers every
`chrome.tabs.*` call this feature makes (query, create, remove, update,
move) and every `chrome.windows.*` call (`create`, `get`, `getAll`) —
`chrome.windows` requires no separate permission entry in Manifest V3.
No new host permissions, `scripting`, or broader content-script matches were
added; opening/closing/pinning tabs and creating windows doesn't need to
read a page's content, only to manage the tab/window objects themselves.

## Quick add: a Chrome tab → your Hubble project

Chrome's tab strip cannot be dragged onto a web page (no drop event, no data)
and no extension API reports a tab drag, so the closest supported way to put an
actual tab into a project is the tab's own right-click menu:

```
right-click a tab ─┐   (contexts: ["tab"]; the whole selection if the tab is in it)
right-click a page ├─► background.js quickAdd() → dumpTabs({ target })   ← the popup's own run
Alt+Shift+H ───────┘     → TABDUMP_IMPORT { target: { workspaceId, as: "sources" } }
                         → the page's one ingestion pipeline → ack { accepted, duplicates | project-missing }
                         → toast in the tab you're on (activeTab), always naming the project:
                           Adding to <project>… → Added to / Already in / Couldn't add to <project>
                         → TABDUMP_SOURCE_STATUS until reading settles: Reading source… → Ready · 1,840 words
```

The menu item names the target ("Add to History IA"): the project open in
Hubble, reported by the page (`TABDUMP_PROJECT_FOCUS`), or the one last chosen
in the popup — whichever was chosen last. Pure logic lives in
`src/quick-add.js`; `background/quick-add.test.js` drives the real
background.js. `contextMenus` and `activeTab` carry no install warning.

## Changing the Hubble origin

**Production:** usually nothing to edit. A Vercel production build bakes in
the project's own production domain (`VERCEL_PROJECT_PRODUCTION_URL`), so a
domain added in the Vercel dashboard reaches the next ZIP on its own. The
fallback for builds outside Vercel is `CANONICAL_PRODUCTION_ORIGIN` in
`../src/lib/production-origin.mjs` — the single source of truth, shared with
the site's canonical URL; see `resolveProductionOrigin()` there for the full
precedence. Don't hardcode the production domain anywhere else, and never a
per-deployment `*-<hash>-*.vercel.app` URL.

**Local dev:** edit `TABDUMP_ORIGIN` in `src/config.js`, and update the
matching `host_permissions` and `content_scripts.matches` entries in
`manifest.json` to the same origin (manifest match patterns are static and
can't read from `config.js`).

## Regenerating icons

The toolbar/store icons in `icons/` (16/32/48/128px) are generated from the
Hubble logo at `brand/hubble-logo-source.webp` — the same source as the web
app's favicon and the desktop app icon. Run `npm run brand:assets` from the
repository root to regenerate them (see `brand/README.md`).
