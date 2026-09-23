# Claude Desktop ↔ TabDump (MCP)

TabDump is an MCP server. Claude Desktop can connect to it and **read** your
TabDump context — synced workspaces, tabs, collections, tab relationships, and
the status of your TabDump remote agent projects. It cannot change anything in
TabDump, and it cannot run anything.

---

## 1. Architecture

```
Claude Desktop ──stdio──▶ scripts/tabdump-mcp-bridge.mjs ──HTTPS──▶ TabDump /api/mcp
  (MCP client)             (relay, official SDK only)              (MCP server, stateless
                                                                    Streamable HTTP)
                                                                         │
                                               bearer token ─▶ account ─┤
                                                                         ▼
                                              SyncService.pull ▶ applyChanges ▶ resolveContext
                                              (owner-scoped)    (client's own)  (Phase E bridge)
```

**The server is remote**, on the TabDump deployment, because that is where the
data is. TabDump is local-first: a signed-out user's workspaces live in one
browser and no server has them. A signed-in user's workspaces are synced to the
deployment's Postgres, keyed by account. That account copy is exactly — and
only — what the MCP server reads.

**The bridge exists because of Claude Desktop, not TabDump.**
`claude_desktop_config.json` launches local stdio servers. Claude Desktop's
native remote connectors (Settings → Connectors → Add custom connector)
authenticate with OAuth, which TabDump does not yet implement (§7). The bridge
relays JSON-RPC between the two transports unchanged; it has no tools and no
logic that could widen what the server allows.

**It is not a second control plane.** The MCP layer (`src/lib/mcp/`) imports
nothing from the agent control plane, the runtime host, the remote sandbox
service or the credential store. There is no tool that starts, steers,
approves or stops an agent. `src/lib/mcp/security.test.ts` asserts all of it.

## 2. Tools and resources

| Tool | Reads |
| --- | --- |
| `list_workspaces` | Your workspaces (id, name, last update). |
| `get_workspace` | One workspace: the workspace, its collections and up to `maxTabs` (≤ 100) tabs. |
| `get_tabs` | Specific tabs by id (≤ 50). Notes only with `includeNotes: true`. |
| `get_collection` | One collection and its member tabs. |
| `get_tab_graph` | A tab's dependencies and graph neighbours, depth ≤ 2. |
| `list_agent_projects` | Your TabDump remote agent projects: name, status, granted permissions. |
| `list_agent_sessions` | Your remote agent sessions' status. Cannot start, stop or message one. |

Resource template: `tabdump://workspace/{workspaceId}` — the `get_workspace`
overview, attachable in Claude Desktop.

Every tool is annotated `readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: false`. The list is pinned by test.

Workspace tools are thin wrappers over the Phase E context resolver
(`src/lib/agents/context/resolve.ts`), so they inherit its rules unchanged:

- **URLs are redacted** — credentials in the URL removed, the fragment always
  dropped (implicit OAuth returns `#access_token=`), secret-looking query
  values replaced with `[redacted]`.
- **Notes are off** unless a call asks for them.
- **Everything is bounded**, and anything cut is reported in `omissions`.
- **No project roots**: the resolver runs with `localRuntimeAllowed: false`.

Never exposed: sandbox names, process ids, provider session ids, internal
owner ids, tokens, credentials.

## 3. Authentication

TabDump issues its own **MCP access tokens** (`tdmcp_…`):

- minted by a **signed-in** TabDump user in Settings, bound to that account;
- **read-only** — the scope list has one member, and the database refuses any
  other (`CHECK (scopes <@ ARRAY['read'])`);
- stored only as a **SHA-256 hash** — the database refuses a value that is not
  64 hex characters, so a plaintext token cannot be stored by mistake;
- shown **once**, at creation, never returned again;
- **expire** after 90 days; **revocable** at any time; at most 10 live per account;
- deleted with the account (`ON DELETE CASCADE`).

What authenticates `/api/mcp` is the `Authorization: Bearer` header and nothing
else. **The TabDump session cookie is never read there**, so a browser holding
a session gains nothing, and a cross-site page cannot attach a header it does
not know. A request with a foreign browser `Origin` is refused.

Not used, anywhere on this path: an `ANTHROPIC_API_KEY`, a user's Anthropic
key, a Claude.ai or Claude Desktop login. TabDump never sees Claude Desktop's
credentials and Claude Desktop never sees TabDump's session.

## 4. Deploying (operator, once)

```bash
npm run migrate:mcp
```

Creates `tabdump_mcp_tokens`. Additive and idempotent. Needs the auth and sync
schemas already applied (`migrate:auth`, `migrate:sync`). No new environment
variable is required: MCP uses the deployment's existing `POSTGRES_URL`.

The desktop (Tauri) build is unaffected: like every `route.ts`, `/api/mcp` is
absent from the static export.

## 5. Connecting Claude Desktop (each user)

1. **Sign in** to TabDump, and make sure the workspaces you want are synced.
2. **Settings → AI connectors → Use TabDump from Claude → Connect Claude
   Desktop.** Copy the config it shows — the token is displayed once.
3. **Get the bridge.** It is `scripts/tabdump-mcp-bridge.mjs` in this
   repository, and it needs the repository's `node_modules`
   (`npm install`). Node 18+.
4. **Open Claude Desktop's config**: Claude Desktop → Settings → Developer →
   Edit Config. The file is:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
5. **Add the `tabdump` entry** under `mcpServers` (merge it with any servers
   already there):

   ```json
   {
     "mcpServers": {
       "tabdump": {
         "command": "node",
         "args": ["/absolute/path/to/tabs/scripts/tabdump-mcp-bridge.mjs"],
         "env": {
           "TABDUMP_MCP_TOKEN": "tdmcp_…",
           "TABDUMP_MCP_URL": "https://tabsdump.vercel.app/api/mcp"
         }
       }
     }
   }
   ```

   On Windows, use forward slashes or doubled backslashes in the path, e.g.
   `"C:/Users/you/tabs/scripts/tabdump-mcp-bridge.mjs"`.

6. **Quit and reopen Claude Desktop.** TabDump appears under the tools menu
   in a new chat. Its log is `mcp-server-tabdump.log` in Claude Desktop's
   logs folder (Windows: `%APPDATA%\Claude\logs\`; macOS:
   `~/Library/Logs/Claude/`). The bridge writes one line on start
   (`Relaying to …`) and never writes the token.

To disconnect: revoke the connection in TabDump Settings (takes effect on the
next request) and remove the entry from the config.

## 6. Verifying without Claude Desktop

The official MCP Inspector reads the same config format:

```bash
npx @modelcontextprotocol/inspector --cli --config claude_desktop_config.json --server tabdump --method tools/list
```

## 7. Limitations

- **Account-synced data only.** A signed-out user, or a workspace that has
  never synced, is invisible to MCP — there is nothing on the server to read.
- **No native Claude Desktop connector yet.** "Add custom connector" needs
  OAuth 2.1 (the MCP authorization spec: protected-resource metadata, an
  authorization server, PKCE). That would remove the bridge and the pasted
  token, and is the natural next step. The token model here is designed to be
  the resource-server half of it.
- **The bridge needs this repository** (it resolves the MCP SDK from
  `node_modules`). Publishing it as a package is a distribution task, not a
  security one.
- **Read-only.** No tool writes, and none will be added without its own
  permission design — the agent control plane's approval model does not
  extend to an MCP client, and must not be bypassed through one.
- **Stateless.** No server-initiated notifications; each request is
  authenticated and answered on its own.
