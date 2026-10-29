# Context intelligence

Hubble notices the work a person does in Chrome — AI conversations, research
pages, documents — suggests which project it belongs to, and helps them pick
it up again. "Work anywhere. Hubble keeps your context connected."

```
Detect ──► Understand ──► Connect ──► Suggest ──► Confirm ──► Preserve ──► Resume
extension   features.ts    match.ts    engine.ts    the person   ingestResources  resume.ts
activity    (topic words)  cluster.ts  (stable,     (review)     + Save to Hubble + sessions
                                        deduped)                   job (text)
```

Nothing here is a second project, source or session system. An activity
record is a note that Chrome showed a page. Accepting a suggestion puts its
pages through `applySmartToSubjects` → `ingestResources`, the door every
source comes through; a conversation's text arrives through the existing Save
to Hubble capture queue; Resume opens the project and reuses saved sessions.

## Where things live

| Piece | File |
| --- | --- |
| Which pages may be noticed (sensitive sites, categories, modes) | `extension/src/context-sites.js` (enforced) · `src/lib/intelligence/sites.ts` (page copy; `sites.test.ts` holds them together) |
| Collector: records, dedupe, dwell, retention, conversation reading, sync cursor | `extension/src/context-activity.js` |
| Tab/window/permission events, context commands, permission window | `extension/background/background.js` ("Context detection"), `extension/permissions/grant.js` (`purpose=context`) |
| Command validation | `extension/src/browser-commands.js` (`CONTEXT_ACTIONS`; background answers them only for Hubble's own top frame) |
| Nudge relay (carries nothing) | `extension/content/content-script.js` (`HUBBLE_CONTEXT_CHANGED`) |
| Types | `src/lib/intelligence/types.ts` |
| Record validation, merging, capture wording | `src/lib/intelligence/records.ts` |
| Bridge client (closed-shape answers) | `src/lib/intelligence/bridge.ts` |
| Pull merge, clear | `src/lib/intelligence/sync.ts` |
| Features, similarity provider, temporal, project match, clustering | `features.ts`, `similarity.ts`, `temporal.ts`, `match.ts`, `cluster.ts` |
| Thresholds | `scoring.ts` (`DEFAULT_CONFIG`) |
| One inference run, suggestion lifecycle | `engine.ts` |
| Decisions (accept, dismiss, undo, forget) | `decisions.ts` |
| Suggestion → Smart Organize proposal | `proposal.ts` |
| Wording (headline, explanation) | `explain.ts` |
| Smart Resume (recommendation, checkpoint, summary) | `resume.ts`, `restore.ts` |
| Persistence (`tabdump:context:v1`, account-scoped) | `persistence.ts`, `state.ts` |
| Settings (held by the extension) | `settings-store.ts` |
| Sync hook (pull + infer) | `src/hooks/use-context-intelligence.ts`, mounted once in `app-shell.tsx` |
| UI | `src/components/intelligence/*`, Settings → Context (`settings/sections/context-section.tsx`) |

## 1. Consent and permissions

Detection is **off** until the person chooses. Home shows a one-line
invitation once Hubble for Chrome is connected and nothing was chosen
("Not now" defers it for 14 days); the dialog offers:

| Mode | What is noticed |
| --- | --- |
| Automatic | Any ordinary http(s) page, except the always-skipped ones below and the person's exclusions |
| Only sites I choose | Only the ticked categories: AI apps, Documents, Research (journals, .edu/.gov…), Video |
| Manual | Nothing. Every existing manual flow works as before |

**Always skipped, in every mode** (`isSensitiveUrl`, `isDetectable`): mail,
messaging and social apps, banking/payments/crypto, health portals, password
managers, sign-in/account/checkout/settings pages on any site, private
(incognito) windows, Hubble itself, localhost and private addresses, and
anything that is not http(s). Their titles alone can carry an email subject
or a message, so not even the title is kept.

**Chrome permissions.** Metadata detection needs no new permission: the
extension already holds `tabs` (address, title and icon of every tab), which
Chrome disclosed at install. No permission was added to the manifest.
Reading a conversation's text in the background needs that AI app's
**optional host permission** (already declared for Use in AI). It is asked
for in the extension's own window (`permissions/grant.html?purpose=context`),
one app at a time, only for apps the person ticked; "no" leaves that app
matched by title. Revoking it in Chrome (`permissions.onRemoved`) drops every
topic word read from that app and the UI says "Waiting for Chrome's
permission".

Settings → Context holds every control: mode, categories, pause (indefinite
or one hour), per-app conversation reading with the real grant state,
suggestion frequency (Normal · Only strong · Off), never-detect sites
(adding one also removes what was kept from it), retention (7/30/90 days),
the list of everything kept with per-row Remove, and Clear activity.

### Accounts on a shared Chrome

Activity and consent live in one Chrome profile; several Hubble accounts may
use it (a family or school computer). Each account — and signed-out Hubble —
has its own random context id (`src/lib/intelligence/owner.ts`, stored in its
own namespace; never the account id or an email), sent with every context
command and required by the validator. The extension binds consent and
activity to the id that opted in (`settings.owner`) and answers no other:
another account sees detection as not set up, receives no records, no open
tabs, can't forget, clear or save through it, and isn't told the first
account's choices. When it opts in itself, the previous account's activity is
cleared first and its settings don't carry over. A Hubble tab in a private
window is refused every context command.

**Manual mode** (or another account's choice) also stops suggestions: what
was kept before is not acted on, and waiting suggestions are put away.

## 2. Collection (extension)

Event-driven, MV3-safe, no polling: `tabs.onUpdated` (status `complete`; title
changes debounced 1.5 s), `tabs.onActivated`, `windows.onFocusChanged`,
`permissions.onRemoved`, all registered at module scope.

- **One record per page** (`activityKeyOf`: conversation identity, YouTube
  id, else the address without fragment, tracking parameters, www/m, trailing
  slash). Reloads, title flicker and the same page in two tabs update one
  record; a tab that moves to another address within 10 s keeping its title
  (a redirect, e.g. Wikipedia's Pigovian_tax → Pigouvian_tax) stays one
  record. Nothing is written unless something material changed (new page,
  URL, title, icon, visit, day, or `lastSeenAt` older than a minute).
- **Turning detection on** (or resuming it) notices the tabs already open, once.
- **Fields**: address, title (cleaned of hidden/bidi characters; Chrome's
  "address as title" while loading is ignored, and so are error titles —
  Chrome interstitials such as "Connect to Wi-Fi" or "Privacy error", bot
  checks, rate limits, "Page not found" — whose address is the page's but
  whose title is not), domain, kind, provider (from the address), Chrome's
  icon, first/last seen, visits (activations ≥ 30 min apart), approximate
  dwell (time in front: a tab switched to, or a page that loads in the tab
  already in front; capped 30 min per visit and never more than the page has
  existed; focus kept in `storage.session`), local days used (≤ 14), capture
  status.
- **Bounded**: 400 records, retention-pruned every few minutes, 400
  tombstones for sync. Writes coalesced (800 ms). Survives worker restarts —
  everything is in `chrome.storage.local`.
- **Sync**: the page pulls `get_context_activity {since, epoch}`; the answer
  carries changed records, removed keys and the open tabs' addresses. A new
  epoch (cleared, reinstalled) answers everything with `reset`. After a write
  the background nudges open Hubble tabs (`HUBBLE_CONTEXT_CHANGED`, ≤ every
  3 s, no payload); the page also pulls on connect, focus and visibility.

### Capture status — never more than is known

| Status | Meaning |
| --- | --- |
| `detected` | Address only (no title yet) |
| `metadata` | Address and title — what Chrome reports |
| `content` | Text read with permission; only topic words + count + hash kept |
| `partial` | Read, but only part was on the page (virtualized thread, older messages not loaded) |
| `unavailable` | A read was tried and failed (layout not recognised, empty, error) |

The page re-checks every record (`readActivityRecord`): a `content` claim not
made by a page read is downgraded to `metadata`, sensitive addresses are
refused, the provider is derived from the address.

### What each integration can actually do

| Source | Detected (metadata) | Text read in the background | Text saved on accept |
| --- | --- | --- | --- |
| ChatGPT | yes | opt-in + host permission, with the existing reader (`readConversationFromPage`). The background path was verified in real Chrome on the real address with fixture markup (§8); the reader itself was live-verified for Save to Hubble in Oct 2026 | yes, through the Save to Hubble job, while the tab is open — verified in real Chrome (fixture markup) |
| Claude | yes | same code path; the reader is fixture-tested only for this path; long chats are virtualized → `partial` | same (partial noted); not exercised in real Chrome |
| Gemini | yes | same code path; fixture-tested reader | same; not exercised in real Chrome |
| Perplexity | yes | same code path; virtualized → `partial` | same; not exercised in real Chrome |
| Google Docs / Drive, Notion, Overleaf | yes (title, address) — real Chrome: a signed-out private Doc ends on Google's sign-in page (never recorded); a missing Doc shows "Page not found" (kept as address only) | **no** — no authorized document connector exists; `gap: not-readable` | saved as a link; Hubble's reader handles what it can (public pages only) |
| Web articles, PDFs, videos | yes | no (titles only for matching) | saved as sources; read by the existing pipeline (`/api/resources/extract`, transcripts) like any added page |

A conversation accepted while its tab is closed, or without reading enabled,
is saved as a link-only conversation (`needs_capture`), and the toast and
review dialog say so: open it and use Save to Hubble for the text.

## 3. Inference (page, local, deterministic)

No AI service, no network, no key. Everything runs in the page from data
Hubble already holds.

1. **Features** (`features.ts`): a page's title topic words (Smart Organize's
   own reading — site names, generic and page-type words removed, light
   stemming, "-es" plurals folded) plus, when read, its text's topic words at
   0.6 weight; a niche site's identity at 0.35. A project: its name (2.5),
   brief, every item's title (log-scaled), notes, and pages the person
   confirmed for it.
2. **Semantic** (`similarity.ts`): a `SimilarityProvider` interface; the
   shipped provider is IDF-weighted topic words — cosine between pages,
   coverage (how much of a page's topic the project covers, × evidence
   strength for 1/2/3+ shared words) against projects. A richer provider
   (on-device embeddings, a consented remote model) can replace it with this
   as the fallback.
3. **Existing projects first** (`match.ts`): coverage + a bonus when the page
   names the project's subject alongside topic evidence; × (1 + 0.2 ×
   temporal) when the project was worked on at the same time (only above a
   floor — timing never creates an association); × (1 − 0.7 × similarity to
   pages the person rejected for that project). One shared word alone is at
   most "review" (evidence strength 0.45), never a default. A second pass
   lets a page strongly matched to a project count as provisional evidence
   (0.6 per word) for it — only its words that the project confirms or that
   were read from its text, never an incidental title word.
4. **New bodies of work** (`cluster.ts`): average-linkage clustering of what
   no project covers; pages it leaves out get a second route (`linkedGroups`):
   pages each strongly linked (≥ 0.33) to another, connected, with one word
   shared by a majority of at least three — always offered for review. A group
   that, taken together, fits a project goes there; otherwise ≥ 3 coherent
   pages (or 2 with read text and strong cohesion) become a "create project"
   suggestion, named from the words its titles share in title order — **only
   if the group holds study material**: a document, a PDF, or a reference or
   academic source (`isStudySource`). Personal browsing that shares a word
   (London cafés and the tube map, headphone shops plus a chat about them) is
   never proposed as a project.
   Words only one page or project uses count at half weight (as in Smart
   Organize), so idiosyncratic title words don't swamp shared ones.
5. **Scoring** (`scoring.ts`): normalized 0..1; strong ≥ 0.5, review ≥ 0.3,
   below = insufficient (nothing said). Calibrated on `engine.test.ts`
   fixtures (cases A–J below) — **not a measured accuracy**; retune from pilot
   decision counts.

**Feedback.** Accept → confirmed association (never overridden, never
re-suggested). Taking a page out in review, or choosing another project →
rejection for that target. "Not relevant" → rejected everywhere. "Not now"
→ snoozed 3 days. Rejections keep ≤ 12 stemmed words so similar pages are
trusted less for that target; no personal profile is built.

**Suggestions** (`engine.ts`): one open suggestion per project (new pages
join it), a new-project suggestion keeps its id while most pages are the
same, a page is in at most one open suggestion, at most 8 open, expiry after
7 days, a suggestion is marked surfaced once shown. A run over unchanged input
returns the same objects — nothing is announced twice. Engagement filter: a
page glanced at once for under 15 s is not evidence.

## 4. Surfaces

All read the same stored suggestions (`tabdump:context:v1`), so a decision in
one place is a decision everywhere.

- **Home**: the first-run invitation; **Smart Resume** ("Continue Economics
  IA?" — last worked, counts, latest item, new since last resume, only gaps
  the data shows, a tick to reopen the saved session's tabs or the pages last
  used for it); **Suggested** (two at a time, strongest first, "All N").
- **Suggestion card**: headline, explanation from shared words only, project,
  up to three pages with real favicons/provider marks and capture status, one
  button that says what it does, Review, and Not now / Not <project> / Not
  relevant.
- **Review dialog**: untick pages, choose another project or name a new one;
  the button states the exact result; link-only conversations are called out.
- **Project view**: one line when pages may belong here, opening the same
  review.
- No browser notifications and no popup surface were added: Home is the one
  place suggestions appear, which keeps a single notification system.

**Accepting** (`app-shell.tsx` `handleAcceptSuggestion`): proposal →
`applySmartToSubjects` (a project is found by name before one is made) → one
commit → only then the decision is written → conversation text through
`capture_context_conversation` (the Save to Hubble job, Hubble on the web
only) → toast with Undo (`undoSmartToSubjects` + `undoAcceptance`).

**Resuming**: opens the project, reopens tabs only if ticked and only those
not already open (`withoutOpen`, by source identity), through the Sessions
launcher (marks the session restored; with no saved session, the reopened
pages become one, tied to the project), records a checkpoint and a
`project_resumed` history event. Not offered after "Not now" (12 h), within
2 h of a resume, for projects untouched for 14 days, or when the person never
left and nothing new is waiting.

## 5. Storage, sync, migration

- **Extension** (`chrome.storage.local`): `hubble_context_settings`,
  `hubble_context_activity` (`{version, epoch, seq, records, removed}`).
  Re-read on load; a damaged store is dropped, never trusted.
- **Page** (localStorage, account-scoped, in `SCOPED_STORAGE_KEYS`):
  `tabdump:context:v1` — records (≤ 300), cursor, associations, rejections
  (≤ 2000 each), suggestions (≤ 100), checkpoints, resume memory,
  preference. Read-modify-write on every change; other tabs follow through
  the `storage` event. Schema v1 is new: no previous data exists to migrate;
  unreadable data is kept aside once; data from a newer version is read-only.
- **Not synced** between devices (the sync engine is workspace-scoped).
  Desktop has no extension channel, so none of this appears there; Settings →
  Context says "Chrome only".
- **Deleting**: Remove (one page) and Clear activity remove records,
  suggestions' mentions, associations and rejections here and in the
  extension. Projects, sources, notes and sessions are never touched
  (`pipeline.test.ts`).

## 6. Privacy

Kept: addresses, titles, icons, times — in this browser. Read text never
leaves the extension: only ≤ 40 topic words and a hash are stored, and the
text is saved only into a project the person chose. Nothing is sent to an AI
service; inference runs in the page. No logs contain titles, addresses or
text (the collector logs counts and reasons only). Pages added to a project
are then read by Hubble's reader exactly as any manually added page is
(the address goes to Hubble's server, which fetches the public page).

## 7. Testing

```bash
npx vitest run src/lib/intelligence extension/src/context-activity.test.js extension/src/browser-commands.test.js src/components/intelligence
```

- `engine.test.ts` — cases A (one Economics IA), B (two assignments at once),
  C (personal chat), D (existing project), E (insufficient evidence), F
  (rejection, snooze, not relevant), G (content unavailable), H (multi-day),
  I (duplicate events), confirmed-decision precedence, lifecycle.
- `pipeline.test.ts` — the real extension collector → pull → stored state →
  inference → accept through `applySmartToSubjects` → undo; new project from
  a cluster (idempotent); epoch reset; removal; deletion never touching
  projects; storage migration and corruption.
- `context-activity.test.js` — consent gating, sensitive/incognito/local
  refusal, sites mode, pause, dedupe and write economy, debounce, visits and
  dwell, conversation reading (permission, terms-not-text, partial, layout,
  moved tab, revocation), exclusions, forget, clear, retention, restart.
- `evaluation.test.ts` — the labelled hard-case set and its precision /
  false-positive / recall numbers (`EVAL_OUT=<file>` writes them).
- `intelligence-ui.test.tsx` — first-run choice (manual, chosen sites, app
  permission refused, later), Home cards (accept, not now, not relevant),
  review (remove item, new project, link-only note), Resume, Settings states
  (not connected, needs update, permission revoked, remove, exclude).

**Manual checks still needed** (no automated equivalent here): the real
permission window and Chrome's prompt; background reading on live signed-in
ChatGPT/Claude/Gemini/Perplexity pages; a real incognito window with "Allow
in incognito"; the extension's behaviour across a real browser restart.

## 8. Verification, 2026-10-29

Three kinds of evidence, never mixed up:

| Kind | What it proves | What it doesn't |
| --- | --- | --- |
| **Real Chrome** | System Chrome, the real unpacked extension loaded over CDP, the production build on :3000, real web pages over the network | Signed-in AI pages; Chrome's native permission prompt |
| **Real Chrome, fixture markup** | The real extension's background read, the real reader running in the page, at the real chatgpt.com address — with the document answered from fixture HTML (request interception) | The live app's current markup |
| **Unit / jsdom** | Logic with injected Chrome APIs and fixtures | That Chrome delivers the events |

Rig: scratchpad `qa/real-ext.mjs` (phases `core`, `reading`, `restart`), a
copy of `extension/` (for `reading`, with chatgpt.com added to
`host_permissions` to stand in for the Allow click). Profiles on a short
path. Results of the last run are in §8.1.

### 8.1 Results

Verified in real Chrome:
manual by default; the onboarding choice reaching the extension; tabs already
open noticed on opt-in; research pages recorded with real titles; sensitive
pages never recorded; Google Docs behaviour above; dwell; redirects; duplicate
events; detection while Hubble is closed; recovery after the service worker
was stopped (`ServiceWorker.stopAllWorkers`); a browser restart (same
extension id, settings and records kept); an off-the-record context recording
nothing; the pull, suggestion, accept (persisted across reload, not
re-suggested), no duplicate project; exclusion enforced by the collector and
removing what was kept; pause and manual recording nothing; the permission
window opening with the context wording and a refusal shown in Settings;
clear (projects untouched); background reading keeping topic words only; the
conversation's text saved on accept; Undo; Resume reopening only tabs not
already open, marking the session and recording history.

### 8.2 Defects found by real Chrome, and fixed

1. Time in front was never measured for a page loaded in the tab already in
   front (the ordinary way of browsing) — so the engagement filter blocked
   every suggestion from real browsing.
2. A redirect inside a tab made two records.
3. Tabs open when the person opted in were not noticed.
4. Error pages (Chrome interstitials, Wikimedia's rate-limit page, "Page not
   found") kept their misleading titles.
5. One run showed a page with the 30-minute per-visit cap of dwell that two
   focused probes could not reproduce; dwell is now also bounded by the
   time since the page was first seen.

Found by the pre-pilot privacy audit (2026-10-29), and fixed:

- P1 (high, shared devices): activity and consent belonged to the browser
  profile, so a second Hubble account on the same Chrome pulled the first
  one's activity and inherited its consent — now bound to the account that
  opted in (above).
- P2 (medium): Manual mode stopped collection but old pages kept producing
  suggestions.
- P3 (low): a Hubble tab in a private window could read and change context.
- P4 (low): excluding a site left its addresses in Hubble's stored answers
  (rejections, associations).
- Explanations: "Their titles all mention" when the words were shared by most
  pages, and "while working on the project" for pages a week apart.

Found by the UI checks and the code audit, and fixed:

6. The project strip never showed in the ordinary project view: a project
   holding only sources renders through `ProjectPage`, not `WorkspaceView`.
   It is now in both, with copy short enough for 390px.
7. The accept toast said a conversation's text was "saved" when the
   extension had only queued it; it now says it is still being saved.
8. Inference (§8.3): an incidental title word could travel through the
   provisional pass; one shared word could reach "strong"; words only one
   page uses outweighed shared ones; groups split by average linkage were
   lost; personal browsing could become a "project".

### 8.3 Inference evaluation (fixtures, not real-world accuracy)

`evaluation.test.ts`: 14 hard cases, 17 pages labelled with a destination
and 16 labelled "never suggest". Before this pass: precision 0.92 (11
correct, 1 false positive — an unread "Quick question about this" chat
pulled into a project by one borrowed title word), recall 0.65. After: 16
correct, 0 false positives, 1 missed — **precision 1.0, recall 0.94**, 9
suggestions across 14 cases. The miss is real: "Berkeley soda levy: what
happened next" shares only "soda levy" with a conversation and nothing with
the project; Hubble says nothing rather than guess. Two personal cases
(London pages, headphone shopping with a chat) produced "projects" before the
study-material rule and none after. Thresholds were not lowered.

### 8.4 Still manual

Chrome's own permission prompt (Allow / Deny) and revoking access in
chrome://extensions → Site access (`permissions.onRemoved` is unit-tested;
in the rig the access is a required permission and can't be revoked);
background reading on live, signed-in ChatGPT, Claude, Gemini and Perplexity
pages (Claude shows a bot check to automated browsers and was not bypassed);
a real Incognito window with "Allow in Incognito" turned on (the rig's
off-the-record context has the extension disabled, which is Chrome's
default); Google Docs signed in; a Chrome update or crash mid-write. **No
user study has been run**: every number above is from fixtures and scripted
browsing.

## 9. Known limits

- Matching reads titles (and, opted in, chat topic words). Pages on one topic
  in different words, or a thin project (one source), may not match; a group
  then becomes a "new project" suggestion with the project offered as the
  other choice in Review.
- Google Docs content is not readable (no authorized connector); a Doc is
  matched by its title.
- A new project is proposed only for a group holding study material (a
  document, PDF, or reference/academic source). Work done only on other
  sites or only in chats is not proposed as a new project — it can still be
  matched to a project the person made. The reference list is a fixed list
  (`SITE_CATEGORY_HOSTS`), so a niche study site outside it counts only via
  the other pages in its group.
- The same topic in different words is matched only when a read
  conversation uses both (fixture recall 0.94; see §8.3).
- Dwell is approximate (focus changes Chrome reports; capped per visit).
- Thresholds are fixture-calibrated, not proven.
- Detection, suggestions and resume are web-only; sessions and context state
  do not sync between devices.
- Releasing: the website and the extension ship separately. The extension
  is bumped to **0.10.0**; an older extension answers the context commands
  as unknown, and Settings → Context asks for an update.
