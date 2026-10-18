# Projects and sources

A **project** is where everything a person learns and makes with AI
accumulates: conversations saved from ChatGPT, Claude, Gemini and Perplexity,
the pages, PDFs and videos they read, and their own notes. This document
covers the source half — how links become readable sources. The conversation
and note half, search across both, and reusing them in another AI chat are in
[cross-ai-memory.md](./cross-ai-memory.md).

```
Chrome ─drag / extension / Add─► Project ─► Sources (read by Hubble) ─► search · reader · context bundles
```

## 1. Architecture: what is a project

Nothing here is a parallel system. Hubble's **workspace** already was the
durable object a project needs: name, brief, saved tabs, collections. So:

| Product concept | Implementation | Notes |
|---|---|---|
| Project | `Workspace` | Surfaced as "Project" everywhere. Storage keys and protocol ids are unchanged (`tabdump:*`). |
| Project brief / goal | `Workspace.brief.description` / `.focus` | The New project dialog asks for both. |
| Source (resource) | `Tab` + `Tab.resource` | One record. A saved tab becomes a source by gaining `resource`; every existing tab surface keeps working. A saved AI conversation is a source of kind `conversation`. |
| Note, excerpt, pasted conversation | `Workspace.notes` (`lib/notes`) | Device-local, body in the content store — see cross-ai-memory.md. |
| History | `lib/projects/activity.ts` | Content-free project history. |
| Collections / groups of sources | Existing collections | "Primary sources", "Videos" … are ordinary collections of source tabs. |

Modules:

- `src/lib/resources/` — the source domain: `types.ts`, `detect.ts`
  (`detectResourceType`), `url.ts` (`resourceKey`, the duplicate identity),
  `ingest.ts` (the **one** ingestion pipeline), `drop.ts` (drag payloads),
  `read.ts` (defensive reader for stored records), `content-store.ts`
  (IndexedDB), `process.ts` (reading a source), `html.ts`, `pdf.ts`,
  `transcript.ts`, `search.ts`, `context.ts` (the context budget),
  `extraction.ts` (wire contract), `server/fetch.ts` + `server/extract.ts`.
- `src/app/api/resources/extract/route.ts` — the reader.
- `src/lib/projects/activity.ts` — project history.
- `src/components/project/` — the project page (Knowledge Centre), resource
  cards, Add source, source details, drop zone, activity, "Add to project".
- `src/hooks/use-resource-processing.ts`, `use-project-contents.ts`,
  `use-project-activity.ts`.

## 2. The resource model

```ts
type TabResource = {
  kind: "webpage" | "pdf" | "youtube" | "video" | "document" | "unknown"
  origin: "chrome" | "extension" | "manual" | "upload" | "import"
  status: "pending" | "processing" | "ready" | "partial" | "failed"
  addedAt: number; updatedAt: number
  meta?: { mimeType, siteName, author, publishedAt, description, pageCount, durationSeconds, fileName, fileSize }
  content?: { chars, pages?, transcriptLines?, truncated?, extractedAt }   // a summary — never the content
  error?: { code, message, retryable }
  attempts?: number
}
```

`id`, `url`, `title`, `domain` and `notes` are the tab's own fields. Statuses
are honest by construction:

- **ready** only when extracted content was written to the content store first
  (`processSource`), and `read.ts` demotes a stored "ready" without a content
  summary back to pending;
- **partial** = saved with metadata only, with the reason in words (a PDF behind
  a login: "PDF detected. Hubble needs the file itself…"; a video: "Transcript
  isn't available…"; a page that is a script shell: no readable text);
- **failed** = nothing usable (network, timeout, private address);
- **processing** never survives a reload (back to pending), and a source
  interrupted three times becomes failed with *Read again*, so nothing spins
  forever. Every async path ends in ready, partial or failed.

Extracted content lives in IndexedDB (`hubble-resources` / `content`), keyed
`<account namespace>|<project>|<tab>`, read lazily (project search, source
details, context bundles), bounded per source (`CONTENT_LIMITS`). A "ready"
source whose content is missing on this device (cleared storage, data copied
between accounts) is read again automatically.

**Content follows its tab** (`use-resource-processing.ts`). Tabs leave a
project by many doors (Remove, delete/Clean up in the tab view, the graph,
Clear, moves, deleting the project, deletions arriving by sync), and the store
is the one authority watched. A tab that disappears takes its content out of
reach at once (search, the reader and context bundles only look at a project's
current tabs), but the content stays on the device until the **next page load**: every
Undo lives in the page, and a toast's Undo can come minutes later (Sonner
pauses toasts while hovered or while the window is hidden) — deleting on a
timer would let Undo restore an uploaded PDF or pasted transcript empty. A tab
moved to another project has its content carried to the new key
(`moveContent`). Once per page load, after `CONTENT_GRACE_MS` (60 s, for sync
to settle), `pruneContentExcept` removes this account's records for tabs that
were already gone at load and still are — keys only, never another account's,
skipped if the account changed. Remove's toast closing without Undo and
deleting a project still forget at once. All idempotent.

Sync carries a tab as before; `resource` is device-local like the brief, and a
remote edit to the same page keeps the local reading (`lib/sync/apply.ts`).
Stored data is re-read defensively on load (`stripWrongTypedTabFields` →
`readTabResource`); no migration is needed, existing tabs are untouched.

### Type detection and duplicates

`detectResourceType({ url, mimeType?, fileName? })`: a MIME type wins (the
server's Content-Type or `%PDF-` bytes — `/download?id=7` can be a PDF and
`/paper.pdf` can be a login page), then providers (every YouTube address
shape; Vimeo and other video hosts), then the extension, then *web page*.

`resourceKey(url)` folds scheme, `www.`/`m.`, host case, fragment, trailing
slash, needlessly-encoded characters, tracking parameters (`utm_*`, `fbclid`,
`gclid`, `si`, …) and parameter order, and every YouTube shape of one video to
`youtube:<id>` — and keeps every other query parameter and the path's case.
Adding a known source is "Already in History IA", with *Open source*; adding
the address of a plain saved tab of the same project makes *that tab* a source.

## 3. Ingestion

`ingestResources(store, projectId, inputs, origin, now)` is the only way a
source is created. Callers: the Chrome drop zone, *Add source*, the
extension's *Add to project*, *Add to project* on any tab menu and the
selection toolbar (the migration path from old tab dumps). Each input gets one
outcome — `added`, `adopted`, `duplicate` or `invalid` — so a batch never fails
as a whole ("4 added · 1 couldn't be added"). The shell commits it once, says
what happened in one toast with an exact *Undo*, records a content-free
project event and starts reading.

## 4. Drag and drop from Chrome — and its limits

`useExternalDrop` listens on the window while a project is on screen. A drag
that started inside the page (moving a tab into a collection, selecting text)
is ignored; an external one shows a fixed overlay ("Drop into History IA ·
+ Add to project") — no layout shift — and Escape or leaving the window
cancels. `readDroppedResources` reads, richest first and merged by address:

| Payload | Comes from |
|---|---|
| `text/uri-list` + `text/plain` + `text/html` (anchor) | a link, or the address bar / site-info chip, dragged out of Chrome or Edge |
| `text/x-moz-url` (url/title pairs) | one or **several selected tabs** dragged out of Firefox's tab strip |
| `application/x-hubble-tabs` | reserved for Hubble's own extension surfaces |
| `text/plain` with addresses | a dragged text selection |
| `Files` | a downloaded file |

**Browser limitation, stated plainly:** Chrome's (and Edge's) own tab strip does
not take part in HTML drag and drop. Dragging a tab moves it between windows;
no web page receives a drop event or any data. That cannot be changed from a
page — and not from an extension either (see *Why not a real tab drag* below).
The supported Chrome paths are therefore:

1. **Quick add from the tab itself** (Hubble for Chrome 0.4): right-click any
   tab in the tab strip → **Add to History IA**. If the tab is part of a
   selection (ctrl/shift-click), the whole selection goes, as with Chrome's own
   tab menu. The same item is on the page's right-click menu, and
   **Alt+Shift+H** (changeable at `chrome://extensions/shortcuts`) adds the
   current tab or the selected tabs. A small toast in the page you are on
   always names the project: *Adding to History IA…* with the source's title
   and *Reading source…* while Hubble reads it, then *Added to History IA* ·
   title · *Ready · 1,840 words* (or *Saved · why* / *Couldn't read · why*),
   with *Open in Hubble*. A duplicate says *Already in History IA — This
   source is already in the project.*; a failure says *Couldn't add to
   History IA* and why. On Chrome's own pages, where no extension may draw,
   the toolbar icon's badge and tooltip say it instead.
2. Drag the address-bar URL or the site-info chip, or any link, onto the
   project ("Drop into History IA" while dragging, "Added to History IA" after).
3. The extension popup, which leads with the same project — *Add to History
   IA*, then *Add this tab* / *Add selected tabs* and *Right-click any tab to
   add it directly. Alt + Shift + H*. Its project picker is there but quiet;
   the plain *Dump tabs* stays below it and never targets a project.
4. *Add source*.

Firefox tab drags (including several tabs at once) are handled natively.

**In Hubble**, once the extension has answered, the project home teaches it
once — in the empty state until the project has sources, then as one quiet
line under *Context*: *Add anything useful from Chrome to this project.
Right-click a tab → Add to History IA. Alt + Shift + H also works.* Without
the extension it offers only what works without it (links, the address bar,
*Add source*).

**The target project** is the project you are looking at in Hubble: the page
reports it (`TABDUMP_PROJECT_FOCUS`, with every project's id and name and
whether the page is visible) when it loads, when you switch projects and when
you come back to Hubble, and the menu item is retitled to name it, so you see
where the tab goes before choosing. Choosing another project in the popup sets
it until you next look at Hubble. A Hubble tab the extension opened in the
background to deliver a batch is hidden, so it never overrides anything. A
remembered project that has been deleted is never sent to — the page acks
`project-missing` and the toast says the project is gone.

Quick add is not a second ingestion path: it is the popup's `TABDUMP_IMPORT`
with a project target, through the same delivery, ack and `ingestResources`,
so duplicate detection, extraction and project isolation are identical.

**Why not a real tab drag (checked 2026-10-07 against the current Extensions
reference; Chrome 154 accepts the tab-strip menu item).** The Extensions
API has no tab-drag events: `chrome.tabs` exposes `onDetached`/`onAttached`/
`onMoved` (a tab *has* moved between or within windows) and only documents the
drag indirectly, as the error *"Tabs cannot be edited right now (user may be
dragging a tab)"*. Nothing reports a drag starting, the pointer's position, or
what it was released over, and no drag payload exists for a page, side panel or
offscreen document to read. Inferring "dropped on Hubble" from a torn-off
tab's new window landing over Hubble's window would rest on undocumented
window-placement behaviour and fire on every ordinary tear-off, so Hubble does
not do it. The tab strip's own context menu (`chrome.contextMenus`,
`contexts: ["tab"]`) is the closest documented interaction with an actual tab.

A dropped **file** has no web address, and a source is always openable (sync,
the opener and the extension all depend on it), so a dropped PDF is attached
to the PDF source waiting for it (the one asking for its file, or the one whose
file name matches); otherwise Hubble explains how. Mobile has no drag; *Add
source* is always available and keyboard-accessible.

## 5. Reading sources

`POST /api/resources/extract` with a text/plain JSON body `{ url, kind? }`,
one source per request:

- **Web pages:** HTML (≤ 3 MB) → `readHtml`: article/main text with paragraph
  breaks, navigation/headers/footers/scripts removed, title, site, author,
  date, description. Under 280 readable characters is `partial` ("no readable
  text"), never "ready".
- **PDFs:** bytes (≤ 15 MB) → `unpdf` (pdf.js) → text **per page**, page count,
  title/author. Behind a login or 403 → `pdf_needs_file`; *Upload PDF* reads
  the file **in the browser** (it never leaves the device). A scan with no text
  layer says so.
- **YouTube:** the public oEmbed endpoint for title and channel, and — in the
  same round trip — the video's **existing captions** from a transcript
  provider (`server/transcripts.ts`), when the server has `SUPADATA_API_KEY`.
  YouTube's own captions API only serves a video's owner, and Hubble does not
  scrape watch pages or get past YouTube's bot checks itself, so without a
  key a video is saved `partial` with "Automatic transcripts aren't set up".
  `mode=native` only: never speech recognition, never the audio. Only the
  watch URL rebuilt from the validated 11-character id is sent, to one fixed
  host, redirects refused; answers ≤ 8 MB, 20 s timeout; found transcripts
  cached in memory a day and "no captions" six hours (transient failures not
  at all), concurrent requests for one video share one call; a separate
  allowance of 60 transcripts per IP per 10 minutes, past which the video is
  still saved and says "try again in a few minutes". The person can always
  add a transcript themselves (paste from YouTube's *Show transcript*, or a
  .vtt/.srt/.txt file); it is parsed with timestamps and labelled `supplied`.
  Never fabricated: an empty or malformed answer is never `ready`. Videos saved
  before this (with the old "Transcript isn't available" words) are read once
  more on load (`read.ts`).
- **Transcripts** are `TranscriptSegment[]` (`start`, `end` in seconds, `text`)
  in playback order, plus `transcriptInfo` (`captions`|`supplied`, language,
  provider); the tab's summary gains `language`. All fields optional, so stored
  records from before still read. `normalizeTranscript` cleans entities and
  markup, drops empty lines and bad times, restores order and collapses
  rolling repeats — on the server and again in the browser.
- **Safety:** no cookies or credentials are forwarded; redirects are followed
  by hand and **every hop and its DNS answer** is checked against private
  addresses (the title resolver only checked the first URL); per-IP rate limit;
  CORS-simple so the desktop app can call the deployed route.

Text is untrusted. It is stored as-is, and wherever it leaves Hubble it is
framed as quoted reference material: in a context bundle it is a quotation
under its origin (cross-ai-memory.md), and the MCP tools that let ChatGPT,
Claude or Gemini read a project carry a fixed provenance line.

## 6. Searching sources

Search covers source titles, addresses, notes, extracted text, PDF pages,
transcripts and saved AI conversations (by turn, and whether the person or
the AI said it), and respects the kind filter. The same engine answers a
project's own search box and the Search page across every project
(`lib/memory/search.ts`).

**Timestamped transcript search** (`search.ts` — the one engine; there is no
separate index). A transcript is searched as passages (a line and the two
after it, within 20 s) anchored on a line that says a query word, so a phrase
split across caption lines matches and "at 8:42" is when it is said. Every
word must be in the passage; the words in the order typed score a bonus;
overlapping or back-to-back hits (≤ 15 s apart, ≤ 90 s total) are one
result; at most five moments per video. Normalized lines are cached per
stored transcript (a `WeakMap`), so typing re-scans but never re-processes.
Surfaces: the project's search (row → the video's reader at that line;
*▶ 8:42* → YouTube at `&t=522s`), ⌘K's **Said in your videos** group across
all projects (`useTranscriptSearch` loads only transcript records, only while
the palette is open), and Search (every project). A moment's link is always rebuilt from
the video id — never the saved address — so a saved `?t=30` never shifts a
result, and `handleOpenSource` only opens an override that `sameResource`
confirms is the same video.

**The reader** (`video-transcript.tsx`, inside the source details dialog):
the privacy-enhanced embed, loaded only on Play, seeked through YouTube's
iframe messaging (`seekTo`; `infoDelivery` marks the line being said, from
the player's origin only); in-transcript search with marked words; states for
extracting, loading, ready, unavailable (with *Try again* only when a retry
could help), and missing from this device. Desktop has no frames and no
remote images (Tauri CSP), so there a time opens YouTube instead.

## 7. The extension

`extension/` (0.7.0). The popup's round trip to the open Hubble page returns
the projects (ids, names, item counts). *Add to a project*: choose a project
(pre-selected: the project open in Hubble, or the last one chosen here), then
*Add this tab* or *Add N selected tabs*. Quick add (§4) uses `contextMenus`
and `activeTab` and one command; `extension/src/quick-add.js` holds its pure
parts, `background.js` the wiring, `src/hooks/use-extension-quick-add.ts` the
page's half. Background sends `TABDUMP_IMPORT` with
`target: { workspaceId, as: "sources" }` through the same hardened delivery
path as a dump (find or open Hubble, ack handshake); the page routes it to the
ingestion pipeline and acks `{ accepted, duplicates }` — "Already in History
IA" is a success, not an error. The ordinary dump is unchanged (no target).

On an AI app's conversation page the popup also offers **Save to Hubble** and
**Use Hubble in this chat** — see cross-ai-memory.md.

## 8. Hosted, local and desktop

- **Web (hosted):** projects, sources, reading, search and the project page all
  work.
- **Desktop (Tauri static export):** no API routes ship, so the client calls
  the deployed `/api/resources/extract` (already in the CSP's `connect-src`,
  answered with `Access-Control-Allow-Origin: *`). Until this route is
  deployed to production, desktop sources stay partial/failed with a reason —
  never a fake "ready". PDF uploads and transcripts work offline.
- No analytics. The local loop log (`hubbleLoopSummary()`) counts
  `project_created`, `resource_added/ready/failed`, `project_returned` and
  the capture/find/reuse milestones, never content.

## 9. Testing

```bash
npm test                                   # everything (~17–30 min here)
npx vitest run src/lib/resources           # detection, URLs, ingestion, drop payloads, real PDF parsing, extraction, budget, search
npx vitest run src/lib/projects            # project history
npx vitest run src/components/project      # project page: drop, add source, statuses, remove, use in AI chat
npx vitest run extension                   # extension incl. add-to-project.test.js
```

- PDF tests parse a real PDF built byte by byte (`lib/resources/__fixtures__/pdf.ts`).
- Live browser QA used system Chrome via puppeteer: drops are delivered with
  CDP `Input.dispatchDragEvent` (Chrome's own drag pipeline into the page) and
  the extension is loaded unpacked (`Extensions.loadUnpacked`).
