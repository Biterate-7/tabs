# Use in AI

Choose resources in a Hubble project, choose ChatGPT, Claude, Gemini or
Perplexity, add instructions if you like, and Hubble for Chrome opens a new
chat there with the message (and uploaded files' originals) in place — ready
for you to review and send, or sent for you when you chose that for this one
transfer. Without the extension, and in Hubble Desktop, the same button copies
the message and opens the app.

```
Hubble page                         Hubble for Chrome                       AI app tab
───────────                         ─────────────────                       ──────────
ReuseDialog ─ packageTransfer       content script (relay only)
  │ load originals (getFile)          │
  │ sendTransfer ───────────────────► background: only from Hubble's tab
  │   HUBBLE_AI_TRANSFER                │ createTransferRunner
  │                                     │  1 optional host permission ──► permissions/grant.html
  │                                     │  2 a new-chat tab: reuse or open
  │ ◄── HUBBLE_AI_TRANSFER_PROGRESS ─── │  3 wait for load
  │                                     │  4 hubbleTransferStep ──────────► probe → attach → insert → (submit)
  │ ◄── HUBBLE_AI_TRANSFER_RESULT ───── │  5 result, as far as it was seen
```

## Code

| Piece | Where |
|---|---|
| What each item becomes (attach / text / link / unavailable), the message, the all-text alternative, limits | `src/lib/ai-transfer/package.ts` (uses `lib/memory/bundle.ts`, which now names attached files instead of quoting them) |
| Wire format, validation, words for every state and error | `src/lib/ai-transfer/protocol.ts` |
| Page transport (hello, transfer, progress) | `src/lib/ai-transfer/client.ts` |
| One run, from preparing to a result; retries reuse the operation id | `src/hooks/use-ai-transfer.ts` |
| The dialog ("Use in AI", opened from every "Use in AI" action) | `src/components/memory/reuse-dialog.tsx` |
| Provider facts: new-chat address, limits, what is claimed and how it was checked | `src/lib/providers/registry.ts` (`transfer`, `newChatPaths`, `capabilities.insert/attachFiles/autoSubmit`, `liveCheck`) |
| The runner: request check, permission, tab choice, steps, op records | `extension/src/ai-transfer.js` |
| The per-app adapters, injected one step at a time | `extension/src/ai-transfer-page.js` |
| Wiring, sender check, permission window | `extension/background/background.js`, `extension/permissions/grant.*` |
| Relay | `extension/content/content-script.js` |

## Rules it keeps

- **Only what was chosen, only when asked.** Nothing leaves Hubble before the
  person clicks; one project per transfer; nothing is logged but counts and
  states (never message text, file bytes or addresses).
- **Prepare is the default.** Send automatically is chosen per transfer and
  never remembered. The runner presses send only for `mode: "send"`, only on
  a box that still holds Hubble's message, and says *sent* only once the box
  has emptied.
- **Never into the wrong place.** Only a tab on the app's new-chat page is
  reused, and only with an empty box. A box holding the person's draft is
  never touched: a borrowed tab gives way to a new one; a new tab that comes up
  with a draft stops the transfer (`composer-has-draft`).
- **Files go as files where they can, and are never claimed otherwise.** An
  uploaded file's original (from the device's `files` store) is attached first;
  the message then names it instead of quoting it. If the app doesn't show it
  as attached (or asks for a sign-in), the all-text version is typed instead
  and the dialog names each file that didn't attach and why. Links stay links:
  the message says when Hubble has only the address, and the dialog flags
  addresses the AI app can't open (localhost, a private network).
- **Limits are said, not applied silently.** Each app has a message size
  Hubble keeps to (`AI_PROVIDERS[…].transfer.messageChars`: ChatGPT and Claude
  60,000 characters, Gemini 30,000, Perplexity 15,000 — Hubble's own bounds,
  not vendor figures). Over it, the dialog offers a shorter length, fewer
  items, the context as one Markdown file, or copying.
- **Safe to repeat.** Every transfer has an `opId`; its record lives in
  `chrome.storage.session`. A finished one answers again with the same result
  (no second message, no second send); a running one says so; a failed one
  is retried in the same tab when that is still a new chat.
- **Bounded.** Tab load 30 s, message box 15 s, each attach method 8 s,
  insert read-back 5 s, send button 45 s, send confirmation 10 s, permission
  window 2 min. The service worker is kept awake while a transfer runs.

## Permissions

The manifest lists the four apps' origins under `optional_host_permissions`
only. The first transfer to an app opens a small window
(`permissions/grant.html`) that says what the access is for; Chrome's own
prompt follows the person's click on **Allow**. Nothing is requested at
install, and access can be removed in Chrome's extension settings. Saving a
conversation and the popup's Insert keep using `activeTab` as before.

Only Hubble's own page can start a transfer: the background accepts
`HUBBLE_AI_TRANSFER` only from the top frame of a tab on the Hubble origin,
re-checks every field, and accepts a permission answer only from its own
window.

## What works where (2026-10-19)

| | ChatGPT | Claude | Gemini | Perplexity |
|---|---|---|---|---|
| New chat opened or reused, message inserted and read back | **live, signed out** (plain box) · fixture (ProseMirror) | fixture only — signed out, claude.ai goes to sign-in (reported as *sign-in required*) | **live, signed out** (Quill) | **live, signed out** (Lexical, line breaks kept) |
| Existing draft left alone, new tab used | **live** | fixture | **live** | fixture |
| Original file attached | fixture; live signed out the app asked to log in → reported, text version typed | fixture | fixture; live signed out not shown → reported, text version typed | fixture; live signed out the app asked to sign in → reported, text version typed |
| Send automatically | **live, signed out** | fixture | **live, signed out** | **live, signed out** |

"Live, signed out" is Hubble's automated QA in Chrome against the real site
without an account; it is recorded per capability as `liveCheck` in the
registry and shown in Settings → AI apps. Nothing was tried in a signed-in
account. Attaching files has not been seen to succeed on any live app yet,
because every app tried requires a sign-in to upload.

## Website, extension, desktop

- **Website + Hubble for Chrome 0.8.0**: the full transfer.
- **Website without the extension** (or an older one, told apart by the
  hello): *Copy & open <app>* — the all-text message on the clipboard, the app
  in a new tab, and buttons to save uploaded files' originals to attach by
  hand.
- **Hubble Desktop**: the same copy-and-open, in the default browser. The
  desktop's loopback bridge only takes things in (an earlier decision: any
  local program can forge the extension's origin), so Desktop cannot hand a
  transfer to the extension; the dialog says so.

## Testing

```bash
npx vitest run src/lib/ai-transfer src/components/memory/use-in-ai-dialog.test.tsx src/lib/providers
npx vitest run extension/src/ai-transfer.test.js extension/src/ai-transfer-page.test.js extension/background/ai-transfer.test.js extension/content/ai-transfer-relay.test.js extension/permissions/grant.test.js
```

The adapters are tested against mocked pages shaped like each app's composer.
Apps change their markup without notice: after a layout change, run a prepare
and a send against each app by hand (signed in where you can), and update
`liveCheck` with what you saw.
