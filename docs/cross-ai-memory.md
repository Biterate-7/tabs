# Cross-AI memory

Hubble is one connected workspace for everything a person learns and creates
with AI. They talk to ChatGPT, Claude, Gemini and Perplexity; each app
remembers only its own conversations. Hubble keeps what matters from all of
them — with the pages, PDFs and videos they read and their own notes — in
**projects**, and lets them bring any of it into the next conversation, in
whichever app.

```
Capture ──► Connect ──► Find ──► Reuse
  save a       one project    search every     "Use in AI chat":
  conversation holds chats,   project, any     choose items, review the
  from the     sources and    AI app, by       context, copy it or insert
  page, an     notes; the     turn, page or    it into the message box —
  export, a    graph links    moment           never sent for you
  paste        them
```

This replaced the agent Command Centre (see *What was removed* below).
Sources — how a link becomes a readable page, PDF or video — are in
[project-context.md](./project-context.md).

## 1. Model

Nothing here is a second store. A project is a `Workspace`; its knowledge is
what it already held plus one new list.

| Item | Record | Body |
|---|---|---|
| AI conversation with its address | `Tab` with `resource.kind = "conversation"`; `resource.meta`: `provider`, `conversationId`, `turnCount`, `contentHash`, `capture` (`page` · `export` · `paste`), the conversation's own created/updated times | `ResourceContent.turns` (`{ role: "user" \| "assistant", text, at? }[]`) in the content store |
| AI conversation without an address (a paste) | `ProjectNote` of kind `conversation` (`lib/notes/notes.ts`) | turns, or the whole text when it could not be split |
| Note, excerpt | `ProjectNote` of kind `note` / `excerpt` (title, tags, AI app, source address) | text in the content store |
| Web page, PDF, video, document | `Tab.resource` (unchanged) | text, pages, transcript |

- `Workspace.notes` is **device-local**, like the brief and every
  `resource`: sync carries links and titles, never saved text
  (`lib/sync/apply.ts` keeps the local field). Notes are re-read strictly on
  load (`readProjectNotes`), and a bad record is dropped, not trusted.
- Bodies live in IndexedDB (`hubble-resources`), keyed
  `<account>|<project>|<item id>`, bounded (`CONTENT_LIMITS`: 4,000 turns,
  100,000 characters a turn; 2,000,000 characters per conversation).
- `lib/memory/items.ts` turns all of it into one `KnowledgeItem` list —
  type, title, AI app, address, when added, whether Hubble holds its text —
  which the project page, Home, Search and context bundles all read.

## 2. Capture

Every door produces one `ConversationInput` and one function saves it
(`lib/conversations/save.ts`, `planConversationSave` → write the body →
`applyConversationSave`, so a project never claims text it could not keep).

| Door | Code | Notes |
|---|---|---|
| **Save to Hubble** in Hubble for Chrome, on the conversation page | `extension/src/ai-pages.js` `readConversationFromPage` → `lib/conversations/capture.ts` | Only when the person clicks, only the tab in front (`activeTab`). The AI app is decided by the **address**, never the payload; turns are a closed shape; text is cleaned and bounded. |
| Import an export file | `lib/conversations/import-file.ts` → `exports.ts` | ChatGPT and Claude `conversations.json`. ChatGPT's visible thread is the path from `current_node` (edited-away branches, tool calls, hidden and system messages left out). Zip, wrong type, > 100 MB, malformed and unknown JSON are refused with a reason. `.md`/`.txt` are read as a paste. |
| Paste | `lib/conversations/parse-text.ts` | Split into turns only when both sides are labelled ("You said:" / "ChatGPT said:", "User:" / "Assistant:", "## User", "**Q:**" / "**A:**"). Otherwise kept whole — never guessed. |
| Note / excerpt | `lib/notes/compose.ts` | Titled from the first line; tags; source address (http(s) only). |

**Saving again** (`contentHash` over the turns): the same text is
*unchanged* (nothing written, the person is told); more or different text is
*updated* in place — same id, the person's title, notes, collections and
graph links kept; a plain saved tab with the same address becomes the
conversation. **Projects are separate**: the same conversation in two projects
is two items.

Characters that hide or reorder text (zero-width, bidi overrides, controls)
are removed on every door (`lib/conversations/clean.ts`). Saved text is never
executed, followed or treated as an instruction.

## 3. Find

`lib/memory/search.ts` runs the project search engine (`lib/resources/search.ts`)
across projects and returns one hit per item, with where it matched: a turn
(and whether the person or the AI said it), a PDF page, a video moment, a
note's text or tags. Filters: project, AI app, kind. Surfaces: the project
page's search box, the **Search** page (every project), ⌘K's *Search
everything for …*, and Hubble for Chrome's *Use Hubble in this chat*. A
result opens the item at the turn or moment that matched.

## 4. Reuse

`lib/memory/bundle.ts` `buildMemoryBundle` writes the chosen items up as
context for any AI app. Pure: no clock, no storage.

- **Only what was chosen**, from one project.
- **Sections kept apart**: *My notes* (the person's words), *Earlier AI
  conversations* (marked AI-generated, may be wrong), *Sources* (evidence).
- **Provenance on every quote**: title, AI app or site, the date it was
  saved, the original address with credentials and secret-looking query
  values redacted.
- **Never merged**: two conversations that disagree are quoted separately;
  with more than one AI app the bundle says they may disagree. Hubble does
  not decide which is right.
- **Quoted, not obeyed**: every line of saved text is a `>` quotation, and
  the bundle says it is reference material, not instructions.
- **Bounded**: a budget (Short 5k · Standard 12k · Long 30k characters) shared
  across items, passages matching the person's request first, a question kept
  with its answer. What does not fit is still named under *Also relevant*.

The **Use in AI chat** dialog (`components/memory/reuse-dialog.tsx`) shows the
whole text, editable, before anything leaves Hubble, and copies it. In Hubble
for Chrome, **Use Hubble in this chat** builds the same bundle (from the open
Hubble page) and either **copies** it or **inserts** it into the AI app's
message box (`insertIntoComposer`). Insert never presses send; it confirms the
text is in the box and otherwise copies and says so. The two are recorded
differently (`memory_copied` / `memory_inserted`); nothing is ever submitted.

## 5. Provider capabilities

The registry (`lib/providers/registry.ts`) is the only place these claims
live; Settings → **AI apps** renders it. "Fixture" means Hubble's tests drove
the path against saved, representative page or file fixtures — **not** the
live app, whose markup changes without notice. "Protocol" means driven over
the real MCP wire format with the official SDK client, not the vendor's app.

| | ChatGPT | Claude | Gemini | Perplexity |
|---|---|---|---|---|
| Save from the page (Hubble for Chrome) | yes · fixture | yes · fixture | yes · fixture | yes · fixture |
| Import the app's export | `conversations.json` · fixture | `conversations.json` · fixture | **no** (Takeout is activity, not conversations) | **no** (no account export; a thread's Markdown export imports as text) |
| Paste | yes · fixture | yes · fixture | yes · fixture | yes · fixture |
| Insert into the message box (never sends) | yes · fixture | yes · fixture | yes · fixture | yes · fixture |
| The app reads Hubble (MCP connector) | yes · protocol | yes · protocol | where Google offers custom apps · protocol | **no** |
| Automatic sync | **no** | **no** | **no** | **no** |

### Live check, 2026-10-14

Run against the live apps in a fresh Chrome, **signed out**, with the real
extension popup: one question per app, then Save (twice), Save into a second
project, search in Hubble, build context, Insert.

| | Result | Notes |
|---|---|---|
| ChatGPT | pass | Signed-out threads live at `/uc/<id>`; messages are `li[data-message-role]`; the composer is `textarea[name=prompt]`. All three were new and are now handled. The page title is the site's, so the conversation is titled from its first question. |
| Gemini | pass | A screen-reader label repeated the question as "You said …"; it is now left out. |
| Perplexity | pass | The question bubble is `[data-message-bubble=right]` (it was being dropped). Its editor shows inserted text a moment later; Insert now waits for it instead of reporting a failure and pasting a second copy. The signed-out allowance ran out during testing; Hubble saved the page as it was. |
| Claude | not tested | Behind a bot check for an automated browser; not bypassed. |

Signed-in pages were not tested and can differ. Each fix has a fixture in
`extension/src/ai-pages.test.js` ("live markup, 2026-10-14").

### ChatGPT, 2026-10-15: the signed-in layout

They did differ. Signed-in ChatGPT (and, by then, signed-out chats at
`/c/<id>`) no longer puts a role attribute on a message: there is no
`data-message-role` or `data-message-author-role` anywhere on the page, so
every Save ended in "couldn't find the messages". Each message is now an
element keyed `data-content-search-unit-key="<turn>:<n>:user|assistant"`; a
reply's text is in `[data-markdown-copy="contents"]`, and "You said:" /
"ChatGPT said:" are visible `h4` labels beside it.

The ChatGPT reader is now a list of layouts tried in order (message keys,
then role attributes); only the first that finds messages is read, so a
message is never read twice. Text is rebuilt from the elements, not
`innerText`: code blocks come back fenced with their language, formulas as
their TeX (`$…$`, `$$…$$`), list items keep a marker, table cells stay on
their row, and what ChatGPT's own Copy
leaves out (`data-markdown-copy="exclude"`: code-block headers, timestamps)
stays out. A page still rendering is read again for up to 3 s. The reader
tells *no messages on screen yet* (`empty-conversation`) apart from *a layout
it cannot read* (`no-messages`, which offers the paste fallback). When
ChatGPT shows "Loading older messages…" above the thread, what is on screen
is saved and the popup says older messages were left out. The background
re-checks the page's answer (`checkPageRead`) before anything reaches Hubble.

Checked live: the reader on a signed-in conversation (10 messages, tables,
lists, the older-messages notice) and on a signed-out `/c/` chat with a code
block; and the real popup end to end on a signed-out `/uc/` chat (which still
uses role attributes) — Save into Physics, Save again ("Already saved"), one
item kept, turns and roles as on the page. Fixtures: "ChatGPT, signed in
(live markup, 2026-10-15)".

### Claude, Gemini and Perplexity, 2026-10-16: signed in

Checked in a signed-in Chrome (structure and counts only):

| | Before | Now |
|---|---|---|
| Claude | A reply is `[data-testid="assistant-message"]` with its text in `[data-perf-reply-text]`; `.font-claude-response` is gone, so a save kept the questions and silently dropped every reply. | Replies are read; the spoken "You said / Claude responded" headings and the thinking and tool panels stay out. |
| Gemini | Read correctly signed in and out. A code block's header ("Python" and its buttons) leaked into the text above an unlabelled fence. | The header names the fence's language and is left out of the text. |
| Perplexity | Read correctly once rendered, but only the turns near the screen are on the page: opened at its end, a thread started mid-reply with its first question missing. | Saved as it is, and the popup says only part was on the page. |

Claude virtualizes long chats the same way (an 18-row chat had rows 13–17
mounted), so for both apps no scroll position has every message: the reader
sets `partial` from the rows' own positions (`data-index` and
`data-perf-row-from-tail` on Claude, `data-workflow-entry` on Perplexity),
and the popup points to the app's export or a paste instead of "scroll up".

Chrome turns an error thrown inside an injected function into
`result: null` (checked on Chrome 155), which the popup could only call
"Chrome didn't let Hubble read this page". The reader now catches its own
errors and answers `read-failed`, with the error (never page text) in the
service worker's log. That message was the one reported for these apps; the
reader did not throw on any page checked, so what caused it is still
unconfirmed. The service worker's `[Hubble] capture-read-refused` line now
says which it was. Fixtures: "signed in (live markup, 2026-10-16)".

Deliberately absent: provider sign-in, cookies, private or undocumented
endpoints, background reading of tabs, and any "sync". Saving again is how a
grown conversation is brought up to date.

## 6. Hubble for Chrome

`extension/` 0.7.0. The popup's AI section (`popup/ai-panel.js`) appears on a
conversation page of a known AI app:

```
popup ──► background ──► content script (Hubble tab) ──► Hubble page
   HUBBLE_PAGE_REQUEST { requestId, kind, args }    kinds: projects · capture · search · bundle · reused
```

- The page answers (`hooks/use-extension-memory.ts`); every request is
  re-read with a closed schema (`lib/memory/extension-protocol.ts`), and the
  content script only relays (15 s timeout). Before the store is ready the
  page answers `not-ready`.
- Reading and inserting run with `chrome.scripting.executeScript` in the one
  tab the person is on, after their click. No host permissions and no content
  script on AI sites.
- Failures say what to do: *not a conversation page*, *Hubble isn't open*,
  *this page's layout isn't recognised — paste it in Hubble instead*,
  *the project was deleted*, *no message box — copied instead*.
- **Hubble Desktop open:** Save goes there instead — over its loopback
  bridge, not the Hubble page — and the person picks the project in Hubble
  Desktop ([desktop-import.md](desktop-import.md)). The webview re-reads it
  with the same `readConversationCapture` and saves it with the same save.
  Search and context ("Use your knowledge here") stay with Hubble on the web:
  the bridge only takes things in.

## 7. Web, desktop and connectors

- **Web**: everything above.
- **Desktop**: projects, notes, paste and import, search and *Use in AI chat*
  (copy) work offline. Hubble for Chrome cannot reach the desktop webview, so
  *Save to Hubble* and insert are Chrome-only; tabs sent to Desktop arrive as
  links, and an AI conversation sent that way is saved as a link that asks
  for its text (paste it, or save it from the page in Hubble on the web).
- **AI connectors** (MCP, [ai-integrations.md](./ai-integrations.md)) read
  synced data only — project names, links, titles, collections, notes on
  links. Saved conversation text and notes written in Hubble are device-local
  and are not visible to a connector.

## 8. Privacy

Local-first: saved text stays in the browser or desktop app that saved it.
Nothing is sent to an AI app except the context the person copies or
inserts, after seeing it. The local loop log counts milestones
(`conversation_captured`, `search_used`, `memory_copied`, …) with the AI app's
id and a time — never content, titles or addresses — and is never sent.

## 9. What was removed

The agent product — the Command Centre, agent sessions, approvals, the local
and remote agent runtimes, the Claude Code / Codex / Gemini CLI / Grok
adapters, provider connections (BYOC keys), handoff, agent history and the
desktop's bundled runtime — was removed with its routes, UI, stores, tests and
dependencies (`@anthropic-ai/claude-agent-sdk`, `@vercel/sandbox`,
`@vercel/oidc`). Shared infrastructure was kept and moved: the context
resolver (`lib/context/`), workspace topics/insight/plans
(`lib/knowledge/workspace/`), the MCP server for AI connectors, sync, auth,
the graph, collections and Smart Organize.

What the agent features stored on a device is **not deleted on upgrade**.
Settings → Data lists it, downloads it as JSON, and deletes it only when asked
(`lib/storage/legacy-agent-data.ts`). Old agent entries in project history
are kept on every write and hidden from the history view. Server-side agent
history tables in Postgres are left untouched; nothing reads them.

## 10. Testing

```bash
npx vitest run src/lib/conversations src/lib/memory src/lib/notes src/lib/providers
npx vitest run src/hooks/use-extension-memory.test.tsx extension/src/ai-pages.test.js
npx vitest run src/lib/storage/legacy-agent-data.test.ts
```

The provider DOM readers are tested against fixtures shaped like each app's
markup; they are not verified against the live apps. Check *Save to Hubble*
and *Insert* by hand on each app after any change, and whenever an app
changes its layout.
