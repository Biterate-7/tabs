# Releasing Hubble Desktop

How a Windows installer gets from this repository to the "Download Hubble"
button on `/download`. Nothing in this chain publishes on its own: the
workflow drafts, a person publishes, and a reviewed pull request turns the
website's link on.

```text
tag desktop-vX.Y.Z
    ↓  .github/workflows/desktop-release.yml (windows-latest, release profile)
DRAFT GitHub Release  ←  Hubble_X.Y.Z_x64-setup.exe + .sha256
    ↓  a person installs it on a clean Windows machine and checks it
PUBLISHED GitHub Release
    ↓  pull request: src/lib/desktop/release.ts → windows: "published"
hubble-hq.vercel.app/download → /api/download?platform=windows
    ↓  +1 to the aggregate count, then 302
the GitHub Release asset
```

Installers are never committed to Git and never served from Vercel.

## 1. Build a draft

1. Make sure `version` in `src-tauri/tauri.conf.json` is the version you are
   releasing.
2. Tag the commit and push the tag:

   ```bash
   git tag desktop-v0.1.0
   git push origin desktop-v0.1.0
   ```

   Or run **Actions → Desktop release → Run workflow** with an existing tag.
3. The workflow refuses a tag that does not match `tauri.conf.json`, builds
   with `tauri build --bundles nsis` (release profile — never `--debug`), and
   creates a **draft** release with the installer and its SHA-256.

The build receives no secrets, and the app bundles no credentials.

## 2. Check the draft before publishing

Download the installer from the draft and, on a Windows 10 or 11 machine
that has never had Hubble:

- [ ] The SHA-256 matches the `.sha256` file.
- [ ] The installer and the Start menu entry say **Hubble**, with the Hubble icon.
- [ ] Hubble opens to the app (not a dev server, no devtools).
- [ ] Settings → Desktop app says "You're running Hubble Desktop", shows the
      version you tagged, "Windows · 64-bit" and "Release" under Diagnostics.
- [ ] Projects, Search, Graph and Settings open; a new project can be made
      and a note written in it.
- [ ] Settings → AI apps lists ChatGPT, Claude, Gemini and Perplexity with
      what works on desktop.
- [ ] Hubble for Chrome's *Send to Hubble Desktop* delivers tabs.

Then publish the draft on GitHub.

## 3. Turn on the website's download

First make sure the download-count table exists in the production database
(once per database; it is idempotent):

```bash
node --env-file=<file holding the production POSTGRES_URL> scripts/migrate-downloads.mjs --expect-host=<ep-… endpoint or host>
```

Without it, downloads still redirect, and each one logs
`[downloads] could not count …` in the Vercel function logs.

In `src/lib/desktop/release.ts` change:

```ts
windows: { status: "unpublished" },
```

to the published version and the checksum from the release:

```ts
windows: { status: "published", version: "0.1.0", sha256: "<64 hex characters>" },
```

`release.test.ts` fails if the version does not match `tauri.conf.json`.
After the pull request deploys, check the endpoint. `curl` is never counted
(it is treated as automated), so these checks do not change the numbers:

```bash
curl -sI "https://hubble-hq.vercel.app/api/download?platform=windows"
curl -sI "https://hubble-hq.vercel.app/api/download?platform=banana"
curl -sIL https://github.com/Biterate-7/tabs/releases/download/desktop-v0.1.0/Hubble_0.1.0_x64-setup.exe
```

The first answers `302` with `Location` set to the release asset; the second
answers `400` with no `Location`; the third ends in `200`.

## 4. Download counts

`/api/download` adds one to a row per (UTC day, platform, version) in
`tabdump_desktop_downloads` and stores nothing else — no IP address, user
agent, cookie or account (src/lib/downloads/schema.sql). It counts a GET from
a browser; it does not count HEAD, speculative prefetches, Next.js router
prefetches, or user agents that call themselves bots, crawlers, link
previewers, headless browsers or command-line clients. Page views of
`/download` are never counted.

The counts are not served by any route. Read them with the database
credential:

```bash
node --env-file=<file holding the production POSTGRES_URL> scripts/report-downloads.mjs --expect-host=<ep-… endpoint or host>
```

Neither script reads `.env.local` or `.env`; both refuse to connect unless
`--expect-host` names the host the connection string points at.

Test downloads are indistinguishable from real ones in the table. Note the
count before and after a test download and subtract.

The download URL is built from the version alone. It always names this
repository's GitHub Releases, and `isOfficialReleaseUrl` refuses anything
else.

## Releasing 0.2.0 (desktop accounts, sync, connectors, the relay)

The app version is already **0.2.0** in `package.json`, `tauri.conf.json`
and `Cargo.toml`; `release.ts` still publishes **0.1.0** until 0.2.0 is
published (`release.test.ts` allows the app to be one version ahead,
never behind). In this order, each step done by a person:

1. **Database, before the web deploy.** Desktop sign-in needs the new
   `tabdump_device_sessions` table. The auth schema is additive and
   idempotent:

   ```bash
   node --env-file=<file holding the production POSTGRES_URL> scripts/migrate-auth.mjs --expect-host=<ep-… endpoint or host>
   ```

   Without it, `/api/auth/desktop/*` answer 500 and desktop sign-in fails;
   nothing else on the website is affected (the bearer path is only taken
   when an `Authorization` header is present).
2. **Deploy the website** (merge to `main`). This ships
   `/desktop/connect`, `/desktop/relay`, `/api/auth/desktop/*`,
   `/api/desktop/release`, and the Hubble for Chrome **0.9.0** ZIP (the
   relay's `deliver_to_desktop`). Check:

   ```bash
   curl -s https://hubble-hq.vercel.app/api/desktop/release
   curl -s -o /dev/null -w "%{http_code}\n" https://hubble-hq.vercel.app/desktop/connect
   ```

   An installed 0.1.0 can't use any of this — it predates it — but a 0.2.0
   build can be tested against production from here on.
3. **Tag and draft:** `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`
   (section 1). The workflow builds a release-profile NSIS installer.
4. **Check the draft** (section 2), plus: Settings → Account → Sign in opens
   the browser, Connect returns to the app signed in; Settings → Desktop
   app shows 0.2.0; Sessions → Save current session opens the relay page;
   Settings → Account on the web lists the desktop and Disconnect signs it
   out.
5. **Publish**, then change `windows` in `release.ts` to
   `{ status: "published", version: "0.2.0", sha256, bytes }` (section 3).
   Installed 0.2.0 apps then report "You have the latest version"; nothing
   tells a 0.1.0 install to update, since 0.1.0 has no update check.

No new Google configuration is needed: sign-in happens on the website's
own, already-authorized origin. `hubble://` is already registered by the
installer.

## Not done yet

- **Code signing.** The installer is unsigned, so Windows SmartScreen warns
  on first run ("Windows protected your PC"). Signing needs a certificate
  (or Azure Trusted Signing) and `bundle.windows.certificateThumbprint` /
  `signCommand` in `tauri.conf.json`. Do not tell users to bypass the
  warning in product copy.
- **macOS and Linux.** `tauri.conf.json` bundles Windows formats only. The
  site says macOS is "Coming soon" and Linux is "Not available" until a
  build exists and is published the same way.
- **Auto-update.** There is no updater; each version is a new download.
  Settings → Desktop app *checks* for one: it reads
  `GET /api/desktop/release` on the deployed site (this table, served with
  `Access-Control-Allow-Origin: *`) and, when a newer version is published,
  links its installer through `/api/download` and its release page. The
  person downloads and runs it; Hubble never installs anything itself. A
  real updater (`tauri-plugin-updater`) needs an update-signing key pair held
  as a CI secret and a signed `latest.json` on each release — not set up.
