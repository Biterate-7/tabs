# TabDump accounts

TabDump owns its account system. Google is the identity provider and
nothing more: it proves who someone is, once, and every user record,
session, and authorization decision after that belongs to this codebase.
There is no third-party authentication platform anywhere in the stack, and
no provider branding in the UI beyond Google's own sign-in button (which
Google's brand terms require to be theirs).

## The shape of it

```
Browser
  │  Sign in with Google (Google Identity Services)
  ▼
Google  ──────────────── signed ID token (JWT) ──────────────┐
                                                             │
  ┌──────────────────────────────────────────────────────────┘
  ▼
POST /api/auth/google        src/app/api/auth/google/route.ts
  │
  ├─ verify signature / iss / aud / exp   src/lib/auth/google.ts
  ├─ verify the login nonce               src/lib/auth/nonce.ts
  ├─ find or create the TabDump user      src/lib/auth/account.ts
  ├─ mint a TabDump session               src/lib/auth/session.ts
  └─ Set-Cookie: tabdump_session=…; HttpOnly; Secure; SameSite=Lax
       │
       ▼
Authenticated TabDump
```

Nothing downstream of the verification step trusts anything the browser
said. There is no `email` or `userId` field in any accepted request body,
and sending one changes nothing — the identity comes from the token's
claims.

## Why an ID token and not the authorization-code flow

TabDump uses Google Identity Services' ID-token flow: Google returns a
signed JWT to the page, the page posts it to `/api/auth/google`, and the
server verifies it against Google's published signing keys.

Consequences worth knowing:

- **No redirect URI.** The user never leaves tabsdump.vercel.app. Google
  Cloud Console needs *Authorized JavaScript origins* only.
- **No client secret.** Verification uses Google's public keys. Nothing in
  this codebase reads `GOOGLE_CLIENT_SECRET`; there is no secret to leak
  into a bundle because there is no secret in play.
- **The client ID is public,** as Google documents. It is not a
  capability — a token minted with it still has to survive server-side
  verification here.

## The login nonce

`POST /api/auth/nonce` issues a random nonce, returns it to the page, and
stores its SHA-256 in a short-lived HttpOnly cookie. The page hands the
nonce to Google, Google signs it into the token's `nonce` claim, and
`/api/auth/google` rejects any credential whose nonce doesn't match.

Two attacks this closes:

- **Replay.** A credential captured anywhere else carries a nonce this
  browser was never issued.
- **Login CSRF.** Without it, an attacker can push *their own* valid Google
  credential into a victim's browser and silently sign the victim into the
  attacker's account — after which the victim's tabs get dumped somewhere
  the attacker controls. An attacker cannot mint a Google token carrying the
  victim's nonce.

The nonce cookie is cleared on every response from `/api/auth/google`,
success or failure, which is what makes a nonce single-use.

## Sessions

One model, no variants:

```
cookie token  →  SHA-256  →  session row  →  user row  →  expiry check
```

- The token is 32 bytes from the OS CSPRNG (`src/lib/auth/tokens.ts`).
  `Math.random()` appears nowhere.
- The browser holds the raw token in an HttpOnly cookie. Page JavaScript —
  ours or an injected script's — cannot read it, and nothing is ever written
  to `localStorage`.
- The store holds only the hash, so a leaked copy of the sessions table
  contains nothing replayable.
- 30-day expiry, slid forward once a session passes halfway through its
  life. Expired rows are deleted the moment they're presented.
- Logout deletes the row *first*, then clears the cookie. A token that has
  been signed out is dead everywhere, not just in the browser that had it.
- Every sign-in mints a fresh token, so a cookie value planted before login
  is worthless afterwards (session fixation).

## Where users and sessions live

`AuthStore` (`src/lib/auth/types.ts`) is the only persistence surface auth
talks to. Two implementations:

| | `PostgresAuthStore` | `MemoryAuthStore` |
|---|---|---|
| When | `POSTGRES_URL` / `DATABASE_URL` is set | local development with neither set |
| Durable | yes | no — one process, lost on restart |
| Used in production | yes | **never** — `getAuthStore()` refuses |

A serverless deployment gives every invocation its own memory, so a
memory-backed session would exist for one request and not the next. Rather
than ship that as an intermittent "randomly signed out", `getAuthStore()`
reports the deployment unconfigured, `/api/auth/me` answers
`configured: false`, and the UI hides sign-in entirely. TabDump's local-first
features all keep working.

Schema: `src/lib/auth/store/schema.sql`, applied with `npm run migrate:auth`.
Additive and idempotent — every statement is `IF NOT EXISTS`, nothing is
dropped or rewritten.

```
tabdump_users     id, google_sub UNIQUE, email, name, avatar_url, created_at, updated_at
tabdump_sessions  id, user_id → users ON DELETE CASCADE, token_hash UNIQUE, created_at, expires_at, last_used_at
                  + indexes on user_id and expires_at
```

`google_sub UNIQUE` is what actually prevents duplicate accounts: two
concurrent first-time sign-ins both reach the INSERT, and the constraint
decides which one wins (`ON CONFLICT DO UPDATE` gives the loser the existing
row). Checking "does this user exist?" first is not a substitute, and the
memory store mirrors the same atomicity by never yielding mid-upsert.

**Identity is `google_sub`, never email.** A Google account's email can
change, and a released address can later belong to someone else. Looking
accounts up by email would both split one person into two accounts and hand
a recycled address the previous owner's data.

## Authorization, and where it applies

TabDump is local-first. Workspaces, tabs, collections, dependencies and
graph layout live in the browser's `localStorage` — there is no server-side
workspace to protect, and this change did not add one. So "user A cannot
reach user B's data" has to hold at the persistence layer, and it does:

```
signed out        tabdump:workspaces:v1
signed in as U    tabdump:u:<U>:workspaces:v1
```

`src/lib/storage/namespace.ts` owns that prefix; `AuthProvider` is its only
writer and re-keys the app shell whenever it changes, so the shell
re-hydrates from the right account's data. The signed-out keys are the
*existing* keys, unchanged — adding accounts moved nobody's data and deleted
nothing.

Deliberately **not** namespaced: appearance settings, onboarding state,
sidebar collapse, and the resolved-title cache. Those are device
preferences and derived caches, not personal content; scoping them would
lose a signed-in user their theme, and the pre-hydration theme script in
`src/app/layout.tsx` runs long before any account is known.

Server-side, the rule for any future account-scoped resource is the one
`/api/auth/me` already follows: **derive the owner from the session, never
from the request.**

```ts
import { requireUser } from "@/lib/auth/guard";

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;          // 401, or 503 if unconfigured

  // auth.user.id came from the session cookie. A workspace id from the URL
  // is an input to be checked against it, never a claim to be believed:
  //   SELECT … FROM workspaces WHERE id = $1 AND user_id = $2
  // and a row that doesn't match answers 404, not 403 — a 403 would confirm
  // that someone else's workspace exists.
}
```

`optionalUser(request)` is the same lookup for endpoints that must keep
working signed-out.

The Gemini-backed routes (`/api/ai/*`, `/api/titles`) are deliberately
untouched. They are public utilities that take URLs and text and return
titles, embeddings and organization hints; none of them reads or writes
anybody's account data, so gating them would remove working functionality
without protecting anything.

## CSRF

- Session and nonce cookies are `SameSite=Lax`, so a cross-site POST doesn't
  carry them. This is the primary defence.
- Mutating routes are POST-only and require `content-type: application/json`,
  which a cross-site form, image or script tag cannot set without a
  preflight — and nothing here answers a preflight with permissive CORS.
- `Origin`, when present, must match the request's own origin
  (`src/lib/auth/origin.ts`).
- The login nonce covers login CSRF specifically, independent of cookie
  policy.

There is deliberately no CSRF *token*: it would need a second server-side
store to hold it, and closes no attack the three layers above leave open.

## Local development

With no `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, TabDump runs exactly as it always
did — no sign-in UI, and no auth request is made at all.

To exercise accounts locally:

1. Add `http://localhost:3000` to the OAuth client's *Authorized JavaScript
   origins*.
2. Put `NEXT_PUBLIC_GOOGLE_CLIENT_ID=…` in `.env.local`.
3. `npm run dev`. With no database configured, sessions land in the
   in-memory store and last until the dev server restarts. Set
   `POSTGRES_URL` and run `npm run migrate:auth` to use a real one.

The session cookie is `Secure` only in production, because a `Secure` cookie
is dropped over the plain http that `next dev` serves. That is the single
development relaxation, and it is conditioned on `NODE_ENV`, never on a
runtime flag.

## What the browser extension should do later

The extension in `extension/` does **not** talk to the TabDump API today. It
delivers a dump by `postMessage` into an open TabDump tab
(`TABDUMP_IMPORT` → `TABDUMP_IMPORT_ACK`, see `extension/src/config.js` and
`src/lib/browser/protocol.ts`), and the page — already running as whoever is
signed into it — writes the tabs to that account's namespace. So the
extension inherits the right account without knowing anything about
accounts, and nothing about it changed here.

When the extension does need to call the API directly, the piece to add is a
**pairing flow**, not an extension login:

1. The extension opens `https://tabsdump.vercel.app/…` in a normal tab. The
   user is already signed in there, or signs in with the same UI.
2. That page asks the backend for a short-lived, single-use pairing code
   under `requireUser`, so the code is bound to the session's user and to
   nothing the client asserted.
3. The extension exchanges the code for its own long-lived credential —
   a **separate token type from a web session**, stored as its own row with
   its own expiry, revocable on its own. Reusing the web session cookie
   would mean signing out of the site silently killed the extension, and
   revoking the extension would sign the browser out.
4. Every extension request presents that token in an `Authorization` header
   (not a cookie — a cookie from a `chrome-extension://` origin is a CORS
   and SameSite problem, and a bearer token isn't subject to CSRF at all).
   `Origin: chrome-extension://<id>` needs an explicit allowlist entry
   alongside the same-origin check.

What must **not** happen: the extension sending a `userId`, `email` or
`workspaceId` and the server believing it. That is the same rule as the web
flow — the server derives the user from a credential it verified, always.

## Session rotation

Every sign-in mints a new token *and* deletes the row behind whatever
session cookie the request arrived with. That cookie is about to be
overwritten, so its row would otherwise become unreachable — live, but
invisible to the user and impossible to revoke. Rotating means signing in
again evicts a leaked copy of the previous token, and account switching
doesn't strand one live session per switch. It is scoped to the cookie
actually presented, so signing in on a laptop never signs you out on a
phone.

## Known limitations

- Sign-in requires a Postgres connection string in production. Without one
  the account system reports itself unavailable rather than half-working.
- Sessions are not synchronised across devices, because the data isn't
  either: signing into the same account on a second browser gives that
  browser its own empty namespace. Cloud sync is a separate feature, and
  this schema is the foundation it would build on.
- Expired session rows are removed when presented (and superseded ones on
  re-sign-in); `deleteExpiredSessions` exists for a periodic sweep but is
  not scheduled, so a session belonging to someone who never returns sits
  in the table until one is.
- **Rate limiting on the sign-in endpoints is per-process and in-memory**,
  inherited from the AI routes' limiter. On serverless that means it is
  close to ineffective — each instance keeps its own counters. It is not
  guarding a guessable credential (a sign-in requires a Google-signed
  token), only the CPU cost of verification, so this is a cost control
  rather than a security boundary. A real limit would need shared state
  (the same database, or a KV store) and is deliberately not built here.
- The pending login nonce lives in one cookie, so opening the sign-in dialog
  in a second tab supersedes the first tab's. Completing the sign-in in the
  older tab then fails with "that sign-in has already been used", and its
  "Try again" arms a fresh one. A per-attempt cookie would avoid it at the
  cost of a cookie name that has to be threaded through the flow.
- Google's sign-in button is loaded from accounts.google.com, so a content
  blocker that blocks it leaves the panel showing a "couldn't reach Google
  Sign-In" message with a retry. Nothing else in TabDump is affected.
- The AI index in IndexedDB (`tabdump-ai`) is keyed by workspace id rather
  than by account. Workspace ids are unique, so no account can read
  another's chunks, but a signed-out session's chunks are not evicted when
  someone signs in.
