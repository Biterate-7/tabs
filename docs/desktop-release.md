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

The build receives no secrets. Provider credentials are never bundled: every
agent signs in on the user's machine through its own sign-in.

## 2. Check the draft before publishing

Download the installer from the draft and, on a Windows 10 or 11 machine
that has never had Hubble:

- [ ] The SHA-256 matches the `.sha256` file.
- [ ] The installer and the Start menu entry say **Hubble**, with the Hubble icon.
- [ ] Hubble opens to the app (not a dev server, no devtools).
- [ ] Settings → Desktop says "You are running Hubble Desktop".
- [ ] Command Centre → Connect agent: Claude Code, Codex, Gemini CLI and Grok
      Build show their real local state (installed / sign-in required /
      not installed), not "Unavailable here".
- [ ] Quitting Hubble leaves no agent process running.

Then publish the draft on GitHub.

## 3. Turn on the website's download

First make sure the download-count table exists in the production database
(once per database; it is idempotent):

```bash
npm run migrate:downloads
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
npm run downloads:report
```

Test downloads are indistinguishable from real ones in the table. Note the
count before and after a test download and subtract.

The download URL is built from the version alone. It always names this
repository's GitHub Releases, and `isOfficialReleaseUrl` refuses anything
else.

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
