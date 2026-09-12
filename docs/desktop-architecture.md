# TabDump Desktop (Tauri) — architecture

TabDump ships from one codebase to three surfaces:

```
                         TABDUMP PRODUCT
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
     Web Application      Desktop Application   Browser Extension
     Next.js 16 (Vercel)  Tauri 2 + WebView2    MV3 (extension/)
          │                     │                     │
          └──────────┬──────────┘                     │
                     ▼                                ▼
         Shared frontend: src/ (identical)   postMessage bridge
                     │                        (web origin only)
                     ▼
       Local-first data: localStorage + IndexedDB
```

The desktop app is an **additional distribution target for the existing
frontend**, not a fork of it and not a rebuild. Both surfaces run the same
`src/` tree; the only code that knows which shell it is in lives in
`src/lib/platform/`.

## Why a static export, and why that is safe here

The desktop build is `next build` with `output: "export"`, bundled into the
Tauri binary and served from `tauri://localhost` (`http://tauri.localhost`
on Windows).

That works because of a property of this specific app, verified in the
codebase rather than assumed:

| Requirement for static export | TabDump |
| --- | --- |
| No dynamic routes | 4 static routes: `/`, `/privacy`, `/terms`, `/cookies` |
| No router hooks | No `useRouter` / `usePathname` / `useSearchParams` anywhere |
| No server actions | None (`"use server"` appears nowhere) |
| No `next/image` default loader | `next/image` is unused |
| Product data not server-held | **Local-first** — workspaces, collections, dependencies and graph layout live in `localStorage` (`src/lib/storage/namespace.ts`); the AI index lives in IndexedDB |

That last row is the important one. Accounts in TabDump *partition* local
storage; they do not sync it. There is no server-side workspace store, so
the exported bundle is the whole product rather than a shell around a
backend.

### How the API routes are excluded

`next.config.ts` sets `pageExtensions: ["tsx"]` for the desktop target.
Every route handler under `src/app/api/` is a `route.ts`; every page and
layout is a `.tsx`. Restricting the resolver to `.tsx` therefore drops all
seven handlers from the desktop route tree **without moving, renaming or
conditionally compiling a single file**, and leaves them exactly where they
are for the web build that serves them.

Those handlers read `Request` and `cookies()`, which a static export cannot
represent, so they must not be in the tree. Verified: the web build still
lists all seven as `ƒ (Dynamic)`; the desktop export lists only the four
static pages.

## The platform seam

`src/lib/platform/` is the only place in the codebase that asks which shell
is running. There is no `if (window.__TAURI__)` scattered through
components.

| File | Role |
| --- | --- |
| `detect.ts` | `isDesktop()` — reads `window.__TAURI_INTERNALS__`. The single source of truth |
| `types.ts` | The `PlatformAdapter` interface — deliberately only two capabilities |
| `web.ts` | Browser implementation (the pre-existing behaviour, moved not rewritten) |
| `desktop.ts` | Tauri implementation. **Only file allowed to name `@tauri-apps`, and only via `await import()`** |
| `index.ts` | Dispatch: `openExternal`, `saveTextFile` |
| `api-base.ts` | `apiUrl()` — where TabDump's own API lives per shell |

Only two capabilities qualify, because only two would be *wrong* on desktop
rather than merely different:

1. **`openExternal`** — on the web, clicking a saved tab reuses the current
   browser tab. On desktop that would navigate the app window to someone
   else's website, turning TabDump into a bad browser with no way back.
2. **`saveTextFile`** — the web export clicks a hidden `<a download>` with a
   blob URL. A Tauri webview has no download UI for that to land in, so the
   export would silently go nowhere.

Clipboard, file *import*, `localStorage` and IndexedDB are deliberately
**not** abstracted: they behave identically in WebView2, so wrapping them
would add indirection and buy nothing.

`src/lib/platform/no-tauri-in-web.test.ts` enforces the import rule
structurally, so a future static `@tauri-apps` import — which could break
the deployed website at module-evaluation time — fails `npm test`.

**Verified in the built bundle:** `@tauri-apps/api/core` compiles to a
separate 351-byte lazily-loaded chunk that the web build never fetches.

## Native surface (the whole of it)

Two app-defined Rust commands in `src-tauri/src/commands.rs`, plus a
navigation guard. No `fs`, `shell`, `http` or `process` plugin is enabled,
and the frontend holds no plugin permission at all.

| Command | Shape | Why it is safe by construction |
| --- | --- | --- |
| `open_external(url)` | URL in, nothing out | Safelists `http`/`https` in Rust, so `file:`, `javascript:` and OS-handler schemes (`ms-settings:`) are unreachable. The JS `opener` plugin is **not** enabled, so the frontend cannot bypass this check |
| `export_text_file(suggested_name, contents)` | Filename + text in, `bool` out | Takes a *name*, never a path. The path comes from the native save dialog the user just used, so the only file the app can write is one the user picked by hand |

The **navigation guard** (`src-tauri/src/lib.rs`) is the backstop: any
navigation to a non-app origin is cancelled, and an `http(s)` one is handed
to the default browser instead. So even a link that never reaches
`openTab()` cannot strand the window on a foreign page.

## Authentication: signed-out by design in v1

The desktop app does not sign in, and that is a deliberate security
decision rather than an unfinished feature.

Two independent blockers, both verified in this codebase:

1. **Google Identity Services will not accept the origin.** GSI requires an
   authorized JavaScript origin; `tauri://localhost` is not an `https`
   origin and `http://tauri.localhost` is not a registrable domain. Google
   accepts neither.
2. **The session cookie cannot travel.** It is `HttpOnly`, `SameSite=Lax`
   and same-origin, and every auth fetch uses
   `credentials: "same-origin"`. Making it work cross-origin would mean
   `SameSite=None` plus CORS-with-credentials — dismantling the exact CSRF
   posture `src/lib/auth/origin.ts` was built to provide.

So `fetchAuthState()` answers locally on desktop
(`src/lib/auth/client.ts`): signed out, `configured: false`. That reuses
the app's existing "this deployment has no Google client ID" path, which
already hides the sign-in UI entirely — rather than rendering a Google
button that cannot work.

**Everything else still works**, because the product is local-first:
workspaces, the spatial graph, search, Auto-Organize, and import/export all
run with no account and no network.

### The designed path to desktop accounts

`docs/auth-architecture.md` already specifies the answer for this exact
class of client, in "What the browser extension should do later". The
desktop app is the same kind of client — a non-browser origin that cannot
use cookies — so it takes the same route:

1. Desktop opens the deployed TabDump site in the **system browser**, where
   sign-in works normally with the origins Google already authorizes.
2. That page requests a short-lived, single-use pairing code under
   `requireUser`, so the code is bound to the session's user.
3. Desktop exchanges the code for its **own token type** — a separate row
   with its own expiry, revocable independently, so signing out of the site
   does not kill the desktop app and vice versa.
4. Desktop sends that token as `Authorization: Bearer`, never a cookie, so
   CSRF does not apply. The desktop origin needs an explicit allowlist
   entry alongside the same-origin check.

What must **not** happen — the same rule as the web flow — is the desktop
app asserting a `userId` or `email` and the server believing it.

## Talking to the backend from desktop

`src/lib/platform/api-base.ts` centralises this. On the web `apiUrl()` is
the identity function, so every call stays relative and same-origin exactly
as before. `NEXT_PUBLIC_TABDUMP_API_ORIGIN` can point those calls at a
deployed TabDump instead.

It is **unset for the v1 desktop build**, deliberately:

- The backend sends no CORS headers, so a cross-origin call from the
  desktop origin is blocked by the engine regardless. Enabling it means
  first adding an explicit `Access-Control-Allow-Origin` allowlist entry for
  the desktop origin on the *unauthenticated* routes (`/api/titles`,
  `/api/ai/*`).
- The session cookie could not ride along anyway (see above).

Nothing breaks as a result, because both server-backed extras already
degrade on their own:

| Feature | Desktop v1 behaviour |
| --- | --- |
| Title resolution (`/api/titles`) | Falls back to domain-derived titles — the existing offline path in `src/lib/titles/client/queue.ts` |
| Auto-Organize AI hints (`/api/ai/*`) | Falls back to deterministic domain/keyword clustering, exactly as with no `GEMINI_API_KEY` |

## Browser extension relationship

The extension's content script is injected **only into the TabDump web
origin**. A Chrome extension cannot inject into a WebView2 application, so
the extension bridge is inherently web-only and is permanently
"not connected" on desktop.

This needs no new conditionals: the app already handles a missing
extension. History Dump has a dedicated `not-connected` state.

The actual dump flow today is:

```
Browser tabs
  → extension popup (chrome.tabs)
  → content script on the TabDump WEB origin
  → window.postMessage TABDUMP_IMPORT → TABDUMP_IMPORT_ACK
  → the page writes to that account's localStorage namespace
```

**Honest limitation:** because that path ends in the *web origin's*
localStorage, tabs dumped through the extension do **not** appear in the
desktop app. There is no server-side workspace store to carry them across,
and inventing one would duplicate a backend the product does not otherwise
have.

Today's supported bridge between the two is the existing, first-class
**JSON export/import** — the same format, validated by the same
`json-import.ts`, so a workspace moves web → desktop losslessly. The clean
long-term fix is workspace sync behind the pairing flow above, at which
point the extension keeps dumping into the web app and both clients read
the same account.

Likewise **History Dump** needs `chrome.history`, which only the extension
can reach, so its scan is unavailable on desktop and shows the existing
"extension not connected" state. Its scoring and selection logic is
untouched and shared.

## Data compatibility

Nothing about the data model changed. Desktop uses the same `localStorage`
keys, the same namespacing scheme, the same workspace serialization and the
same export format. A desktop install is simply another device with its own
local data — exactly like a second browser profile.

## Commands

```bash
# Web (unchanged — no Rust toolchain required)
npm run dev             # http://localhost:3000
npm run build           # production build, all 7 API routes intact
npm test

# Desktop (requires Rust + platform build tools)
npm run desktop:dev     # Tauri window against the Next dev server (hot reload)
npm run desktop:export  # static frontend only -> out/
npm run desktop:build   # packaged app -> src-tauri/target/release/bundle/
npm run desktop:icons   # regenerate icons from src/app/icon.svg
```

A developer working only on the website never needs Rust: the desktop
branch of `next.config.ts` is gated behind `TABDUMP_BUILD_TARGET=desktop`,
which only the `desktop:*` scripts set.

### Prerequisites for the desktop build

- **Rust** (stable, 1.77.2+) via [rustup](https://rustup.rs/)
- **Windows:** Visual Studio Build Tools with the MSVC and Windows SDK
  components, plus the WebView2 runtime (present on Windows 11 by default)
- **macOS:** Xcode command line tools. The bundle config is structured so
  macOS targets can be added without touching application logic, but no
  macOS build has been produced or signed from this repository.

`npx tauri info` reports whether the local toolchain is complete.
