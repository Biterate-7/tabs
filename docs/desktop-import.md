# Chrome → Hubble Desktop

The Hubble Chrome extension can send tabs straight into Hubble Desktop, with no
website in between. Hubble Web keeps working exactly as before; the desktop is
an additional destination, offered once the extension has seen Hubble Desktop
on this computer.

```
Chrome tab ──right-click "Add to Hubble Desktop" / popup──▶ extension (background.js)
     │  GET http://127.0.0.1:41517/v1/hello            is Hubble Desktop open?
     │  ── no ──▶ open hubble://import (installer-registered), ask again for ≤15 s
     │  POST /v1/sessions                              { sessionId, token }
     │  POST /v1/sessions/:id/import   Bearer token    validated, queued in Rust
     ▼
Hubble Desktop (src-tauri/src/import_bridge.rs) ──event + focus──▶ webview
     │  desktop_import_take()          the batch, once the store has loaded
     │  "Add 12 tabs to Hubble — choose a project"   (desktop-import-dialog.tsx)
     │  handleAddSources(project, tabs, "extension")  the one source pipeline
     │  desktop_import_finish(result)
     ▼
extension polls GET /v1/sessions/:id ──▶ "Added 9 sources to Research · 3 already there"
```

## Pieces

| Where | What |
| --- | --- |
| `src-tauri/src/import_bridge.rs` | Loopback HTTP bridge (std `TcpListener`, no server dependency), sessions, validation, pending queue, two Tauri commands. |
| `src-tauri/src/lib.rs` | Starts the bridge in `setup`, registers `tauri-plugin-single-instance` and `tauri-plugin-deep-link`. |
| `src-tauri/tauri.conf.json` | `plugins.deep-link.desktop.schemes: ["hubble"]` — the NSIS/MSI installers register the scheme from this. |
| `src/lib/desktop/import-protocol.ts` | Webview half of the protocol: re-validation, outcome counting, shared constants. |
| `src/hooks/use-desktop-import.ts` | Pulls queued batches when the app is ready; listens for new ones; expires them before Rust does. |
| `src/components/desktop-import-dialog.tsx` | Project picker: projects, "Open now" default, + New project, Cancel. |
| `extension/src/desktop.js` | Payload building, bridge discovery, session/transfer/result polling, wording. |
| `extension/src/desktop-add.js` | One run end to end, with every browser call injected. |
| `extension/background/background.js` | Context menu items, popup message, protocol launch, toast/badge, Retry / Open Hubble Web. |

## Protocol (version 1)

`POST /v1/sessions/:id/import` body:

```json
{ "version": 1, "requestId": "…", "source": "chrome-extension",
  "tabs": [{ "url": "https://…", "title": "…", "favicon": "https://…" }] }
```

Only what `ResourceInput` takes travels — no tab or window ids, pinned or active
state. Order is window, then tab-strip order. At most 200 tabs (the pipeline's
`MAX_INGEST_BATCH`); the extension counts anything past that as not added.

Result (`GET /v1/sessions/:id` once answered, then the session is forgotten):

```json
{ "status": "done | cancelled | expired | failed",
  "result": { "requestId": "…", "success": true, "received": 12, "added": 9,
              "duplicates": 3, "failed": 0, "project": "Research" } }
```

`duplicates` is the pipeline's own rule: an address that is already a source of
that project is not added again (an address saved there as a plain tab becomes
a source — counted as added, as everywhere else).

## Security

* Binds `127.0.0.1` only, first free of ports 41517–41519. `Host` must be
  loopback at that port (DNS rebinding). Every POST must carry a
  `chrome-extension://` `Origin`; a page cannot forge it, and CORS headers are
  only ever sent to extension origins.
* Sessions: random 128-bit id and 256-bit token (OS RNG), constant-time
  compare; unused sessions expire in 30 s, unanswered requests in 180 s,
  uncollected results in 60 s; at most 8 at once. All in memory.
* Four routes. Nothing reaches a file, a process, another Tauri command or the
  network. Bodies ≤ 2 MiB, headers ≤ 8 KiB, 5 s I/O timeouts, ≤ 16 connections.
* The payload is validated in Rust (version, source, request id, count, http(s)
  only, ≤ 2048-char addresses, ≤ 500-char titles, favicons http(s) only) and
  again in the webview. Bad addresses are dropped and counted, never fatal.
* Nothing is imported until the person presses Add in Hubble; Cancel imports
  nothing.
* The token authenticates the *session*, not the client: any local program can
  open a session, just as any local program can already read the Chrome
  profile. What it cannot do is import without the person accepting it in the
  Hubble window, or read another session's result. The extension id is not
  pinned because the extension is distributed unpacked (its id depends on
  where it was unpacked).
* Logs carry request ids, counts and reasons — never addresses, titles or
  tokens. Rust logs only in debug builds.

## Privacy

The transfer is Chrome → loopback → Hubble Desktop. Nothing about it goes to
Hubble's servers. Once tabs are sources of a project, Hubble reads them the way
it reads any source added on the desktop (that existing step uses the deployed
reader, see `docs/project-context.md`); this feature does not change that.

## Extension permissions

`host_permissions` gains `http://127.0.0.1:41517/*`, `…:41518/*`, `…:41519/*`
— the bridge ports and nothing wider — so the service worker can reach the
bridge. No new API permissions.

## Startup race

Batches wait in Rust (`Bridge`), created in `setup` before the window. The
webview asks for them only once its store has loaded (`desktop_import_take`)
and again on each `hubble-import:requested` event, so a batch sent while Hubble
is launching is shown as soon as Hubble can take it. A webview that reloads
mid-choice is shown the batch again. Batches expire; nothing survives a quit.

## Single instance

`tauri-plugin-single-instance` makes a second launch (including `hubble://`
while Hubble is open) bring the existing window forward and exit. This also
means a second Start-menu launch no longer opens a second window.
