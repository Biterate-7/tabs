# Hubble brand

TabDump was rebranded to Hubble. This folder holds the logo source and records
what the rebrand deliberately did **not** rename.

## The logo

`hubble-logo-source.webp` is the supplied Hubble logo, committed unchanged. It
is the only source of truth for the visual identity. Every other logo file in
the repository is generated from it, so do not edit the generated files by
hand, and do not redraw the mark as a vector: its shaded faces are part of the
design.

```bash
npm run brand:assets
```

`scripts/build-brand-assets.mjs` finds the mark in the source, takes a square
crop centred on it (the logo's own dark background included), and writes:

| Output | Used for |
| --- | --- |
| `src/app/favicon.ico` (16/32/48) | Browser tab favicon |
| `src/app/icon.png` (512) | `<link rel="icon">` for modern browsers |
| `src/app/apple-icon.png` (180) | iOS home-screen icon (full bleed; iOS masks it) |
| `src/app/opengraph-image.png` (1200×630) | Open Graph / social preview |
| `public/brand/hubble-mark.png` (128) | In-app mark (`BrandMark`: sidebar, sign-in, landing page) |
| `extension/icons/icon{16,32,48,128}.png` | Extension toolbar, popup and store icons |
| `src-tauri/icons/*` | Desktop app icons (`tauri icon` builds .ico/.icns/PNGs from the 1024px master) |

Small targets (favicon, 16/32px extension icons, the in-app mark) use a tighter
crop so the mark stays legible; large targets keep more margin for platform
masks. To change the logo, replace `hubble-logo-source.webp` and re-run the
script.

## Identifiers that still say `tabdump`

These are technical identifiers, not branding. Renaming any of them would
break existing installations, stored data or deployments, so they were kept.
None is shown as product branding in the UI.

| Identifier | Where | Why it stays | Migration later? |
| --- | --- | --- | --- |
| `tabdump:*` localStorage keys (e.g. `tabdump:workspaces:v1`, `tabdump:settings:v1`, `tabdump:u:<id>:…`) | `src/lib/storage/namespace.ts` and every persistence module | Renaming would hide every existing user's workspaces, settings and agent data | Possible with a copy-then-retire migration in the storage namespace layer |
| `tabdump-ai` IndexedDB database | `src/lib/ai/db.ts` | Holds each user's local embedding index | Possible, but rebuilding the index is the cheaper option |
| `tabdump_*` Postgres tables, indexes and constraints | `src/lib/sync/schema.sql`, `src/lib/auth/store/schema.sql` | Live production schema; a rename needs a coordinated migration | Yes, with a migration |
| `tabdump_session`, `tabdump_login_nonce` cookies | `src/lib/auth/config.ts` | Renaming the session cookie signs every user out. The Cookie Policy names them because it must be accurate | Yes, by accepting both names for one session lifetime |
| `app.tabdump.desktop` Tauri identifier | `src-tauri/tauri.conf.json` | Windows keys the WebView2 profile (where desktop workspaces live) and app data on it | No, not without losing desktop data |
| WiX `upgradeCode` pinned to the TabDump-derived value | `src-tauri/tauri.conf.json` | Tauri derives it from `productName` by default; pinning keeps MSI upgrades in place | Must never change |
| `tabdump` / `tabdump_lib` Cargo crate names | `src-tauri/Cargo.toml` | Internal. The shipped binary is named by `mainBinaryName: "Hubble"` | Yes, cosmetic only |
| `tabdump-extension` message source and `TABDUMP_*` message types | `extension/src/config.js`, `src/lib/browser/protocol.ts` | Wire protocol between the extension and the page; an installed older extension must keep working | Yes, by accepting both during a transition |
| `tabdump_dump_state` extension storage key | `extension/src/config.js` | Extension session storage | Low value |
| `TABDUMP_*` / `NEXT_PUBLIC_TABDUMP_*` environment variables, and the `i-am-running-tabdump-on-my-own-machine` opt-in value | `.env.example`, `next.config.ts`, `src/lib/agents/control/runtime.ts` | Existing deployments and local `.env` files set them; the opt-in is an exact-match security gate | Yes, by reading both names |
| `--tabdump-*` CSS custom properties, `.tabdump-marketing` class, `application/x-tabdump-tab-id` drag type | `src/app/globals.css`, `src/app/marketing.css`, `src/lib/collections/drag.ts` | Internal, never visible | Yes, cosmetic only |
| `tabsdump.vercel.app` | `src/lib/site-url.ts`, `scripts/build-extension-zip.mjs`, `src-tauri/tauri.conf.json` | The deployed production origin. Changing it needs a new domain first | Yes, once a Hubble domain exists |
| `Biterate-7/tabdump` | GitHub remote | The repository name | Yes, GitHub redirects renamed repos |
| `tabdump` MCP server name (`TABDUMP_MCP_SERVER_NAME`) and `tabdump://workspace/…` resource URIs | `src/lib/mcp/server.ts` | Protocol identifiers existing MCP clients and logs key on. The name a client *shows* is the server's `title`, "Hubble" | Yes, by serving both |
| `tabdump_<id>` session context server names, so tools arrive as `mcp__tabdump_<id>__…` | `src/lib/agents/session-context/identity.ts` | Agent tool allowlists and the Command Centre's stage labels match this exact shape. The Command Centre shows these tools by their Hubble name ("Hubble · Listed tabs"), never the raw one | Only together with every allowlist that matches it |
| `scripts/tabdump-mcp-bridge.mjs` and its `TABDUMP_MCP_TOKEN` / `TABDUMP_MCP_URL` variables | `scripts/`, the Claude Desktop snippet in Settings → MCP | Existing Claude Desktop configs point at this path and set these names. The snippet's server key is `hubble` | Yes, with a second path during a transition |
| `tabdump-agent-node(.exe)` runtime sidecar | `src-tauri/tauri.conf.json` `externalBin`, `scripts/build-agent-runtime.mjs` | Internal process name, visible only in a task manager's details view | Yes, cosmetic only |
| `window.__tabdumpBridgeRegistered` | `extension/content/content-script.js` | Internal guard against double registration | Yes, cosmetic only |
| `tabdump.test`, `/projects/tabdump`, `tabdump-export.json` and similar | Test fixtures | Test data, never shipped | Not needed |

`/tabdump-extension.zip` redirects to `/hubble-extension.zip` (see
`next.config.ts`), so older links to the extension download keep working.

Dated plans and specs under `docs/superpowers/` are historical records and
still say TabDump.

## Type

New installs use the platform UI font (`system-ui`) for the product and keep
Geist as the display face (headings on the landing page, `--hb-font-display`).
See `DEFAULT_TYPOGRAPHY` in `src/lib/appearance/defaults.ts`.

Existing installs that have Geist as their interface font **keep it on
purpose**. Before the redesign, Geist was the default, and any settings change
writes the whole settings object (`writeSettings` in `src/lib/settings.ts`).
So anyone who ever changed a setting has Geist stored exactly like a font they
picked, and Hubble cannot tell a default Geist apart from a chosen one. Users
who never changed a setting have nothing stored and get the new default.
Changing it silently would override a
real preference for some people. Geist is still loaded, so it renders
correctly, and anyone can switch in Settings → Appearance → Typography.
