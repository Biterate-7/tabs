# Phase J — The Agent Connector Platform

TabDump connects external AI agents through **one** connector framework.
Claude Code, OpenAI Codex, Gemini CLI, Grok Build and any MCP-compatible agent
are each a provider *entry* plus, where TabDump can drive the agent, a
server-side control adapter. None of them has its own integration
architecture.

```
Command Centre ─ Connect Agent → choose → detect → sign in → approve → connected
               ─ Agents roster (persistent identities, live state, workspace)
               ─ Agent chat (streaming replies, inline approvals)
        │
        ▼  lib/agents/platform/        (browser, pure)
  AgentPlatformConnector ── one implementation over the typed runtime client
  catalog · lifecycle · roster · chat (unified session model)
        │  18 closed protocol verbs (+4 in this phase: detect_providers,
        ▼  connect_provider, authenticate_provider, disconnect_provider)
  RuntimeHost ── ControlService (gate, broker, permissions — unchanged)
        │
        ├── Claude Code ── Agent SDK adapter (Phase C, unchanged)
        └── Gemini CLI · Codex · Grok ── ONE ACP adapter (control/providers/acp)
                 │  JSON-RPC over stdio, transport injected
                 ▼
        lib/agents/launch/  (server-only) allowlist · resolve · detect · spawn
```

The observation plane (`AgentConnector`, `connectors/**`) is untouched and
still cannot act. The new lifecycle interface is deliberately named
`AgentPlatformConnector` so the two can never be confused in an import.

## 1. Providers

| Provider | Transport | How it signs in | TabDump launches |
| --- | --- | --- | --- |
| Claude Code | Agent SDK | the user's own Anthropic key (Settings → AI connectors, BYOC) | via the SDK |
| Gemini CLI | ACP, native | Google login, run by Gemini CLI itself | `gemini --acp` |
| Codex | ACP, via `codex-acp` | ChatGPT login, run by codex-acp itself | `codex-acp` |
| Grok Build | ACP, native | Grok Build's own first-run login | `grok agent stdio` |
| Custom MCP agent | MCP (the agent is the client) | a TabDump MCP token issued in Settings | nothing — never started |

**Why ACP.** The [Agent Client Protocol](https://agentclientprotocol.com) is
spoken natively by Gemini CLI and Grok Build and by Codex through its adapter,
and — unlike a print-mode CLI — it has a real per-tool approval callback
(`session/request_permission`). That is the Phase C lesson again: a permission
*mode* is not a permission *callback*. With ACP, "approve this edit" is
connected to something. Three providers, one adapter.

## 2. Security model

| Requirement | How it is met |
| --- | --- |
| No credential in the UI | The protocol has no field for one. `authenticate_provider` carries a *method id* the agent advertised; the agent runs its own login (a browser page). Key-based ACP methods are filtered out — they could never succeed, see below. |
| No raw secrets persisted | The roster (`tabdump:agent-roster:v1`, account-scoped) holds identity and consent only; its guard fails the build on a credential-shaped field. Per-session MCP tokens are minted in memory, passed in `session/new`, expire in 8h and are revoked when the session ends. |
| Native auth/approval | ACP `authenticate` for sign-in; ACP `session/request_permission` for approvals, routed through the existing broker. |
| Explicit approval for privileged actions | Edit/delete/move/execute/fetch/MCP tools map to approval actions (`control/providers/acp/policy.ts`). TabDump answers with the agent's **one-time** option, never "always". A privileged tool that starts **without** a TabDump approval (an agent configured to auto-accept) cancels the turn and fails the session. `switch_mode` is always refused. New sessions are put in the agent's asking mode (`default` for Gemini, `read-only` for Codex). |
| Workspace boundaries | Unchanged: context through the Phase E resolver, owner-checked; projects by id, revalidated by the host *and again by the launcher* before `spawn`. Tool locations outside the project are dropped from every event. |
| No arbitrary shell execution | `launch/allowlist.ts` is the entire list of programs and their literal argument arrays. `shell: false` always. Windows npm `.cmd` shims are followed to the allowlisted package's own script and run with Node — never through `cmd.exe`. TabDump advertises **no** `fs` or `terminal` capability to ACP agents and answers those requests method-not-found. No custom-agent command is ever launched. |
| Local-first | ACP agents run only on a **local** runtime. Detection answers only when the runtime is local, and returns booleans — never a path. |

The agent process gets an **allowlisted** environment (`launch/env.ts`): home,
temp, PATH and nothing else. No `*_API_KEY`, no database URL, no TabDump
secret. This is why API-key sign-in methods are not offered: the agent signs in
with its own login, or not at all — the same no-fallback rule
`credentials/security.test.ts` enforces for provider keys.

## 3. The connection lifecycle

`platform/lifecycle.ts` derives one phase per provider from three independent
reports — the machine (`detect_providers`), the runtime (status + connect/sign-in
replies) and the roster (approval). Nothing stores "connected":

```
runtime_unavailable → not_installed → needs_adapter → detected
  → sign_in_required → awaiting_approval → connected        (+ error, unknown)
```

The Connect Agent steps (`choose → detect → sign in → approve → done`) are a
table over those phases, so reopening the dialog lands where the agent really
is. Approval is agent-level consent: reading TabDump and project files is on by
default; changing files and running commands are off, and even when on, every
use still asks. A session cannot be started for an agent that is not in the
roster, or on a project whose grant exceeds what the agent was approved for.

## 4. The unified session and chat

The control event gained a bounded text channel (Phase J) on exactly three
prose kinds — `message_sent`, `message_received` and the new `message_delta` —
enforced by `isWellFormedControlEvent`. Tool results, command lines, diffs and
reasoning still have nowhere to go. Text is live-wire only: the durable domain
log still stores a 200-char summary, and nothing is written to browser storage.

`platform/chat.ts` turns the provider-neutral stream into a transcript: deltas
sharing a `messageId` are shown joined and marked streaming, then replaced in
place by the whole reply. The host journals the user's own words as
`message_sent`, so a conversation reads back whole after a reload. Replies are
rendered as plain text, never HTML.

## 5. Files

```
src/lib/agents/control/providers/acp/   rpc · protocol · policy · launcher · adapter
src/lib/agents/control/authentication.ts  native sign-in extension (like approval-details)
src/lib/agents/control/providers/context-prompt.ts  shared <tabdump-context> renderer
src/lib/agents/launch/                  allowlist · resolve · detect · env · process · mcp-link
src/lib/agents/platform/                catalog · lifecycle · roster · connector · chat
src/lib/mcp/session-tokens.ts           per-session MCP tokens (additive)
src/hooks/use-agent-platform.ts
src/components/command-centre/          agent-roster · connect-agent-dialog (+ view, stream, dialogs)
```

## 6. Verified, and not

**Verified against real software:** the real Gemini CLI (`@google/gemini-cli`)
and real `codex-acp` start through the real launcher (npm-shim path), complete
the ACP handshake, advertise their sign-in methods, and refuse a session as
"sign in first" in a clean home — mapped to `authentication_required`. Run it:

```bash
npm install --prefix <dir> @google/gemini-cli @agentclientprotocol/codex-acp
TABDUMP_ACP_AGENT_PREFIX=<dir> npx vitest run src/lib/agents/launch/integration.local.test.ts
```

A scripted ACP agent running as a **real child process** proves the argv, the
working directory, the stripped environment and a full approval round trip over
stdio (`launch/process.test.ts`).

**Not verified here:** a completed, authenticated turn with any of the three ACP
agents (no Google/ChatGPT/xAI login in this environment — and the sign-in
itself opens a real browser, which a test must not do); Grok Build at all (its
installer is `curl | bash`, not run here); Grok's sign-in marker (undocumented,
so detection never claims Grok is signed in).

## 7. Limitations

- **Desktop:** the packaged Tauri app has no API routes, so it cannot run any
  agent — including these. Local runtime (`npm run dev` / self-hosted) only.
- **Remote runtime:** only Claude runs in the sandbox; ACP agents are local.
- **Resume:** ACP sessions do not declare `resume_session` (ACP `session/load`
  replays a history; reattaching is not built). A restart ends them.
- **Streaming:** ACP agents stream; Claude over the SDK still delivers each
  reply whole (partial messages are not wired).
- **MCP link:** per-session TabDump MCP access needs a signed-in account and the
  token store (Postgres). Signed-out local use gets attached context only.
  Claude sessions do not get the MCP link (Phase C's `strictMcpConfig` kept).
- **Agent-level MCP servers:** an ACP agent still loads MCP servers from its own
  config; their tools arrive as kind `other` and require approval.
- **Custom agents** are MCP clients only — TabDump never launches a user-named
  program, by design.
- **Enforcement is strict:** an agent that runs a privileged tool without
  asking is stopped, even if the user configured that agent to auto-accept.
