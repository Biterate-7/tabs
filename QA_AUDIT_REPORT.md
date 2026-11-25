# Hubble — End-to-end QA audit

Date: 2026-11-25 · Branch: `claude/hubble-e2e-qa-audit-785755` (from `main` at 9f0436ea, PR #67) · Nothing committed or pushed.

## 1. Executive summary

The reported error — *"Hubble couldn't find the messages on this page"* — and the wider "Save loses part of my chat" problem were reproduced **live, on the person's own signed-in ChatGPT and Claude** (through Claude in Chrome; only counts, roles and lengths were read back, never text). They had several separate root causes, all in the page reader (`extension/src/ai-pages.js`), all now fixed and covered by regression tests:

| Before (live, today) | After (live, today) |
|---|---|
| A 3-exchange ChatGPT chat saved 4 of 6 messages: two replies silently dropped | 6 of 6 |
| A long ChatGPT chat (52 questions) saved the ~3 exchanges on screen | 50 of 52 questions with their replies, in order, each once; the save says it is only part of the chat |
| A Claude chat whose first question was a file saved starting with a reply | Every turn, the file kept as `[Attached file: name]` |
| A Claude chat that keeps only rows 3–7 mounted saved 5 of 8 turns | 8 of 8 |
| An empty Claude chat said the app "changed its layout" | "There are no messages in this conversation yet" |

The rest of the product was exercised end to end through the **real extension and the real desktop app** (a debug build of today's `main` app code) with an automated rig: capture → app storage (IndexedDB + crash-safe disk copy) → search → import of a 53-conversation export → intelligence ("What did I decide about Orbitly?") → graph → force-close and restart. Final runs: capture phase **44/44** checks passed, app phase **24/25** — the one failure is a rig check that read text outside the answer (§14).

What is **not** proven: Gemini and Perplexity on their live sites (fixture-tested only today), sign-in/out, the release desktop installer, Use-in-AI delivery into a live AI chat, and full knowledge-graph interaction. They are listed honestly below.

**Totals (from the table in §4):** features 35 (grouped) · tested 27 · PASS 21 · PARTIAL 6 · FAIL 0 after fixes · BLOCKED 2 · UNTESTED 6 (incl. the web production build). Bugs found 18 · fixed 15 · remaining 3 (plus rig-only defects). Tests added 11 (+1 timeout fix). Final suite: §16.

## 2. Architecture discovered

```
 Chrome (Hubble for Chrome, MV3, v0.13.0)                  Hubble Desktop (Tauri 2 + static Next export)
 ┌──────────────────────────────────────────┐   HTTP       ┌──────────────────────────────────────────────┐
 │ popup (ai-panel.js) ─► background.js     │ 127.0.0.1    │ Rust bridge (paired, device token)           │
 │   Save: executeScript(readConversation-  │ :41517-19 ─► │ webview: AppShell (React)                    │
 │   FromPage) on the active tab only       │              │  ├ save.ts → Workspace.tabs[].resource       │
 │   capture-queue.js (durable, retries)    │              │  │   (localStorage + Rust durable-store)      │
 │   context-activity.js (opt-in, titles/   │              │  ├ content store: IndexedDB hubble-resources  │
 │   topic words only)                      │              │  ├ intelligence: IndexedDB hubble-intelligence│
 └──────────────────────────────────────────┘              │  │   extract → corpus → retrieve (on device)  │
                                                           │  ├ search (lib/memory/search.ts)              │
 Website (Next, Vercel): launch/download/auth/sync APIs    │  └ graph (WebGL galaxy, 3 canvas layers)      │
                                                           └──────────────────────────────────────────────┘
```

- **Capture:** the extension reads the conversation only on Save, only in the tab in front; the AI app is decided by the address; the turns go to the desktop bridge (paired) or wait in a durable queue until Hubble Desktop is open.
- **Storage:** projects/items in localStorage, mirrored by Rust to `%APPDATA%\<id>\durable-store` (crash safety); conversation text in IndexedDB; nothing conversational goes to a server (sync carries links and titles only).
- **Intelligence:** extraction of decisions/tasks/questions/entities per conversation, cross-conversation relations and threads, retrieval for the Conversations "Ask" box, optional on-device embeddings ("Compare by meaning", off by default). All local.
- **Reuse:** `lib/memory/bundle.ts` writes chosen items up as quoted, attributed context; the extension inserts it into the AI's message box (never sends unless asked).

## 3. Feature inventory

Grouped into the 35 rows of §4. Capture: page Save ×4 providers, code/tables/math formatting, attachments, long/windowed chats, streaming refusal, duplicate/resave, offline queue, export import, paste, notes, files. Intelligence: extraction, relations/threads, Ask (decisions/open questions), "Where you left off", backfill, diagnostics, meaning search. Search: app Search, project search, popup search, ⌘K. Projects: create/rename/delete/move/auto-suggest. Graph: render, select/navigate, filters, appearance. Reuse: Use in AI dialog, popup insert/copy. Extension: pairing, permissions, popup, worker restart, context detection, quick add, sessions, YouTube transcripts. Desktop: startup, persistence, crash safety, deep links, file uploads/PDF reader. Account: Google sign-in, logout, sync. UI: Home, AI, Library, Sessions, Conversations, Settings, onboarding.

## 4. Feature-by-feature results

| Feature | Status | Tests performed | Issues |
|---|---|---|---|
| ChatGPT Save (signed in, short chats) | PASS | Live reader on 9 of the person's chats; fixture Save through real popup→app | Replies were silently dropped (fixed, B1) |
| ChatGPT Save (long, windowed chats) | PARTIAL | Live: 52-question chat → 50 kept in order, flagged partial; rig: 30-exchange windowed fixture → 60/60 turns in order | B3–B6 fixed; 2 of 52 still missed live, honestly flagged |
| ChatGPT streaming refusal / Try again | PASS | Rig: refused while Stop shows, saved after | — |
| Claude Save (signed in) | PASS | Live reader on 7 chats incl. windowed and attachment-only; rig fixtures | B7–B11 fixed |
| Gemini Save | PARTIAL | Fixture tests (suite); live signed-out on 2026-11-24 (PR #67) | Not tested live today |
| Perplexity Save (/session/) | PARTIAL | Rig fixture through real popup→app (2 turns, code fenced) | Not tested live today; windowed threads cannot be collected (answers carry no row key) — flagged partial instead |
| Code blocks, tables, inline chips | PASS | Rig: ```python fences, table rows, chip inside reply | — |
| Attachments | PARTIAL | Claude file cards kept by name (live + rig) | ChatGPT/Gemini images not captured (text only) |
| Duplicate save / resave | PASS | Rig: "Already saved — nothing new since", 1 copy | — |
| Unknown layout diagnostics | PASS | Rig: honest reason + "Details:" counts line + Try again | — |
| Empty conversation | PASS | Live Claude + rig | Was reported as a layout error (B9, fixed) |
| Offline queue (desktop closed) | PASS | Rig: "Not saved yet…", delivered 2 s after app reopened, persisted | Earlier failure was the rig force-stopping the worker |
| Crash safety / restart | PASS | Rig: force-kill + restart → 58→58 and 111→111 items, none duplicated | — |
| Export import (53 conversations) | PASS | Rig: 53 added in 123–179 ms; 200-turn code chat intact (100 ```ts fences) | — |
| App Search | PASS | Rig: cross-provider/project concept (15 hits, 266–294 ms), unrelated topic isolated, no-result, special chars, long query, result opens its item | — |
| Popup search ("Use your knowledge here") | PASS | Rig: "comets" → only the Perplexity chat | — |
| Intelligence processing + diagnostics | PASS | Rig: `hubbleIntelligence.status()` complete, 112/112 analysed, no errors | — |
| Ask: decisions across conversations | PASS | Rig: "What did I decide about Orbitly?" → Postgres, per-pass pricing, Europe, each with its source message | — |
| Ask: open questions | PASS | Rig: found the unresolved "launch in Europe first?" | — |
| Ask: unrelated topic | PASS | Rig: "Nothing in your 112 analysed conversations answers this" | Rig check misread (see §14) |
| Cross-provider relation (Claude ↔ ChatGPT) | PARTIAL | Search finds both providers; Ask answers came from ChatGPT conversations | Thread/related-link UI not asserted |
| Where you left off | PARTIAL | Rendered in Conversations view; "reconstruct" event logged | Content not asserted |
| Meaning search (embeddings) | UNTESTED | Off by default (`model: not-requested`) | — |
| Knowledge Graph render | PASS | Rig: 3 canvas layers with 112 items, no console errors | — |
| Graph selection/navigation/filters | UNTESTED | — | Unit tests only |
| Projects create | PASS | Rig (×4) | — |
| Projects rename/delete/move items | UNTESTED (E2E) | Unit tests in suite | — |
| Main views (Home, Graph, AI, Conversations, Library, Sessions) | PASS | Rig: each opens from the sidebar in ~0.5 s, no console errors | — |
| Extension pairing with desktop | PASS | Rig: real popup Connect + app approval | — |
| Extension worker restart recovery | PASS | Rig: queue survives worker idle; delivery resumes | — |
| Use in AI (dialog → insert into AI chat) | UNTESTED (E2E) | Suite (fixture) passes | — |
| Google sign-in / logout / sessions | BLOCKED | Desktop runs signed out; web auth needs Google | — |
| Release desktop build / installer | BLOCKED | Debug build used; App Control blocks new release artifacts (known) | — |
| Web production build | UNTESTED | Not run this session (typecheck, lint and suite cover the one src change) | — |
| Settings, onboarding, Favorites/Recent | UNTESTED (E2E) | Unit tests | — |

## 5. Session saving and provider compatibility

Root causes of "couldn't find the messages" / lost messages, found live:

- **ChatGPT moved its reply root.** `[data-markdown-copy="contents"]` (the reply root in 2026-10) now marks a small inline chip inside replies. The reader took the first matching body selector, read the chip, got nothing and **dropped the whole reply without saying so**. Bodies must now hold at least half the message's text; the new root `[data-markdown-text-style]` is tried first.
- **Long chats are windowed** (ChatGPT signed in, Claude): only turns near the screen exist in the page. Save now scrolls the thread to its top (older messages load), then down a screen at a time, collecting each message once by a strategy-independent key (Claude row index → Perplexity entry → ChatGPT turn UUID → message id, counted per role), and puts the scroll back. Only Save does this; the passive read never moves the page.
- **ChatGPT's message keys are positional** (`fallback-turn-18:0:user`) and shift when older turns load → duplicates; keyed on `data-turn-key` instead.
- **ChatGPT snaps the thread to the latest reply** when it moves with no sign of a person scrolling (10 snaps in 60 steps); each move is now announced with a wheel event (0 snaps live).
- **Replies paint after their turn mounts** → a question saved without its reply; the reader now waits for on-screen messages and says `partial` if one never draws.
- **Claude** dropped `data-testid="user-message"` on some questions, keeps file-only questions inside a hidden-from-search block, and shows an explicit empty-conversation line.
- Save's popup now says "Reading the conversation… (Hubble scrolls through a long chat to keep every message)".

Note: the error text quoted in the brief is the **pre-PR #67 wording**, so the person's installed extension likely predates 0.13.0 — they should update Hubble for Chrome once this lands.

## 6. Intelligence system results

On 112 conversations (53 imported + 53 again in a second project + 6 saved via the extension): processing completed with no logged errors; Ask returned the three Orbitly decisions with confidence labels and source messages, the open question, and an honest "nothing answers this" for an unrelated topic. Weaknesses not exercised: meaning search (opt-in), worker crash/timeout recovery (covered only by unit tests), real personal history (all data synthetic).

## 7. Context reconstruction results

"Where you left off" renders and the `reconstruct` event fires; Home's "Continue"/"Pick up" cards point at the latest project. Not asserted: whether its contents are the right ones on a realistic multi-week history. Context detection from browsing (opt-in) was not exercised end to end.

## 8. Knowledge Graph results

Renders 3 canvas layers over 112 items with no console errors after restart. Node selection, navigation, filters and large-graph performance were not driven (UNTESTED).

## 9. Search and retrieval results

App Search across projects/providers: 15 results for "Orbitly" (both providers, no cooking/travel/running chats), 8 for "sourdough proof" (only sourdough), "No results." for nonsense, special characters safe, result opens its item with its text. Typing-to-results 266–294 ms on 112 conversations. Terms are de-duplicated and capped at 8, so long queries are bounded.

## 10. Extension results

Pairing, popup Save, durable queue, delivery after the app reopens, worker idle/restart, diagnostics line, duplicate refusal, streaming refusal: PASS (rig). All 43 extension test files (≥ 807 tests) pass. Permissions unchanged (no new host permissions; scrolling happens inside the existing `activeTab` read).

## 11. Desktop / web application results

Desktop debug build of today's app code: starts with data in ~380 ms of page time, every main view opens, crash-safe copy verified on disk after each save, force-close/restart loses and duplicates nothing. Release build and installer not rebuilt (BLOCKED). Web build: §16.

## 12. Authentication and privacy audit

- The reader runs only on Save (or the opt-in passive read, which never scrolls); failure diagnostics stay counts/booleans only; no new network requests or permissions; attachment *names* (the person's own) are kept as text.
- The `http://localhost:3000` content script exists only in the unpacked dev build; the release ZIP rewrites it to the production origin (`scripts/build-extension-zip.mjs`).
- Page→extension messages check `event.origin`/`event.source`; background checks the Hubble page origin for page-only actions.
- Live testing read only counts, roles and lengths from the person's chats; no text was logged, saved or sent.
- **Developer hazard (not shipped):** launching the QA debug build rewrites `HKCU\Software\Classes\hubble` to itself. It happened during this audit; the person's handler (`…\AppData\Local\Hubble\Hubble.exe`) was restored after every run and verified at the end.

## 13. Performance results

| Measure | Result |
|---|---|
| Reader, one pass on a live ChatGPT page | 3–24 ms |
| Save of a live 52-question ChatGPT chat (105k px) | ~26 s scroll-through |
| Save of a 30-exchange windowed fixture through popup→app | 8 s |
| Live Claude chats (2–10 turns) | 1.7–2.6 s |
| Import of 53 conversations | 123–179 ms |
| App Search, 112 conversations | 266–294 ms |
| Intelligence over 112 conversations | complete, no errors (backfill planning 21–54 ms) |
| `outermost()` element filter | was O(n²); now linear |
| Full test suite (baseline, loaded machine) | 2,261 s |

## 14. Bugs discovered

| # | Bug | Severity | Status |
|---|---|---|---|
| B1 | ChatGPT replies silently dropped (inline chip taken as body) | High | Fixed, live-verified |
| B2 | Reply not yet painted → question saved without it, silently | High | Fixed (wait, then `partial`) |
| B3 | Long ChatGPT/Claude chats saved as only the turns on screen | High | Fixed; ChatGPT live 50/52 + flagged |
| B4 | Positional ChatGPT keys → duplicated turns when collecting | High | Fixed |
| B5 | ChatGPT snaps to bottom during programmatic scroll → skipped stretches | High | Fixed (wheel intent), live 0 snaps |
| B6 | Scroll anchoring left the walk at a stale position → skipped strips | Medium | Fixed |
| B7 | Claude question without test id dropped (first strategy "won") | High | Fixed, live 10/10 |
| B8 | Claude file-only question dropped | Medium | Fixed (`[Attached file: name]`), live |
| B9 | Empty Claude chat reported as "layout changed" | Medium | Fixed, live |
| B10 | Claude windowed chat: strategy-dependent keys → duplicates | High | Fixed, live 8/8 |
| B11 | Two replies merged when the question between them was missing | High | Fixed (gap detection → `partial`) |
| B12 | Heading fallback read a question as the (undrawn) reply | Medium | Fixed |
| B13 | CSS-hidden "Loading older messages" still counted as pending | Low | Fixed |
| B14 | Scroll not put back at the end after a long read | Low | Fixed (rig: gap 0 px) |
| B15 | 150-turn reader test fails on this machine (jsdom cost; pre-existing) | Low | Explicit 60 s timeout, documented |
| B16 | 2 of 52 questions still missed on the longest live ChatGPT chat | Medium | **Remaining** (flagged partial, never silent) |
| B17 | Items whose text is missing on this device say "Saved as a link only… can't read from its address" even when they were saved with text | Low | **Remaining** |
| B18 | QA debug build hijacks `hubble://` (developer tooling) | Low | **Remaining** (rig restores it) |
| R1 | Rig: one Ask check scanned text outside the answer; one persistence check compared URLs across projects | — | Rig defects, not product |

## 15. Bugs fixed — files

- `extension/src/ai-pages.js` — B1–B14 (body coverage, waits, scroll-through collection, keys, wheel intent, anchoring, strategy choice, attachments, empty Claude chat, gap detection, linear `outermost`).
- `extension/background/background.js` — Save passes a 60 s collection budget (`CAPTURE_COLLECT_MS`).
- `extension/popup/ai-panel.js` — tells the person a long chat is scrolled through (`READING`).
- `src/lib/providers/registry.ts` — Settings → AI apps now records today's live checks for ChatGPT and Claude, including what is still incomplete.

## 16. Tests added and final verification

Added to `extension/src/ai-pages.test.js` (11 tests, fixtures of the structures seen live 2026-11-25): inline-chip body; undrawn reply waited for; undrawn reply → `partial`; windowed ChatGPT chat collected whole, in order, scroll restored; snap-to-end kept in place, with wheel intent; passive read never scrolls; time-out → `partial`; Claude question without test id; Claude file-only question; Claude empty chat; windowed Claude chat with strategy switching. Plus the 150-turn test's explicit timeout. Updated: three popup tests (`READING`), one background test (collect budget).

Final verification (this worktree):
- ESLint on changed files: clean. `tsc --noEmit` (after `next typegen`): clean.
- Extension tests: 43 files, all passing.
- Full suite (alone on the machine): **383/383 files, 5,076/5,076 tests passed**, 772 s (baseline before changes: 5,064 passed, 1 failed — the jsdom-timeout test, B15). Extension tests re-run after the final comment cleanup: 43 files / 807 tests passed.
- Extension package: `scripts/build-extension-zip.mjs` builds `public/hubble-extension.zip` (550 KB, git-ignored) with the new reader.
- E2E rig (real extension → HubbleQA desktop app): capture **44/44** (one earlier attempt crashed before any save with "execution context destroyed" and passed on retry), app **24/25** (R1).
- Web production build (`next build`) and desktop release build: **not run** — the only app-side change is text in `registry.ts`, covered by typecheck, lint and the suite; both builds remain to be run before release.
- After every QA desktop run the person's `hubble://` handler was restored to `C:UsersiswaAppDataLocalHubbleHubble.exe` and checked.

## 17. Remaining failures and limitations

B16–B18 above; Gemini and Perplexity not tested live today; ChatGPT/Gemini images not captured; Perplexity windowed threads are flagged partial rather than collected; sign-in, release installer, Use-in-AI delivery, graph interaction, project rename/delete/move E2E untested; all intelligence data synthetic.

## 18. Production readiness

The capture fixes are ready to ship and materially change what users get (whole chats instead of fragments, never a silent loss). Before calling the product production-ready: release the extension so users leave the pre-0.13 reader, run the Gemini/Perplexity live checks, drive Use-in-AI into a live chat, and fix B16 (likely by waiting for the last screens to settle before finishing the walk).
