# AI Integrations — Hubble inside ChatGPT, Claude, Gemini and Grok

Hubble is an MCP server for the AI assistants people already use. The
assistant does the reasoning and the conversation. Hubble supplies the
person's saved workspaces, runs a small set of permitted operations, keeps
the project context the person asked it to keep, and records what each
client did.

```
AI client ──MCP (Streamable HTTP)──▶ /api/mcp ──grant──▶ Hubble's own operations ──▶ account-synced data
 ChatGPT · Claude · Gemini · Grok      one server        search · collections ·       (SyncService / Postgres)
 Gemini CLI · Claude Code · xAI API    one permission     proposals · context ·         + integration store
                                       model              notes · audit
```

This is one integration, not four. Every client reaches the same endpoint,
gets the same tools, is held to the same grant and is written to the same
audit log. What differs per product is only how it is set up, and that is
data in `src/lib/integrations/platforms.ts`.

Settings → **AI Integrations** is where a person connects, chooses
permissions, tests, approves proposals, reads saved context and disconnects.
Settings → AI Connections, the Command Centre and Hubble-launched agent
sessions are unchanged. Those cover the other direction, where Hubble starts
an agent.

---

## 1. Architecture and why

### The data an AI client can see

Hubble is local-first. A signed-out person's workspaces live in one browser
and no server has them. A signed-in person's workspaces are synced to the
deployment's Postgres by the existing sync engine (`docs/sync-architecture.md`).
That account copy is the only Hubble data any server holds, so it is the
only data an AI client can see. **A cloud MCP server cannot read browser
storage.** No path here pretends otherwise:

- `get_connection_info`, the consent page and the settings pane all say that
  only synced workspaces are visible.
- The consent page lists only synced workspaces. A connection cannot be
  granted one that is not synced, and an empty list is explained rather than
  shown as success.
- `get_resource` says plainly that extracted page, PDF and transcript text is
  not available. That content is device-local (IndexedDB, `lib/resources`)
  and is not synced.

### Connection modes

| Mode | Used by | Status |
| --- | --- | --- |
| **Remote MCP, OAuth 2.1** | ChatGPT, Claude connectors (web, Desktop, mobile), Gemini app, grok.com, Claude Code / Gemini CLI (optional) | Implemented |
| **Remote MCP, personal token** | Gemini CLI, Claude Code, Antigravity, xAI Responses API, MCP Inspector | Implemented |
| **Local stdio bridge** | Claude Desktop `claude_desktop_config.json` | Implemented (existing `scripts/tabdump-mcp-bridge.mjs`, now accepts personal tokens) |
| **Local MCP reading device-local data** | — | **Not implemented** (see below) |
| **Tunnel / bridge from a remote client to a local Hubble** | — | **Not implemented** (see below) |

**Why no local-data server.** The packaged desktop app is a static export
with no server and no IPC surface. It has two Rust commands and the
`core:default` capability only (`docs/desktop-architecture.md`,
`src/lib/platform/desktop-config.test.ts`). A local MCP server that reads the
webview's storage needs new native code, a capability change and a loopback
listener with its own authentication. That is a security decision of its
own, not a side effect of this feature. The design it would need is a
per-launch secret, an origin check and a capability limited to the read
model; it is recorded as a future extension.

**Why no tunnel.** ChatGPT, Claude.ai, the Gemini app and grok.com connect
from their own infrastructure, and each requires a public HTTPS endpoint
(Grok's documentation says so explicitly). A permanent public tunnel to a
person's computer would expose a long-lived, internet-reachable door to their
data. The deployed endpoint, gated by OAuth and per-connection grants, is the
safer place for that door.

### Modules

| Responsibility | Where |
| --- | --- |
| integration core: grants, scopes, client identity | `src/lib/integrations/{grants,scopes}.ts` |
| MCP server and tool registration | `src/lib/mcp/server.ts` (account server), `src/lib/mcp/integration-tools.ts` (new tools), `src/lib/mcp/http.ts` (transport and auth) |
| authentication (OAuth 2.1 AS, credentials) | `src/lib/integrations/{oauth,credentials,origin}.ts`, `src/app/.well-known/*`, `src/app/api/oauth/*`, `src/app/oauth/authorize/page.ts` |
| permissions and approvals | `src/lib/integrations/{grants,proposals}.ts` |
| write path | `src/lib/integrations/writer.ts` (through `SyncService.push`) |
| project context and notes | `src/lib/integrations/project-context.ts` |
| activity (audit) | `src/lib/integrations/activity.ts` |
| persistence | `src/lib/integrations/{records,store,store-postgres}.ts`, `schema.sql` |
| setup and platform registry | `src/lib/integrations/{platforms,setup}.ts` |
| the person's side | `src/lib/integrations/{service,routes}.ts`, `src/app/api/integrations/*`, `src/components/settings/sections/ai-integrations-section.tsx`, `src/hooks/use-integrations.ts` |

### Reuse, not reimplementation

| Tool | Runs on |
| --- | --- |
| `search_workspace` | `searchWorkspaceTabs` (session-context/insight), the same ranking an agent session's `search_tabs` uses |
| `get_resource`, `get_workspace`, `get_tabs`, `get_collection` | the Phase E context resolver (`resolveContext`): URL redaction, bounds, notes off by default |
| `list_collections` | the synced collection model, hydrated by the client's own `applyChanges` |
| `create_collection`, `add_resource_to_collection` | `createCollection` / `applyCollectionBatch` (src/lib/collections), the workspace view's reducers |
| `propose_organization` | `validateWorkspacePlan` (J.5), drafting from `analyzeTopics` + `recommendPlacement` (J.6) |
| `apply_organization` | revalidation with `validateWorkspacePlan` + `planEffect`, `applyCollectionBatch`, one `SyncService.push`, then `verifyWorkspacePlan` |

The write path is the sync engine's own. An AI client changes the account
copy exactly as a second device would: whole-entity payloads, validated by
`validateCollectionPayload` and pushed against the cursor read *before*
hydrating, in the repository's transaction under the workspace row lock. The
person's devices receive the change through their ordinary pull. If a device
holds an unpushed edit to the same collection, the result is the existing
visible conflict with both versions kept. A `stale-base` refusal makes the
writer re-read and re-decide, up to three times. Nothing writes browser
storage.

---

## 2. Tools

Read tools, available to every grant:

| Tool | What it returns |
| --- | --- |
| `get_connection_info` | Opaque account reference, client, permission, granted workspaces. Used by the connection test. |
| `list_workspaces` | Granted synced workspaces. |
| `get_workspace` | Overview of one workspace (resolver-bounded). |
| `list_collections` | Paged collections, unfiled count, `workspaceVersion`. |
| `get_collection`, `get_tabs`, `get_tab_graph` | As before, workspace-scoped by the grant. |
| `search_workspace` | Saved tabs matching every query word, optionally filtered by `collectionId`, `domain` or `unfiledOnly`; across granted workspaces (up to 10) when none is named; paged (`offset`/`nextOffset`, up to 225 ranked); plus matching saved notes. |
| `get_resource` | One saved tab: redacted URL, site, collection, related tabs, optional note, and an explicit statement that extracted text is not available. |
| `get_project_context` | Saved goal, summary, decisions, tasks, linked resources and notes, each with who saved it, plus `notSaved`. |
| `get_recent_activity` | Bounded audit history for granted workspaces and this connection. |

Write tools, registered only for a grant holding `hubble.write`, and
re-checked against the grant when called:

| Tool | Behaviour |
| --- | --- |
| `save_workspace_note` | Adds a note (optionally attached to a collection). Identical content is not duplicated. |
| `create_collection` | Creates a collection, optionally with resources (which move from their old collection). An existing collection with the same name is returned rather than duplicated. |
| `add_resource_to_collection` | Adds resources and reports where they moved from. Ones already there are left alone. |
| `propose_organization` | Records a pending proposal (client operations, or drafted by Hubble's topic analysis). Changes nothing. |
| `apply_organization` | Applies a proposal **only once the person approved it in Hubble**. Revalidates, applies all-or-nothing, verifies, and is idempotent. |
| `save_project_context` | Additive patch: goal, summary (replaced), decisions and tasks (added), task status, linked resources. `expectedRevision` prevents lost updates. |

Every mutation accepts an optional `idempotencyKey`. A retry with the same
key returns the first result, marked `repeated: true`, and a key reused for a
different tool is refused.

Not in this release, deliberately: deleting anything, running commands,
reading files, fetching URLs, renaming via a direct tool (renames go through
proposals), and reading extracted page text. Possible future extensions are
syncing extracted content (opt-in), a local desktop MCP surface, CIMD client
registration, ChatGPT's mTLS client identification, and undo for applied
proposals.

### Answers and errors

Each answer is JSON text, for clients that show text, and the same object as
`structuredContent`. Failures are `isError: true` with a fixed sentence and
`structuredContent.error.code`, one of `not_found`, `permission_denied`,
`invalid_argument`, `conflict`, `stale`, `unavailable`, `timeout` or
`too_large`. An ungranted workspace or another account's id is `not_found`,
identical to a nonexistent one. Tool calls time out after 25 s, and answers
are capped at 120 000 characters (each tool's own limits keep far below
that). The server is stateless JSON-mode Streamable HTTP: there are no
server-initiated streams, and cancellation of an in-flight call is not
supported (each call is a single short request).

The server's `instructions` stay protocol-first and under 2 KB
(`accountInstructions`), because Claude Code truncates longer instructions
(`docs/agent-connector-platform.md` §15.3.1).

---

## 3. Authentication

### OAuth 2.1 (MCP authorization specification, 2025-11-25)

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/api/mcp` (and the root form) | RFC 9728 metadata: `resource` = `<origin>/api/mcp`, `authorization_servers` = `[<origin>]` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: S256 only, `authorization_code` and `refresh_token`, DCR, revocation, `iss` in responses |
| `POST /api/oauth/register` | RFC 7591 Dynamic Client Registration: HTTPS or loopback redirect URIs only, public (`none`) or confidential clients |
| `GET /oauth/authorize` | The consent page. The person signs in, chooses the permission (Read only by default) and workspaces (none preselected unless there is exactly one), and approves or denies. |
| `POST /api/oauth/token` | Code + PKCE verifier → access token (`hbat_`, 1 h, audience-bound) + refresh token (`hbrt_`, 30 d, rotated on every use) |
| `POST /api/oauth/revoke` | RFC 7009. Revoking a refresh token ends the connection. |

The rules enforced:

- PKCE S256 is required.
- Redirect URIs must match exactly, except that loopback redirects may use
  any port (RFC 8252 §7.3, for CLI callbacks such as the Gemini CLI's
  `http://localhost:7777/oauth/callback`).
- An unverifiable client or redirect is never redirected to.
- A replayed authorization code revokes what it was exchanged for.
- A reused refresh token revokes the connection.
- A `resource` that is not this endpoint is refused with `invalid_target`.
- Access tokens are rejected on any other resource. A preview deployment and
  production are different issuers.

Unauthenticated MCP requests get `401` with
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp"`.
That header is how clients discover sign-in.

The consent page shows the client's self-declared name **and** the verified
redirect host, which is the fact Hubble actually checked. It is served
`X-Frame-Options: DENY` / `frame-ancestors 'none'` and is a `.ts` page, so
it is never in the desktop export.

Not implemented: Client ID Metadata Documents (supporting them means
fetching a URL the client names), ChatGPT's optional mTLS client
identification, and OIDC/UserInfo.

### Personal tokens

`hbpat_` tokens are minted in Settings → AI Integrations for a chosen
client, permission and set of workspaces. They are shown once, stored as
SHA-256, expire after 90 days, and are revocable. Older `tdmcp_` Claude
Desktop tokens keep working, read-only across every synced workspace as
before, and are listed under "Older Claude Desktop tokens" for revocation.

### Where secrets live

Every token, code and client secret is 256 bits of CSPRNG output behind a
fixed prefix, stored only as a SHA-256 hash. The schema's CHECK constraints
refuse anything else. Nothing is stored client-side. A freshly minted
personal token lives in React memory until "Done". There is no
deployment-wide credential: every request resolves to one person's grant.

---

## 4. Permissions and security

**The grant** (`IntegrationGrant`) is established once per request from the
credential, and every tool consults it.

- **Workspaces:** an explicit list per connection, never "all" (except
  legacy read-only tokens, which have always seen the whole account).
  Ungranted is answered exactly like nonexistent.
- **Scopes:** `hubble.read` always; `hubble.write` only when the person chose
  "Read and save". A client's requested `scope` only preselects the consent
  control.
- Scopes and workspaces live on the connection, not the token, so narrowing
  or revoking in Hubble applies to the **next request**, including calls on
  an access token minted a minute earlier.
- No tool takes a user, scope, permission, path, command or URL argument.
  This is pinned by `src/lib/mcp/security.test.ts`.

**Approvals.** Additive changes (notes, context, new collections, adding to
a collection) apply directly under `hubble.write`, after whatever
confirmation the client itself shows. ChatGPT and Gemini confirm write
actions by default; Claude asks unless the person allowed the tool.
Reorganizations go through `propose_organization` → **the person approves in
Hubble** → `apply_organization`. Only `POST /api/integrations/proposals`
(Hubble's own origin, session cookie, JSON) can approve. No MCP module can
reach it, which `src/lib/integrations/security.test.ts` asserts. Before
applying, Hubble revalidates against the current workspace and applies only
if the plan would still do exactly what was approved.

**Untrusted content.** Saved titles, URLs, notes and resource text are data.
The instructions and every resource answer say so. Nothing a document says
can change a grant, approve a proposal or reach a privileged path, because
those are structural, not instructions. The integration test plants a page
that claims to be an approval and shows that nothing changes.

**Rate limits.** 120 MCP requests per credential per minute. Per IP: 30
registrations, 600 token requests and 60 consent submissions per 10 minutes.
The limits are in-memory and per instance, which bounds abuse but is not a
global quota.

**Origin checks.** `/api/mcp` refuses a foreign browser `Origin` and never
reads the session cookie. The OAuth endpoints an AI client calls read no
cookie at all.

---

## 5. Activity, privacy and what is stored

`hubble_integration_activity` records every tool call: time, client,
connection, actor (AI client, the person, or Hubble's connection test),
kind (`read`, `write`, `proposal`, `approval`, `decline`, `apply`,
`connection`), operation, workspace, target ids, outcome (`ok`, `denied`,
`failed`, `pending`, `partial`), error category, and one fixed-template
detail line (at most 160 characters, whose only free text is a collection or
workspace name). It never stores queries, resource text, note bodies,
prompts, conversations or tokens. Records are kept for 90 days.

**What is sent to the AI provider:** whatever a tool answers — titles,
redacted URLs, collection names, saved context and notes — from the
workspaces granted. It is handled under that provider's terms.

**What Hubble stores for integrations:** connections and hashed
credentials, registered OAuth clients, proposals, saved project context and
notes (only what someone explicitly asked to save), the audit log, and
idempotency results.

**What is never moved:** device-local workspaces, the workspace brief and
extracted content. Nothing is uploaded implicitly; syncing a workspace stays
the person's explicit action.

**Disconnecting:** Settings → AI Integrations → Disconnect. Access ends on
the client's next request. Saved notes and context stay until the person
deletes them there.

Hubble cannot read conversations held in another provider. Continuity
across clients is exactly what was saved to Hubble.

---

## 6. Platform setup (verified 2026-10-12)

Each row is in `platforms.ts`, with the source page. No row claims a test in
the vendor's product: every path has been exercised with the official MCP
SDK client over the real HTTP and OAuth wire format, not by connecting the
vendor's app (see §9).

### ChatGPT (developer mode)

- **Plans:** Plus, Pro, Business, Enterprise and Edu, on the web only. Free
  accounts cannot add a custom MCP app. Business, Enterprise and Edu admins
  may need to allow developer mode.
- **Setup:** Settings → Apps → Advanced settings → Developer mode. Create an
  app with the MCP server URL `https://<host>/api/mcp`, choose OAuth, and
  approve on Hubble's consent page.
- **Notes:** ChatGPT registers itself by DCR and sends `resource=`. Its
  redirect is `https://chatgpt.com/connector/oauth/{callback_id}`. Write
  actions are confirmed in ChatGPT by default. Refresh the app after Hubble
  adds tools.

### Claude (custom connectors: claude.ai, Desktop and mobile)

- **Plans:** Free (one custom connector), Pro, Max, Team and Enterprise. On
  Team and Enterprise, an owner adds the connector.
- **Setup:** Settings → Connectors → Add custom connector. Paste the URL,
  choose **Register automatically** under OAuth client (Hubble does not
  accept Claude's published CIMD identity), then press Connect.
- **Notes:** authentication settings cannot be changed after adding the
  connector; remove it and re-add. This is separate from Claude Desktop's
  local config file.

### Claude Code

```bash
claude mcp add --transport http hubble https://<host>/api/mcp --header "Authorization: Bearer hbpat_…"
```

Alternatively, omit the header and authenticate with OAuth from `/mcp`.

### Claude Desktop local config (legacy path)

Use the stdio bridge with a personal token (snippet in Settings). The custom
connector above is preferred: it needs no repository, token or config file.

### Gemini app (gemini.google.com custom apps)

- **Eligibility:** 18+, in the US, a personal Google account (not work or
  school), Keep Activity on, English only.
- **Setup:** Settings → Connected Apps → Custom apps → add the URL. DCR means
  nothing else is needed.
- **Notes:** Gemini manually confirms every write action. Gemini Business and
  Enterprise use an admin-managed setup that has not been tested.

### Gemini CLI

```bash
gemini mcp add --transport http hubble https://<host>/api/mcp --header "Authorization: Bearer hbpat_…"
```

Or use `httpUrl` + `headers` in `~/.gemini/settings.json`, or OAuth via
`/mcp auth hubble`. OAuth needs a local browser, so use a token over SSH.
Do not set `trust: true`.

### Google Antigravity

`mcp_config.json` with `serverUrl` (not `url`) and an `Authorization` header.

### Grok (grok.com custom connectors)

- **Setup:** grok.com/connectors → New Connector → Custom → paste the URL,
  then authorize on Hubble.
- **Notes:** reports indicate Grok's custom-connector auth is OAuth with
  PKCE and DCR only, with no way to paste a token. Hubble's OAuth fits that.
  Plan availability is described inconsistently (xAI's documentation says
  all users; reports say paid plans). Business and Enterprise need an admin
  to provision the connector first.

### xAI API (Remote MCP tools)

Add `{"type": "mcp", "server_url": …, "server_label": "hubble",
"authorization": "hbpat_…", "allowed_tools": [read tools]}` to a Responses
API request (snippet in Settings). xAI's Responses API does not support
`require_approval`, so keep `allowed_tools` to read tools unless your code
should write.

---

## 7. Deployment

```bash
npm run migrate:auth
```

```bash
npm run migrate:sync
```

```bash
npm run migrate:integrations
```

- **Environment:** no new variable. The integration store uses the existing
  `POSTGRES_URL` / `DATABASE_URL`. Accounts need the existing Google sign-in
  configuration (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`).
- **Order:** `migrate:integrations` depends on `tabdump_users`. It is
  additive and idempotent.
- **OAuth callback configuration:** none on Hubble's side. Clients register
  their own redirect URIs by DCR. Hubble is the authorization server, so
  there is no third-party OAuth app to configure.
- **Without the migration**, `/api/mcp` keeps serving legacy read-only
  tokens, and every OAuth and integration route answers 503.
- **Desktop:** every new server surface is a `route.ts`, or the `.ts`
  consent page, so `npm run desktop:export` is unaffected. The desktop app's
  AI Integrations pane points to the web app.

## 8. Development

```bash
npm run dev
```

The Inspector command for testing a personal token:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/api/mcp --transport http --header "Authorization: Bearer hbpat_…" --method tools/list
```

Local OAuth with a real client needs a signed-in session (Google client ID)
and a Postgres database. The test suites below need neither.

## 9. Testing and verification status

| Suite | What it covers |
| --- | --- |
| `src/lib/mcp/integration.test.ts` | Official SDK client over the real handler: negotiation, discovery by scope, isolation (another account's ids on every tool), forged ids, read-only refusal, live narrowing, prompt-injection, writes through sync with stale-base retry, idempotency, notes, project context across connections, proposal lifecycle, revalidation, audit content, no secrets in answers, legacy tokens, rate limiting, 401 metadata |
| `src/lib/integrations/oauth.test.ts` | Metadata, DCR, redirect rules, consent validation, PKCE, code replay, refresh rotation and reuse, confidential clients, revocation, and **a full discover → DCR → PKCE → token → MCP → refresh flow driven by the MCP SDK's own OAuth client** |
| `src/lib/integrations/service.test.ts` | Connection status, token connections, ownership, the real connection test, project-context rules |
| `src/lib/integrations/integrations.pg.test.ts` | Real PostgreSQL: schema constraints, concurrent code redemption, refresh rotation, a write landing in the pulled account copy, concurrent applies |
| `src/lib/integrations/security.test.ts`, `src/lib/mcp/security.test.ts` | Structural guards |
| `ai-integrations-section.test.tsx`, `oauth-consent.test.tsx` | Every connection state, setup snippets, token shown once, test, disconnect, approve, consent defaults and deny |

**Not yet verified:** a connection from the vendors' own products (ChatGPT,
claude.ai, the Gemini app, grok.com, the Gemini CLI, Claude Code,
Antigravity, the xAI API). That needs this branch deployed and a person
signed in to each product, and the settings pane says so for every row. The
verification checklist for each product:

1. Add the connector.
2. Complete consent.
3. Run Settings → Test connection.
4. Ask the product to list workspaces.
5. Ask it to save a note and confirm it appears in Settings.
6. Narrow the connection to read-only and confirm the next save is refused.
7. Disconnect, and confirm the next call fails.

Record the result by setting `verification: "client"` in `platforms.ts`.

## 10. Troubleshooting

| Symptom | Cause |
| --- | --- |
| The client says it cannot connect, or asks for OAuth again | The access token expired and refresh failed. Reconnect from the client. "Authentication expired" in Settings means no live credential remains. |
| "Setup incomplete" | Hubble has never received a call on that connection. Finish setup in the client, then ask it something. |
| No workspaces listed | None of the granted workspaces is synced, or none was granted. Sync it, then use Change access. |
| Saves refused | The connection is Read only. Use Change access → Read and save. |
| A proposal never applies | It is waiting for approval in Settings → AI Integrations, or it expired after 24 h, or the workspace changed so it no longer matches what was approved. |
| `invalid_target` during sign-in | The client asked for a resource other than this deployment's `/api/mcp`. Use the exact URL shown in Settings. |
| 429 | More than 120 requests per minute on one credential. |
