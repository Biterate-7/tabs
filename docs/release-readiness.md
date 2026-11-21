# Hubble Desktop — release readiness (audit of 2026-11-21)

Updated 2026-11-21 after release: PRs #59, #61 and #60 are merged to `main`
(live at https://hubblehq.vercel.app) and Hubble Desktop 0.2.0 is published
(https://github.com/Biterate-7/tabs/releases/tag/desktop-v0.2.0). "Real" means the actual extension in system
Chrome against an actual running Hubble build; "unit" means automated tests;
"static" means inspected, not run.

## Verdict

**Released as 0.2.0, with two known gaps outside the code:** production
accounts (sign-in, sync and AI connectors answer 503 until the `hubble` Vercel
project has a database — the site and release notes say so) and code signing
(SmartScreen / Gatekeeper warn on first open). Everything else found in this
audit is fixed.

## Status

| Area | Status | Evidence | Remaining issue |
|---|---|---|---|
| Desktop application | Works | Real: QA build (debug, separate identity) — projects, sessions, context, pairing all survive a normal close, a force-kill and a restart; first window in ~3 s; app bundle refuses to run in a plain browser | Low: search hint shows ⌘K on Windows |
| Chrome extension | Works | Real: pairing (same code both sides, Connect only after 1.5 s), save conversation into chosen project (no duplicate on re-save), Disconnect → reconnect, Chrome restart keeps pairing, Hubble restart keeps pairing | Medium: unpaired "send to Hubble" (take-in) still trusts any program on Hubble's port. Medium: pairing itself can't detect a fake Hubble already holding the port |
| Desktop → extension commands | Works | Real: open tabs read, session saved and reopened in a new Chrome window, history range, asleep extension woken; 54 Rust unit tests, extension + bridge tests | The OS handing the wake address to the default browser was not exercised (rig hands it to the test Chrome); if the default browser isn't Chrome, commands fall back |
| Authentication | **Blocked in production** | Code: PKCE + state, token in OS credential store, Bearer-only for device calls. Production probe: `POST /api/auth/desktop/token` → 503 "Accounts aren't available on this deployment yet." | **Critical:** the Vercel project `hubble` has no Postgres configured, so Sign in, sync and AI connectors fail for everyone. Needs database env, `migrate:auth` (+ sync/integrations), Google client and authorised origin |
| Context intelligence | Works | Real: turned on from Hubble, Chrome activity reached Hubble's store (4 records), survived restarts | Found and fixed: the extension dropped the desktop owner, so every pull came back empty |
| Knowledge Graph | Not exercised live | Unit tests (graph suites pass in the full run); its data is the project store, now crash-safe | — |
| Local storage | Works, crash-safe | Real: the full sequence ended by a force-kill keeps the newest project + conversation (before the fix it lost them, twice); a project survives a kill ~1 s after it was made | Fixed **High** (durable copy, below). Multi-account isolation: unit-tested namespaces only (no second real account) |
| Security | Fixed what was found | Unit + real: proof-before-token, allowlisted commands, per-link answers, loopback + Host checks, web origins refused | Fixed **Critical**: the extension sent its token (and saves) to whatever program answered on Hubble's port. Same-user malware can read Chrome's and Hubble's storage — out of scope |
| Windows installer | **Published (0.2.0)**; unsigned | Release `desktop-v0.2.0` (built from `17e7e5d9` by the release workflow): `Hubble_0.2.0_x64-setup.exe` / `.msi` — version 0.2.0, product Hubble, **NotSigned**; checksums verified against GitHub's digests. Real: QA-identity NSIS installs per-user in ~2 s, Start-menu entry, `hubble://`, uninstall entry; silent uninstall removes all of them | **Critical (launch quality):** no code signing → SmartScreen warning. Low: empty CompanyName in the .exe version info. The production-identity installer was not run on the audit machine (it holds real Hubble data) |
| macOS installer | **Published (0.2.0)**; never run | `Hubble_0.2.0_universal.dmg` (30.8 MB), checksum verified | Never installed or launched; unsigned and not notarized → Gatekeeper blocks a normal open (right-click → Open) |
| Linux installer | **Published (0.2.0)**; never installed | `.deb` control — `hubble` 0.2.0 amd64, depends libwebkit2gtk-4.1-0, libgtk-3-0; `.AppImage` 96.5 MB; checksums verified | Never installed. Sign-in persistence needs a Secret Service (gnome-keyring) at runtime, not declared |
| Marketing website | **Live**, midnight | Production (`hubblehq.vercel.app`, from `main`): launch site, `/welcome` → `/`, no app routes or "Open Hubble"; download buttons follow the published release. Local build of the merged site: 8 pages 200, no broken links, no overflow at 390/768/1440 px, palette test passes | — |

## Issues by severity

**Critical (blocks release)**
1. ~~Only `desktop-v0.1.0` is published~~ — **done**: 0.2.0 published 2026-11-21; the site offers it.
2. Production accounts unavailable (no database on the `hubble` Vercel project).
3. No code signing (Windows SmartScreen, macOS Gatekeeper).
4. ~~Token sent to whatever answers on Hubble's port~~ — **fixed** (`/v1/link/prove`).

**High**
1. ~~Crash / force-kill loses recent project edits~~ — **fixed**: every localStorage change is mirrored within ~100 ms to a durable copy in the app's data folder (`src-tauri/src/durable_store.rs`, `src/lib/platform/durable-storage.ts`; temp file → sync → rename) and restored before the app reads anything. The copy is trusted only while complete; a failed write drops that mark and Hubble falls back to localStorage. Not covered: IndexedDB (conversation text, files), which already commits per transaction.
2. ~~Website is not the midnight identity~~ — **done**: PR #60 merged on top of #59/#61.
3. ~~Context detection empty in Hubble Desktop~~ — **fixed**.
4. ~~Command lost when the extension went quiet right after collecting~~ — **fixed** (re-check and wake while waiting).
5. ~~New users not told they need Hubble for Chrome~~ — **fixed** (welcome offers Connect Chrome).

**Medium**
- Unpaired take-in sends tabs/conversation text to any program answering on Hubble's port (pairing protects the paired path only).
- Pairing can't tell a fake Hubble that grabbed the port first (a code typed into the popup would).
- macOS / Linux never run on a real machine.
- The extension still injects its content script into the website, which no longer uses it.

**Low**
- ⌘K shown on Windows; empty CompanyName; Debian `Maintainer` has no address.
- ~~Wake address recorded in Chrome history~~ — **fixed** (`history.deleteUrl`).

## How it was tested

- Rig scripts (session scratchpad, not committed): real Chrome 153 + unpacked extension driven by puppeteer; Hubble QA (`app.tabdump.desktop.qa`) driven over CDP. The QA build is compiled with `HUBBLE_QA_NO_OPEN` so Hubble's wake address is handed to the test Chrome instead of the tester's default browser (debug builds only).
- Conversation capture used a ChatGPT page served from a fixture at the real address (`chatgpt.com/c/…`), so the real reader, popup, worker and link ran; live ChatGPT markup was not re-checked.
- Not covered: real Google sign-in, a second real account, macOS/Linux hardware, the production-identity installer, auto-update (not implemented: the app checks `/api/desktop/release` and links the installer).
