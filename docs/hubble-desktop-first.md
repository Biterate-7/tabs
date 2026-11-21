# Hubble, desktop-first

Since 2026-11-19 Hubble is a desktop application. This document is the map:
what each part is, how they talk, how to build and release them, and what is
still open. Details live in the linked docs.

```
 Hubble for Chrome (extension/)          Hubble Desktop (src-tauri/ + src/, static export)
 ──────────────────────────────          ─────────────────────────────────────────────────
 captures AI conversations, tabs   ──▶   loopback bridge 127.0.0.1:41517-41519
 popup: projects, search, context        ├─ /v1/sessions…  take-in only, person picks project
 durable capture queue                   ├─ /v1/pair, /v1/link/*  PAIRED (token + origin)
                                         └─ /v1/relay/:id  answers to questions the app asked
                                               │
                                               ▼
                                         webview: AppShell, local-first storage
                                         (localStorage + IndexedDB), sync via Rust device token

 Hubble website (Next.js on Vercel, project "tabs")
 ──────────────────────────────────────────────────
 /            launch page — "Download for <OS>"
 /download    every installer of the latest published GitHub release, notes, install steps
 /move        save the projects the retired web app left in this browser
 /account     sign in, disconnect a Hubble Desktop
 /desktop/connect, /desktop/relay, /oauth/*, /api/*   what the app and AI connectors need
```

## 1. The website no longer runs the app

`next.config.ts` picks a page set per build target:

| Build | `pageExtensions` | `/` is |
| --- | --- | --- |
| Website (`npm run build`, Vercel) | `web.tsx`, `tsx`, `ts` | `src/app/page.web.tsx` — the launch page |
| Desktop (`npm run desktop:export`, `desktop:dev`) | `desktop.tsx`, `tsx` | `src/app/page.desktop.tsx` — the app (`AppRoot`) |

So the website bundle contains no app-shell code (verified: no app strings in
`.next/static`), and the desktop export contains no website-only page
(`*.web.tsx`) and no route handler (`route.ts`). `desktop-no-sync.test.ts` pins
both. `/welcome` redirects to `/`.

Nothing a person stored was deleted. The old web app's data is still in that
browser's storage for the site's origin; `/move` (src/lib/web-migration)
writes each account namespace out as a Hubble export file — projects, links,
notes, collections, dependencies and saved text — which Hubble Desktop's
**Settings → Projects → Import projects** reads. `/` shows a notice to anyone
whose browser still holds projects. Signed-in users' synced projects also
follow them into the app when they sign in there.

## 2. Hubble for Chrome ⇄ Hubble Desktop

Two channels over the same loopback bridge (`src-tauri/src/import_bridge.rs`):

1. **Take-in sessions** (since 0.1): a batch of tabs or one conversation is
   queued, and the person picks the project in Hubble's window. No secret
   needed — nothing flows out, and the person confirms each one.
2. **The paired link** (`src-tauri/src/extension_link.rs`,
   `extension/src/desktop-link.js`): what used to need a Hubble tab — the
   popup's project list, saving into a chosen project, search, the context
   bundle for an AI chat, sessions, quick add.

Pairing: the popup's **Connect to Hubble Desktop** → `POST /v1/pair` → both
the popup and a "Connect Hubble for Chrome?" dialog show the same six-digit
code → the person presses **Connect** in Hubble → the extension collects a
random 256-bit token once. Hubble stores only its SHA-256 with the extension's
origin (`extension-links.json` in the app data folder). Every paired request
needs the token **and** that origin; a refused token is forgotten by the
extension. Settings → Chrome extension lists links with Disconnect.

Security properties (tested in `extension_link.rs`, `import_bridge.rs`):

- Loopback only, Host checked (no DNS rebinding), only `chrome-extension://`
  origins may POST, CORS only for extension origins.
- No unauthenticated route returns anything but "Hubble is here".
- Paired requests carry a closed list of kinds; the webview re-reads every
  argument with its zod schema (`src/lib/memory/extension-protocol.ts`).
  `link-protocol.test.ts` keeps Rust, the extension and the schema in step.
- Tokens never reach the webview; nothing is logged but ids, kinds and outcomes.

Reliability: saves go through the extension's durable capture queue
(`extension/src/capture-queue.js`). While Hubble Desktop is closed or the
extension isn't paired, jobs wait (`no-hubble-tab`, `not-paired` are kept,
never dropped); a one-minute alarm looks for Hubble and delivers them as soon
as it answers. A save the person just asked for starts Hubble via `hubble://`.

## 3. Building

```bash
npm run dev               # the website, http://localhost:3000
npm run desktop:dev       # Hubble Desktop in a Tauri window (desktop page set, hot reload)
npm run desktop:export    # the static frontend Tauri packages -> out/
npm run desktop:build     # installers for this OS -> src-tauri/target/release/bundle/
```

Prerequisites per OS are in [desktop-architecture.md](desktop-architecture.md).
Linux also needs `libdbus-1-dev` (the keyring's Secret Service backend).

## 4. Releasing

[desktop-release.md](desktop-release.md). In short: tag `desktop-vX.Y.Z` →
`.github/workflows/desktop-release.yml` builds Windows (`.exe`, `.msi`),
macOS (universal `.dmg`) and Linux (`.AppImage`, `.deb`) and drafts a GitHub
Release with checksums → a person checks the installers and **publishes** →
the website follows within ten minutes (it reads the GitHub Releases API;
`src/lib/desktop/release-source.ts`). Pull requests that touch the app build
all three platforms (`desktop-build.yml`) without publishing.

## 5. Not done, on purpose or for now

- **Code signing.** No certificates exist. Windows SmartScreen and macOS
  Gatekeeper warn on first run. The release workflow already passes Apple
  signing/notarization secrets when they exist; Windows needs a certificate or
  Azure Trusted Signing.
- **Automatic updates.** Not implemented. Settings → Desktop app checks
  `/api/desktop/release` and links the newer installer. `tauri-plugin-updater`
  needs an update-signing key held as a CI secret.
- **Context intelligence** (opt-in activity suggestions) still needs the page
  bridge and is off in Hubble Desktop, as before this change. Carrying it over
  needs an extension → desktop activity push over the paired link.
- **Chrome Web Store listing.** The extension is a ZIP download until
  `NEXT_PUBLIC_EXTENSION_STORE_URL` is set.
- **The production origin moved.** The website is the Vercel project `hubble`
  (team `hubbleaiteam-3510`) at `https://hubblehq.vercel.app`
  (`CANONICAL_PRODUCTION_ORIGIN`). The old `https://hubble-hq.vercel.app`
  (project `tabs`) answers 402 DEPLOYMENT_DISABLED since its account was
  blocked. Hubble Desktop 0.1.0 and extensions up to 0.10.0 have the old
  origin built in, so their sign-in, relay and update check stop working
  until people install 0.2.0 / extension 0.11.0. Browsers keep the web app's
  old projects per address: those made at `hubble-hq` can only be saved by
  `/move` served from `hubble-hq` itself, i.e. once that address is back.
