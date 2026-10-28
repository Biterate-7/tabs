# Hubble Web ↔ Hubble Desktop parity

What each user-facing feature does in Hubble Desktop, and how that was last
verified. Built from the app's own views (`app-shell.tsx`: home, workspace,
search, graph, library, ai, sessions, favorites, recents, history-dump,
settings), not from a wish list.

**Last verified 2026-10-27**, in two rounds:

- **Desktop, production configuration:** a packaged-mode debug build
  (`tauri build --debug --no-bundle`, identity `app.tabdump.desktop.qa`)
  driven over CDP.
- **Desktop, accounts end to end:** the same build compiled with
  `HUBBLE_ACCOUNT_ORIGIN=http://localhost:3000`, against `next dev` on real
  PostgreSQL 18 (embedded-postgres, every schema applied) and system Chrome
  with Hubble for Chrome 0.9.0 loaded unpacked. The account was seeded in
  the database (a Google sign-in can't be scripted); everything after that
  ran through the real routes, Rust commands, keyring, loopback bridge and
  extension.

"Unit" means covered by `npm test` / `cargo test` only.

## How the two shells differ, and how each gap was closed

| Constraint | Consequence | What closes it |
|---|---|---|
| No server in the app (static export) | Account APIs can't be same-origin | Rust makes them, with a device token (`account_request`) |
| No session cookie, and Google won't accept the app's origin | No sign-in | Pairing through the browser with PKCE (`/desktop/connect`, `src/lib/auth/device.ts`) |
| The extension talks to the app, never the reverse | The app can't read tabs or history | The relay: a Hubble page asks in the browser, the extension answers (`/desktop/relay`) |
| The app can't open a Chrome window | Sessions can't start in a new window | Each tab goes to the default browser (`open_external`) |

## Matrix

| Feature | Web | Desktop | Evidence | Remaining issue |
|---|---|---|---|---|
| **Sign in** | Google, on the site | Browser pairing → device token in Windows Credential Manager | E2E: pasted code → Account shows the user; `hubble://auth/callback` via a second launch → signed in; DB holds one hashed, redeemed row. Unit: 14 route tests (wrong verifier burns the code, single-use under a race, expiry, no cookie fallback, cookie ≠ device token), 6 Rust account tests incl. the RFC 7636 vector | Needs `migrate:auth` on production (docs/desktop-release.md) |
| Sign out | Deletes web session | Deletes the device row first, then the keyring entry | E2E: row count 0, Account shows Not signed in, web session untouched | — |
| Revoke a desktop | Settings → Account → Disconnect | Signs itself out on its next request; local projects kept | E2E: web Disconnect → row deleted → app shows Not signed in | — |
| Expired / offline account | — | Expired: dropped locally. Offline: keeps the last account, so its projects open | Unit (`client.test.ts`) | — |
| **Sync** | Explicit upload, then automatic | Same engine through `accountFetch` | E2E: project made in the app → Upload this workspace → row in `tabdump_workspaces` for the right user → `/api/sync/workspaces` on the web lists it, and the web adopted it | Empty projects show no sync control on either shell (existing behaviour) |
| **AI connectors** | Signed-in management | Same pane, same API, device token | E2E: pane loaded the account's connectors (`GET /api/integrations` 200) | Creating a connector and an AI client using it were not run (needs ChatGPT/Claude accounts) |
| Use in AI (send context to an AI app) | Extension types into a new chat | Copies the context, opens the AI app to paste | Unit; 2026-10-18 audit | Direct insert would need a relay action that writes into a tab — not built |
| Settings → Desktop app | Real installer, HEAD-probed, release page fallback | Version/OS/build from the binary; update check | Chrome: downloaded 30,260,142 bytes, SHA-256 matched; offline → retry. CDP: `0.1.0 · Windows · 64-bit`; update check showed "answered 404" against production | `/api/desktop/release` exists only once this is deployed |
| Home, search (Ctrl+K), galaxy graph | ✓ | ✓ | CDP (round 1): WebGL canvases, search hit, screenshots | — |
| Projects, notes + LaTeX, PDF reader | ✓ | ✓ | CDP: project created; 2 `.katex` + 1 `.katex-display`; pdf.js page canvas | — |
| Persistence across restart | ✓ | ✓ | CDP: projects, session, theme after kill + relaunch | — |
| **Save current session** | Through the page | Relay: approve in the browser | E2E: relay page → Send → "2 tabs will be saved" (Hubble's own tab left out) → saved with `example.com, example.org` | Needs Hubble for Chrome 0.9.0 |
| Save tabs Chrome sends as a session | — | Import dialog → Save as a session | E2E (round 1): real bridge → session listed, bridge answered `done` | — |
| Start a session | New Chrome window | Default browser, tab by tab | E2E (round 1): loopback server received both tabs | No window grouping |
| **Import from history** | Through the page | Relay: approve the range in the browser | E2E: scan → relay page → Send → scan completed ("Nothing worth keeping" for a fresh profile) | Needs 0.9.0 |
| **Organize open tabs**, Add → Browser tabs | Through the page | Relay (`readChromeTabs`) | Unit (`open-tabs-organize.test.tsx`: waits, organizes what was sent, says when declined); same reader as the E2E session save | — |
| Relay security | — | Fragment-only secret, extension Origin, single answer, 5-minute expiry | Unit: 3 Rust relay tests, extension validator tests, page tests incl. StrictMode; E2E: secret cleared from the address bar | — |
| Theme / appearance | ✓ | ✓ | CDP: persists across restart | — |
| Export / import projects | Download / file input | Native Save dialog / file input | Unit; 2026-10-18 audit | — |

## Found and fixed during verification

- The relay page read its fragment in an effect that React StrictMode runs
  twice; the first run cleared the secret and the second saw "This link isn't
  complete". It now reads once (test added).
- A computer name of `NULL` (this machine's environment) labelled the
  desktop "Hubble Desktop on NULL"; placeholders now read "this computer"
  (Rust test added).
- The shared Chrome reader briefly required the window list for Add →
  Browser tabs on the web too; it is optional again, so web behaviour is
  unchanged.

## Not verified here

- A real Google sign-in on the connect page (needs a person; the page uses
  the website's existing button and session).
- The **published** installer: no 0.2.0 has been built by CI or published.
  0.1.0 (what `/download` serves today) predates everything in bold above.
- A release-profile build; this machine blocks new release artifacts. CI
  builds those.
