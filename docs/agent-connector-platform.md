# The Agent Connector Platform (Phases J, J.1, J.2, J.3)

TabDump connects external AI agents through **one** connector framework.
Claude Code, Gemini CLI, Grok Build, Codex and any MCP-compatible agent are
each a registry entry plus, where TabDump drives the agent, a server-side
control adapter. None of them has its own integration architecture, its own
session model, its own approval system or its own chat.

```
Command Centre ─ Connect Agent: choose → detect → sign in → approve → connected
               ─ Agents roster · New session · Agent chat · inline approvals
        │
        ▼  lib/agents/platform/          (browser, pure)
  registry (catalog.ts) · lifecycle · roster · chat
  AgentPlatformConnector ── ONE implementation over the typed runtime client
        │  closed protocol verbs: detect/connect/authenticate/disconnect_provider,
        ▼  create_session, send_message, respond_to_approval, …
  RuntimeHost ── ControlService (gate, broker, permissions, approvals)
        │   └─ session context: registry + loopback MCP server (J.3, §12)
        │
        ├── Claude adapter  ── Claude Agent SDK (canUseTool)
        └── ACP adapter     ── ONE adapter, JSON-RPC over stdio
                 │   Gemini CLI · Grok Build · Codex (reach + sign-in only)
                 ▼
        lib/agents/launch/  (server-only) allowlist · resolve · detect · env · spawn
        │
   where the runtime runs:
     web (local/self-hosted)   Next route /api/agents/control
     desktop (packaged app)    Tauri → Node sidecar → the same RuntimeHost (J.1)
```

The observation plane (`AgentConnector`, `connectors/**`) is untouched and
still cannot act. The lifecycle interface is deliberately named
`AgentPlatformConnector` so the two can never be confused in an import.

## 1. The provider registry

`src/lib/agents/platform/catalog.ts` is the only provider-aware module the UI
reads. An entry says how a person connects an agent:

| Field | Meaning |
| --- | --- |
| `transport` | `sdk` (Claude), `acp` (Gemini, Grok, Codex) or `mcp` (custom: the agent connects to TabDump) |
| `signIn` | `native` (the agent's own login, started through the protocol), `provider-key` (Claude on the web, BYOC) or `mcp-token` |
| `sessions` | `{available: true}` or `{available: false, reason}` — mirrors the server's approval policy, see §5 |
| `surfaces` / `unavailableOn` | where it can work (`web`, `desktop`) and the sentence for where it cannot |
| `features` | what TabDump does with it once connected, shown on the Approve step |
| `explainer` | exactly what connecting it means, for a connector the user wires up themselves |
| `installCommand` | text for the user to run; TabDump never runs it; always a package manager, never a piped script |

| Provider | Transport | Signs in with | Desktop | Sessions |
| --- | --- | --- | --- | --- |
| Claude Code | Agent SDK | Claude Code's own login (desktop) / the user's own key (web) | yes | yes |
| Gemini CLI | ACP (`gemini --acp --approval-mode default`) | Google login, run by Gemini CLI | yes | yes |
| Grok Build | ACP (`grok agent --no-leader stdio`) | Grok login, run by Grok Build | yes | yes |
| Codex | ACP (`codex-acp`) | ChatGPT login, run by codex-acp | yes | **no** — see §5 |
| Custom MCP agent | MCP (TabDump is the server) | a TabDump MCP token issued in Settings | no — see §8 | none (it is the client) |

The registry is not the last word: the runtime reports what is installed,
whether the agent is signed in and what its adapter declares, and the
lifecycle believes the runtime wherever they differ.
`platform/registry.test.ts` holds the registry to the launch allowlist (same
providers, same session refusals in the same words), to the MCP server's real
tool list, and asserts that no command-centre component branches on a
provider id.

## 2. The connector lifecycle

`platform/lifecycle.ts` derives one phase per provider from independent
reports — the machine (`detect_providers`), the runtime (status, and
connect/sign-in replies) and the roster (approval). Nothing stores
"connected":

```
runtime_unavailable → not_installed → needs_adapter → detected
  → connecting → sign_in_required | unverified → authenticating
  → awaiting_approval → connected ⇄ disconnected           (+ error, unknown)
```

| What the user sees | Phase / source |
| --- | --- |
| Not installed | `not_installed` (detection) |
| Installed but signed out | `sign_in_required` — the **agent's own** answer to connect |
| Authenticating | `authenticating` — the agent's sign-in page is open |
| Connected | `connected` — reached this runtime **and** said it is signed in **and** approved |
| Session unavailable | the registry's `sessions` / no `create_session` declared — shown before sign-in |
| Session active | the roster's live activity from the newest session |
| Disconnected | `disconnected` — approved, but not reached by this runtime yet |
| Error | `error`, plus runtime error sentences |

"Connected" is never derived from process reachability alone: a reached agent
that says it is signed out is "Sign-in required" everywhere, including the
Command Centre's side panel (`providerRowState`).

`phaseSentence` turns a phase into the one sentence the UI shows, the same for
every provider: "Codex is not installed.", "Gemini CLI is installed but not
authenticated.", "Grok Build is unavailable on this runtime. …",
"Authentication could not be verified.", "Agent disconnected unexpectedly."
(a session event). No sentence carries a path, a command line or anything an
agent printed; diagnostics stay in the sidecar's opt-in developer log.

The Connect Agent steps (`detect → sign in → approve → done`) are a table over
those phases, so reopening the dialog lands where the agent really is.
Disconnect is offered on every step for an agent already in the roster.

An agent whose sessions are unavailable (Codex) says so in the agent list and
on the Detect and Sign in steps, and the flow stops there: its real state is
still asked for and shown, but it offers no sign-in, no Continue and no
approval — nobody is asked to sign in to an agent that cannot start a session.
Should a future Codex adapter offer a mode that asks before every edit and
command, enabling it is one launch-table entry (`approval: asking-mode`) and
the registry's `sessions`; nothing else changes.

## 3. Authentication, from the provider

TabDump never decides that an agent is signed in. Phase J.2 removed the last
place that did (sign-in *marker files* in detection). Every answer comes from
the agent itself, through the runtime:

| Agent | How TabDump asks | How the user signs in |
| --- | --- | --- |
| ACP agents | `session/new` on a probe connection in an empty scratch directory: `-32000` = sign-in required, a session = signed in, anything else = `unknown` | ACP `authenticate` with a method id the agent advertised; the agent opens its own sign-in page |
| Claude (desktop) | `claude auth status --json` → the single `loggedIn` boolean | `claude auth login --claudeai` / `--console` from the allowlist |
| Claude (web) | the user's stored provider key (BYOC) | Settings → AI connectors |

Details that matter:

- The probe connection refuses every request from the agent and never sends
  a prompt, so nothing can run on it. A probe session is closed
  (`session/close`) where the agent supports it; a signed-in probe connection
  is released at once; a signed-out one is kept for the sign-in.
- The agent is asked on every Connect, and once per runtime for each approved
  agent when the Command Centre opens, so "Connected" after a restart is the
  agent's answer today.
- After `authenticate` succeeds, the agent is asked again; the sign-in flow's
  own "done" is not trusted on its own.
- `unknown` is shown as **"Authentication could not be verified"** and is not
  allowed past the Sign in step.
- API-key methods the agents advertise (`gemini-api-key`, `vertex-ai`,
  `gateway`, codex `api-key`) are filtered out: agents run with an allowlisted
  environment that carries no key, so those methods can never succeed.
- Credentials never enter TabDump. There is no protocol field for one; the
  roster (`tabdump:agent-roster:v1`) holds identity and consent only and its
  guard fails the build on a credential-shaped field.

## 4. Sessions and chat — one model

Once connected, every provider uses the same `create_session → send_message →
get_events → respond_to_approval → dispose_session` verbs, the same
`RuntimeSessionView`, the same event stream and the same chat
(`platform/chat.ts`): deltas sharing a `messageId` render joined and marked
streaming, then are replaced by the whole reply. ACP agents stream; Claude
over the SDK delivers each reply whole. A session carries the `workspaceId` it
was started for and the `projectId` it runs in; the transcript is rendered as
plain text, never HTML.

A session is started only for an agent in the roster, on a project whose
grant does not exceed what the agent was approved for, and only if the
provider's adapter declares `create_session`.

**Cleanup (fixed in J.2).** `dispose_session` and `disconnect_provider` now
end an ACP session's process through the adapter's `releaseSession`
extension (`control/session-release.ts`). Previously they cancelled the run
and forgot the session while the agent process lived on until the runtime
shut down.

## 5. The approval model — TabDump approves, or there is no session

```
Agent → session/request_permission | canUseTool → ControlService broker → Approval UI
User: Approve → broker → adapter → the agent's own ONE-TIME option → action
```

Unchanged from Phase J, and applied identically to every provider:

- A tool outside the project's grant is refused before anyone is asked.
- The answer is always the agent's one-time option, never "always".
- `switch_mode` tool calls are always refused.
- A privileged tool that *starts* without a TabDump approval cancels the
  turn and fails the session.

That last rule catches an agent *after* it acted. Phase J.2 adds the rule
that keeps it from getting there — **modes**:

| Agent | Asking mode(s) (verified from the agent's source) | Pinned on launch |
| --- | --- | --- |
| Gemini CLI 0.61.0 | `default` ("Prompts for approval"); others: `autoEdit`, `yolo`, `plan` | `--approval-mode default` — the CLI flag overrides a user's `yolo`/`auto_edit` setting |
| Grok Build 1.0.41 | `ask`, then `default` ("currently equivalent to Ask"); others: `auto` (a classifier approves unasked), always-approve | `--no-leader` — see §7 |
| codex-acp 1.13.1 | **none** | — |

- A session starts only in an asking mode: already in one, or switched to
  the first the agent offers. An agent that offers none, reports no modes, or
  refuses the switch is refused with `approval_unenforceable` ("Agent would
  not ask before acting").
- A `current_mode_update` out of the asking modes mid-session stops the
  session at once ("The agent switched to a mode where it approves its own
  actions, so TabDump stopped it.").
- **Codex cannot be held to this.** In codex-acp every mode runs Codex with a
  `workspace-write` sandbox or none; its mode named `read-only` ("Ask for
  approval") is on-request approval *inside a writable workspace* — Codex
  edits project files and runs sandboxed commands without asking, and the
  mode is re-sent on every turn so no launch option or config narrows it.
  Per the brief ("stop and report rather than weaken"), the launch entry
  declares `approval: unavailable`; the ACP adapter then declares **no**
  capabilities for Codex, so the service refuses its sessions with no
  provider-specific check, and the adapter itself refuses before launching
  anything. Codex can still be detected, reached and signed in to; the UI
  says plainly that TabDump will not start sessions with it, and why.

## 6. Workspace scoping

The workspace chosen at session start is recorded on the session and is the
only one it can ever see. Since Phase J.3 the agent *queries* it through the
session's own TabDump MCP server (§12) — bound to that session and that
workspace, enforced by the server, and revoked when the session ends. The
Phase E attached-context bridge (the `<tabdump-context>` block) still exists
for a user who wants to hand the agent a specific selection. Projects are named
by id and revalidated by the host and again by the launcher before `spawn`;
tool locations outside the project are dropped from every event. No provider
gains access to another workspace.

The J.2 per-session MCP tokens (database rows, web only) are gone: they were
replaced by the runtime-owned, memory-only credentials of §12, which work in
the desktop app too.

## 7. Security boundaries

| Requirement | How it is met |
| --- | --- |
| No shell execution | `launch/allowlist.ts` is the whole list of programs and literal argv. `shell: false` always. Windows npm `.cmd` shims are followed to the allowlisted vendor package's own script (`@google/gemini-cli`, `@agentclientprotocol/codex-acp`, `@xai-official/grok`) and run with Node — never `cmd.exe`. |
| Fixed argument policy | Every `args` array is a literal pinned by `launch/security.test.ts`, which also forbids `yolo`/`always-approve`/`bypass`/`--leader` and pins `--approval-mode default` and `--no-leader`. |
| Stripped environment | `launch/env.ts` allowlist (home, temp, PATH) — no key, no token, no TabDump secret. The desktop shell strips again before the sidecar starts. |
| No credentials in TabDump | Provider logins stay in each agent's own store. The frontend never receives a token; the roster cannot hold one. |
| Explicit approval | §5. |
| Workspace boundaries | §6. |
| Process isolation | One process per ACP session, in the authorized project or a private scratch dir. Grok is pinned `--no-leader`: in leader mode (configurable in `config.toml`) a session would run in a shared background process outside TabDump's tree and working directory. |
| Windows Job Object cleanup | The desktop shell puts the sidecar — and so every agent it starts — in a `KILL_ON_JOB_CLOSE` job (Phase J.1). |
| Session-scoped MCP credentials | Minted per session by the runtime, memory only, hashed, bound to one session + one workspace + a capability set; revoked on session end, disconnect and shutdown; 12 h ceiling (§12). There is no global MCP token. |
| No arbitrary executables | No custom agent is ever launched; the registry has no field that could name a program (`registry.test.ts`). |

**Inside the agent, not TabDump:** codex-acp 1.13 on Windows starts its own
bundled `codex.exe` with `shell: true`. That is the agent's own process
management, below the boundary TabDump controls, and moot while Codex
sessions are refused.

## 8. Custom agents

A custom agent is an **MCP client the user runs themselves**. It connects to
TabDump's read-only MCP server (seven tools, every one annotated read-only:
list/read workspaces, tabs, collections, the tab graph, agent projects and
sessions) with a token issued in Settings → AI connectors, revocable there.
TabDump never starts it, runs nothing for it, and stores no credential of its.
The Connect dialog shows exactly that before anything is approved.

The phase comes from a real fact: whether a usable MCP token exists
(`useMcpTokens`). In the desktop app, which runs no MCP server, the custom
agent is shown as unavailable with the reason. Arbitrary executables or shell
commands cannot be entered anywhere: the only launchable agents are the
allowlist's, and a new one is added by a code change, below.

## 9. Adding a provider

A new agent is an implementation of the existing contract, never a new
architecture:

1. **Verify the agent** — its real invocation, sign-in methods, and, from its
   source, which session modes ask before *every* privileged action. Do not
   trust a mode's name (codex-acp's `read-only` writes).
2. **ACP agent:** add a `PROVIDER_LAUNCH_TABLE` entry — executable names,
   literal `args` (pin any flag that keeps it asking and inside the process
   tree), the vendor's npm package for the Windows shim, and `approval`
   (`asking-mode` with its mode ids, or `unavailable` with a reason). Both
   runtimes (`runtime/server.ts`, `runtime/desktop.ts`) pick it up.
   **Non-ACP agent:** write a control adapter against `AgentControlAdapter`
   (plus the `authentication`/`approval-details`/`session-release` extensions
   it genuinely has), and wire it where Claude's is.
3. **Registry:** add a `PLATFORM_PROVIDERS` entry — name, transport, sign-in,
   `sessions`, `surfaces`, `features`, install command (a package manager).
   Add the provider id to `AgentProviderId` and an icon.
4. **Tests:** extend `launch/security.test.ts` (the pinned table) and let
   `registry.test.ts` hold the two sides together; add the agent to
   `launch/integration.local.test.ts`.

Nothing in the Command Centre, the hook, the session model, the chat or the
approval system changes.

## 10. Phase J.2 verification (2026-09-24)

### Verified

| What | How | Result |
| --- | --- | --- |
| Claude desktop E2E | The desktop build's own sidecar bundle, run by the installed app's `tabdump-agent-node.exe` over the Rust shell's line protocol with its allowlisted environment; the user's real Claude Code login | PASS — connect, sign-in state, project + workspace session, real message, approval raised *before* the write, approved write, streamed reply, disconnect, every `claude.exe`/`bash.exe` child gone |
| ACP detection — Codex, Gemini, Grok | Same packaged runtime; and `launch/integration.local.test.ts` through the production launcher | PASS — all detected installed + launchable through the npm layout; no path in any answer |
| Authentication state from the provider | Same | PASS — each real agent reports **itself** signed out; only its own login is offered (`chat-gpt`, `oauth-personal`, `grok.com`) |
| Desktop runtime | Packaged runtime smoke test (24/24 ACP checks + the Claude session) | PASS |
| Process cleanup | Real child process (`launch/process.test.ts`): session released, agent disconnected, runtime shut down — each proven by the scratch directory disappearing, which Windows allows only after the process exits. Packaged runtime: no agent process left after disconnect. Rust `a_job_kills_its_processes_when_closed` | PASS |
| Approval enforcement | Real stdio approval round trips (granted/denied, one-time options only); an agent switching itself to `yolo` mid-session is stopped; Codex refused before launch | PASS |
| Workspace association | Sessions carry the chosen `workspaceId` and `projectId` (packaged Claude session; desktop-runtime tests) | PASS |
| Security guards | All 18 guard suites (377 tests) and the Rust shell tests (9 passed, 1 opt-in ignored) | PASS |

To re-run the real-agent checks:

```bash
npm install -g --prefix <short dir> @google/gemini-cli @agentclientprotocol/codex-acp @xai-official/grok
TABDUMP_ACP_AGENT_PREFIX=<short dir> npx vitest run src/lib/agents/launch/integration.local.test.ts
```

(On Windows keep `<short dir>` short — codex-acp's bundled `codex.exe` sits
deep in its package and past 260 characters Windows reports it missing. The
Grok package's install step also writes its binary to `~/.grok/bin`.)

### Provider limitations

- **Codex:** sessions are blocked pending an adapter mode that asks before
  every edit and command (§5). Detection, sign-in state and connection work.
- **Gemini:** a real account sign-in and an authenticated conversation were
  not tested (no Google account used). Also: Gemini advertises no
  `session/close`, so each Connect's sign-in probe leaves one empty chat record
  under `~/.gemini`.
- **Grok:** a real account sign-in and an authenticated conversation were not
  tested (no xAI account used). Its post-sign-in mode ids (`ask`/`default`)
  come from the binary's own strings, not an observed session; if they differ,
  the session is refused (`approval_unenforceable`) rather than guessed.

### Packaging limitation

Windows Smart App Control (enforcing on the development machine) blocks the
freshly built, **unsigned** installer and `tabdump.exe`, so the new shell was
not installed; the packaged runtime was tested as described above. Production
distribution requires Windows code signing. Nothing in TabDump works around it.

### Tests

Final full runs on the committed J.2 tree (Windows, `npx vitest run`):

| Run | Files | Tests | Notes |
| --- | --- | --- | --- |
| 1 | 358 passed · 5 skipped · **1 not started** | 5573 passed · 35 skipped · 0 failed | `src/lib/dependencies/validation.test.ts` never ran: "Failed to start forks worker … Timeout waiting for worker to respond" — an environment failure. Alone: 4/4 pass. |
| 2 | 358 passed · 5 skipped · 1 failed (364) | **5576 passed · 35 skipped · 1 failed** (5612) | `src/lib/sync/migration.pg.test.ts` hit the default 5 s test timeout against real PostgreSQL under full-suite load. Alone: 6/6 pass. |

- **J.2 regressions:** none. Neither file is touched by J.2.
- **Environment:** the worker-start timeout (run 1).
- **Flaky under load:** `migration.pg.test.ts` (run 2) and, earlier in the phase,
  `src/hooks/extension-dump-pipeline.test.tsx`, which also failed on the untouched
  J.1 tree in one of two runs on the same 5 s timeout. Each contended run times
  out a different untouched file; none has been made to pass by loosening
  timeouts.
- **Pre-existing failures:** none found.

Also: typecheck and lint pass; the 18 security guard suites (377 tests) pass;
the Rust shell tests pass (9 passed, 1 opt-in ignored).

## 11. Limitations

- **Codex sessions** are refused until an adapter offers a mode that asks
  before every edit and command (or TabDump grows a `codex app-server`
  adapter, whose approvals are real — a separate phase).
- **User-configured allow rules inside an agent** (Gemini policy files,
  Grok allow rules) can let a tool run without asking even in an asking mode.
  TabDump stops that session when the tool starts; the action itself may
  already have happened. Not preventable from outside the agent.
- **Custom agents** do not work in the desktop app (no MCP server there).
- **Resume:** ACP sessions do not declare `resume_session`; a restart ends them.
- **Remote runtime:** only Claude runs in the sandbox; ACP agents are local.
- **Unsigned desktop builds** are blocked by Smart App Control where it is
  enforcing (above).
- **Session context** — see §12.8.

## 12. Session Context Architecture (Phase J.3)

An agent session started from a workspace can *query* that workspace — its
tabs, collections and relationships — through TabDump's MCP server, and can
*propose* one kind of change, which the user approves in TabDump. Nothing is
pasted into the prompt; the agent asks for what it needs.

```
 Command Centre (webview)                      Agent runtime (Node: sidecar / Next route)
 ───────────────────────                       ───────────────────────────────────────────
 New session ── create_session ─────────────▶  RuntimeHost
   { workspaceId, contextSnapshot }              │ access = sessionContextAccessFor(grant)   ← never the request
                                                 │ registry.bind(session, workspace, access, snapshot)
                                                 │   → tdctx_… (256-bit, returned once, SHA-256 kept)
                                                 ▼
                                               ControlService.startSession ─▶ adapter
                                                 Claude: mcpServers { tabdump: http, Bearer ${TABDUMP_CONTEXT_TOKEN} }
                                                         + TABDUMP_CONTEXT_TOKEN in the agent's env only
                                                 ACP:    session/new mcpServers [{ http, Authorization header }]
                                                              │
 view.context { workspaceId, name,                            ▼
   capabilities, pendingActions }     Agent ──HTTP──▶ 127.0.0.1:<random>/mcp  (session context server)
   — no credential field exists —                   bearer → binding (one session, one workspace)
                                                    tools registered per capability; any other workspace id → refused
 sync_session_context (own workspace only) ──▶      reads served from the bound snapshot (bounded, redacted)
                                                    create_collection ─▶ approval broker ─▶ Approval UI
 ApprovalPrompt ── respond_to_approval ─────▶        granted ─▶ view.context.pendingActions
 useSessionContext applies it (collection store)
   ── complete_context_action ──────────────▶        ─▶ tool call returns { created, collectionId }
```

### 12.1 Why the webview sends the workspace

TabDump's workspace lives in the app (local storage, synced to the account when
signed in). The desktop app has no server and no database, so the runtime
cannot read it. The webview therefore sends a **bounded snapshot of the
session's own workspace** with `create_session`, and re-sends it (debounced,
only when it changed) while the session lives. `readSessionContextSnapshot`
copies an allowlist of fields (no favicons, logos or anything else), caps it
(800 tabs, 200 collections, 2000 relationships, 500 notes, 600 KB) and refuses
a snapshot of any workspace other than the one named. The runtime refuses a
sync for any other workspace (`context_invalid`), so switching workspaces in
the UI never moves an agent.

### 12.2 The credential

| Property | How |
| --- | --- |
| Per session | `registry.bind` mints a 256-bit `tdctx_` token per session. The raw value is returned once, to the host, which hands it to the service, which hands it to the one adapter starting the agent. |
| Bound | Exactly one session, one workspace, one capability set — fixed at bind; `update` accepts only a fresher snapshot of the same workspace. |
| Not stored | Only its SHA-256 is kept, in the runtime's memory. Never persisted, never in a protocol message, event, log, URL or the webview. |
| Off the command line | Claude Code gets the header as the literal `Bearer ${TABDUMP_CONTEXT_TOKEN}`, which it expands from its own environment (the SDK puts `mcpServers` on argv). |
| Revoked | On a terminal session status (including an agent crash), `dispose_session`, `disconnect_provider` and runtime shutdown. A restarted runtime has an empty registry and a new port, so a pre-restart credential cannot work. |
| Expires | 12 h after bind (`CREDENTIAL_MAX_AGE_MS`), even for a session that never ends. It is forgotten, not paused. |

There is **no global MCP token**. The account-level tokens a custom MCP client
uses (§8) are a separate, web-only mechanism and cannot reach this server.

### 12.3 The server

`session-context/http.ts`: Node `http` on `127.0.0.1` with a random port,
started with the runtime (desktop and local web). It accepts only `POST /mcp`,
refuses **any** `Origin` header (no browser can call it), pins `Host` to
`127.0.0.1:<port>` (no DNS rebinding), caps bodies at 64 KiB, and answers
401 to a missing, malformed, unknown, revoked or expired credential. Each
request builds a fresh stateless MCP server that reads the binding *live*, so a
revocation takes effect on the very next call.

### 12.4 Capabilities

| Capability | Tools | Granted when |
| --- | --- | --- |
| `workspace.read` | `get_current_workspace`, `list_workspaces` (this one only), `get_workspace` | project grant has `read_workspace` |
| `tabs.read` | `get_tabs`, `search_tabs` | 〃 |
| `collections.read` | `get_collection` | 〃 |
| `relationships.read` | `get_tab_graph` | 〃 |
| `collections.write` | `create_collection` (asks every time) | grant also has `write_workspace` |

Access is derived by the host from the session's grant
(`sessionContextAccessFor`); the request cannot ask for more. Read never
implies write: a read-only session is not even shown `create_collection`, and
calling it anyway is refused before anyone is asked. `write_workspace` is a
new approval-required scope, off by default in Connect Agent ("asks every
time").

### 12.5 Writes go through the existing approval system

`create_collection` → the registry validates the name and that **every** tab
id belongs to the bound workspace (a request naming anything else is refused
without asking) → the host's approver calls
`ControlService.requestWorkspaceApproval` → the broker records an approval
with scope `write_workspace`, action `change_workspace` and a `workspaceId`
(the broker requires the workspace and no project for this scope) → the
Command Centre shows it as an ordinary approval ("Change your TabDump
workspace — in the TabDump workspace Launch Plan") → **approved**: the action
is listed on `view.context.pendingActions`; `useSessionContext` applies it
exactly once through the same collection store the workspace view uses and
reports `complete_context_action`; only then does the agent's tool call return
`{ created, collectionId }`. Denied, expired, or not applied within 60 s:
nothing is created and the agent is told so in a fixed sentence. A session
that ends answers its waiting write as ended.

### 12.6 Provider neutrality

The host, registry, server and approval path know nothing about providers.
Each adapter only translates `CreateSessionRequest.contextServer` into its
agent's MCP configuration: Claude via the Agent SDK's `mcpServers` (context
tool names added to `allowedTools`, `strictMcpConfig` kept), ACP agents via
`session/new` `mcpServers` when the agent advertises HTTP MCP.

### 12.7 Verification (2026-09-24)

**Packaged runtime, real Claude.** The desktop sidecar bundle
(`npm run desktop:runtime`) run by the bundled Node binary over the Rust
relay's stdin/stdout protocol and stripped environment, with the user's
signed-in Claude Code. The driver played the webview; the Rust relay itself
was not in the loop (Smart App Control blocks the unsigned `tabdump.exe`, §10),
and J.3 does not change it. 35/35:

- Launch Plan session → context view shows the workspace and capabilities, no credential.
- One listener, on `127.0.0.1` only.
- Claude called `mcp__tabdump__get_current_workspace` and listed the four tabs.
- Asked for `ws-private-finances`, it got *"This session can only read the TabDump workspace it was started from."* — **denied at the server**.
- The credential was present only in the agent's own environment: not on any command line, runtime response, event or stderr. The live credential got 200; a missing or forged one 401.
- "Create a collection *Launch reading*" → approval `change_workspace` in `ws-launch-plan`, with nothing to apply before approval → approved → listed → applied → completing it twice refused → re-synced → Claude confirmed it and read the collection back with `get_collection`.
- A sync of another workspace was refused.
- Disconnect → no agent process left → **the old credential got 401**.
- Shutdown → the server is gone.
- Nothing was written to the project folder.

**Automated.** `session-context/context.integration.test.ts` (real loopback
server + the official MCP client) covers workspace isolation, session
isolation, missing/forged credentials, release, restart, expiry, browser and
Host refusal, secrecy of outputs, read-only sessions, and deny, expire,
approve and apply. It also covers cross-workspace tab refusal, writes after
the session ends, and binding immutability. `runtime/session-context.test.ts`
covers the host: automatic context, access derived from the grant, mismatched
snapshots, sync refusal, approvals, and revocation on dispose, disconnect,
agent crash and shutdown. `session-context/secrecy.test.ts` pins exactly
which modules may name the credential, that none of them stores, logs or puts
it in a URL, and that the webview-facing view has no field for it. The Command
Centre tests cover the snapshot sent, the indicator and its popover,
read-only wording, persistence across a reload, the approval card, and
exactly-once application.

**Latency** (loopback, measured while the full test suite was running on the
same machine, so upper bounds):

| Measure | Result |
| --- | --- |
| Session start with context (`create_session`, packaged runtime) | 29 ms |
| Bind (snapshot parse + token + hash), 800 tabs | p50 2.5 ms, p95 5.1 ms |
| MCP connect (initialize) | 27 ms; 34 ms from the smoke driver |
| Workspace query (`get_current_workspace`, `search_tabs`, `get_tabs`, `get_tab_graph`, `get_collection`), 50 or 800 tabs | p50 ≈ 15–16 ms, p95 ≤ 21 ms — flat in workspace size |
| Approval machinery (request → approved → applied → tool returns, human excluded) | p50 32 ms |
| Approval round trip with real Claude (approve → Claude's reply complete) | 2.0 s, dominated by the model |

### 12.8 Limitations

- **ACP agents (Gemini, Grok)** are handed the context server, but an agent
  that asks before each MCP call is refused: ACP's permission request names
  no server, so a TabDump tool cannot be told apart from any other MCP tool
  (`mcp_tools`, which TabDump does not grant). Not verified live: neither
  agent is signed in on the test machine.
- **Hosted/remote runtime:** no context server — the sandbox cannot reach a
  loopback port on the user's machine. Sessions there fall back to the
  attached-context bridge.
- **One write** (`create_collection`). Renaming, moving and deleting are not
  offered.
- **Freshness:** the agent sees the last snapshot synced (debounced 400 ms).
  Changes made while the Command Centre is closed reach a live session when
  it is next opened.
- **Custom MCP clients** (§8) are unaffected and remain read-only, web-only.
