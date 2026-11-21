# Releasing Hubble Desktop

How installers get from this repository to the "Download Hubble" button on
the website. Nothing in this chain publishes on its own: the workflow drafts,
a person publishes, and the website follows what was published.

```text
version bump (package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml)
    ↓  + docs/release-notes/X.Y.Z.md
tag desktop-vX.Y.Z
    ↓  .github/workflows/desktop-release.yml (release profile, three runners)
DRAFT GitHub Release  ←  Hubble_X.Y.Z_x64-setup.exe, Hubble_X.Y.Z_x64_en-US.msi,
                         Hubble_X.Y.Z_universal.dmg, Hubble_X.Y.Z_amd64.AppImage,
                         Hubble_X.Y.Z_amd64.deb, SHA256SUMS.txt
    ↓  a person installs each one on a clean machine and checks it
PUBLISHED GitHub Release
    ↓  within 10 minutes (ISR + the GitHub Releases API; src/lib/desktop/release-source.ts)
hubblehq.vercel.app  /  /download  →  /api/download?platform=…[&format=…&arch=…]
    ↓  +1 to the aggregate count, then 302
the GitHub Release asset
```

Installers are never committed to Git and never served from Vercel.

## 1. Build a draft

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (the workflow refuses a tag they don't all match),
   and write `docs/release-notes/X.Y.Z.md` — it becomes the top of the
   release notes the download page shows.
2. Merge, then tag the merge commit and push the tag:

   ```bash
   git tag desktop-v0.2.0
   git push origin desktop-v0.2.0
   ```

   Or run **Actions → Desktop release → Run workflow** with an existing tag.
3. The workflow builds with `tauri build --bundles …` (release profile — never
   `--debug`) on Windows, macOS (universal: Apple silicon and Intel) and
   Ubuntu 22.04, and creates a **draft** release with every installer and a
   `SHA256SUMS.txt`. A pull request that touches the app has already built all
   three (`desktop-build.yml`), so a tag should not discover a broken platform.

The build receives no secrets except optional Apple signing secrets (below),
and the app bundles no credentials.

## 2. Check the draft before publishing

On a machine that has never had Hubble, for each OS:

- [ ] The checksum matches `SHA256SUMS.txt` (GitHub also shows each asset's digest).
- [ ] The installer, the Start menu / Applications / app menu entry say **Hubble**, with the Hubble icon.
- [ ] Hubble opens to the app (not a dev server, no devtools) and to "Welcome to Hubble" on a first launch.
- [ ] Settings → Desktop app shows the version you tagged and "Release".
- [ ] A project can be made and a note written in it; quit and reopen — it is still there.
- [ ] Hubble for Chrome: **Connect to Hubble Desktop** shows the same code in the popup and in Hubble; Connect; the popup then lists your projects.
- [ ] Save a ChatGPT conversation into a project from the popup; it appears in Hubble.
- [ ] Quit Hubble, save another conversation: the popup says it's waiting; open Hubble — it arrives within a minute.
- [ ] Settings → Account → Sign in opens the browser and returns signed in.

Then publish the draft on GitHub. **That is the whole website change**: `/`,
`/download`, `/api/download` and `/api/desktop/release` read the newest
published `desktop-v*` release (drafts and prereleases are never read) and
take only installer file names Tauri produces for that version
(`src/lib/desktop/artifacts.ts`). A platform with no installer in the release
shows "Not available yet" and offers nothing.

`src/lib/desktop/release.ts` `DESKTOP_BUILDS` is now only the fallback used
when GitHub can't be reached. Update its Windows entry to the new version and
checksum in a follow-up pull request so the fallback is current.

After publishing, check (curl is never counted):

```bash
curl -s https://hubblehq.vercel.app/api/desktop/release
curl -sI "https://hubblehq.vercel.app/api/download?platform=windows"
curl -sI "https://hubblehq.vercel.app/api/download?platform=macos"
curl -sI "https://hubblehq.vercel.app/api/download?platform=linux&format=deb"
```

Each answers `302` to the release asset (or `404` for a platform the release
doesn't have).

## 3. Code signing

Not set up: there are no certificates. Until there are, Windows SmartScreen
("Windows protected your PC") and macOS Gatekeeper warn on first run. Do not
tell people to bypass the warning in product copy.

- **macOS:** add repository secrets `APPLE_CERTIFICATE` (base64 .p12),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for
  notarization `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.
  The release workflow exports them only when set; Tauri then signs and
  notarizes the `.dmg`.
- **Windows:** a code-signing certificate (or Azure Trusted Signing) and
  `bundle.windows.certificateThumbprint` / `signCommand` in `tauri.conf.json`.

## 4. Automatic updates

Not implemented. Settings → Desktop app *checks*: it reads
`GET /api/desktop/release` on the deployed site and, when a newer version is
published, links its installer and release page; the person installs it. A
real updater (`tauri-plugin-updater`) needs an update-signing key pair (the
private key as a CI secret) and a signed `latest.json` on each release.

## 5. Download counts

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

