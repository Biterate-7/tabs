# Explicit Agent Handoff (Hubble 1.4)

> **Workspace → Agent A → the person reviews → Continue with… → Agent B →
> Agent B acts → result in the workspace → both sessions in one history.**

The person hands the work of one agent session to another agent, in the same
workspace, and chooses exactly what goes with it. Every step is theirs: there
is no automatic next agent, no agent-initiated handoff, no background chain.
A chain (Claude → Codex → Gemini) is simply two handoffs, each chosen.

## 1. The model

```
source session ──▶ handoff ──▶ target session
 (Agent A)        (record)     (Agent B, new)
```

A handoff is its own record (`SessionHandoff`, `src/lib/agents/handoff/handoff.ts`):
`handoffId`, `workspaceId`, `sourceSessionId` + `sourceProvider`,
`targetProvider` + `targetSessionId`, `status`, `failure`, what was passed
(`context`), the person's `instruction`, and times. Both sessions stay
independent — two control sessions, two journals, two histories. The
relationship is stored by id and is never inferred from times, names,
neighbouring rows or prompts.

Statuses: `preparing` (the preview; never stored), `creating_session`,
`sending_context`, `ready`, `failed` (`session_not_created` |
`context_not_delivered`), `cancelled` (the person closed the preview; nothing
was started, nothing is kept).

## 2. What crosses — three explicit modes

| Mode | What the target gets |
|---|---|
| Workspace context | A new binding to the **same** workspace through the existing context server (fresh snapshot, the source's focus if it still fits). The envelope states counts only. |
| Previous result | The source's results in the activity timeline's own words — collections created, files written, commands run — from `buildAgentActivityTimeline`. An undone change is left out. |
| User instruction | The person's words, bounded (2,000) and scrubbed: anything shaped like a key, token, JWT, `Authorization` value or `password=` is replaced with `[redacted]` before it is kept or sent. |

Never passed: the source's conversation, its reasoning, tool payloads, raw
protocol messages, command lines, credentials, headers, the context-server
token. There is no field for any of them.

The target's first message is a short envelope (`buildHandoffEnvelope`):

```
HUBBLE HANDOFF

The person you are working with has handed you work another agent did in their Hubble workspace. Continue from it.

Workspace: Development
Previous agent: Claude Code
Previous session: Research the API

Previous result: Finished
- Created collection “Implementation Plan” (4 tabs)

Workspace context: 8 tabs · 2 collections
Read it through Hubble's workspace tools. Changes to the workspace ask the person first.

Instruction from the person:
Implement the plan from the previous agent.
```

## 3. Runtime protocol

Two commands, following the existing verb conventions (`src/lib/agents/runtime/protocol.ts`):

- `prepare_handoff { sourceSessionId, targetProvider, contextSnapshot? }` →
  `RuntimeHandoffPreview` (what could be passed, `contextTools`, a
  `fingerprint`). Starts nothing, keeps nothing — so it works on a remote host
  built per request.
- `start_handoff { …same, fingerprint, include, instruction?, projectId? }` →
  `{ handoff, session?, error? }`. A failed handoff is answered as data
  (it happened and is recorded), validation refusals as errors.

The host (`runtime/host.ts`) checks, from its own records, never the browser's:

1. the source session is the caller's (`own`) — `session_not_found` / `ownership_denied`;
2. it works in a workspace and is done with its turn (`canHandOffFrom`) — `invalid_session_state`;
3. the target agent can be started and is signed in — `provider_unavailable` / `authentication_required`;
4. a snapshot, if sent, is of the source's own workspace — `context_invalid`;
5. the context re-derived now still matches the preview's fingerprint — `context_invalid`;
6. a project, if named, is this actor's and authorizes the target agent — `project_scope_violation`.

Then: the target session is created through **the same routine as
`create_session`** (`startHostedSession`) — same gates, the project's grant and
nothing more — the envelope is sent as its first message, and each stream gets
Hubble's event: `handoff_received` (then `context_loaded`) on the target,
`handoff_sent` on the source. `prepareHandoffPreview` (`handoff/preview.ts`) is
the one place the preview is computed — by the host, the fixture runtime and
the landing demo alike.

## 4. Events

Two Hubble-raised kinds in the canonical control-event model
(`control/events.ts`): `handoff_sent`, `handoff_received`, carrying a
`handoff` slice (ids, peer provider, outcome, failure — never content). The
`message_sent` that delivered the envelope carries the slice too, so the
timeline knows it by reference and shows "Handoff received" instead of "You
sent a message". Adapters can raise neither (`ensureSubscribed` drops them).

## 5. History

One additive table, `tabdump_agent_handoffs`, appended to
`src/lib/agents/activity/history-schema.sql` and applied by the existing
`npm run migrate:agent-history` (idempotent, `IF NOT EXISTS`). One row per
ended handoff (`ready` / `failed`), FK to its source session; inserted only when
the source session is the owner's **in the handoff's workspace** (the INSERT's
SELECT is the guard). `list_history` attaches each session's links
(`AgentHistorySession.handoff`), `get_history` returns the session's handoffs
(`AgentHistoryRecords.handoffs`). A database migrated only for 1.3 keeps
working exactly as before; handoffs are simply not kept until it is migrated.

## 6. Approval and undo

The handoff grants nothing: the target's permissions are its project's, and
every workspace write still goes through the broker's approval card. A handoff
is not a workspace change, so it has no Undo; the inspector says so. Changes
the target makes are undone exactly as any agent's, through
`restoreWorkspaceCollections`.

## 7. UI

- **Continue with…** — in the shared `AgentActivity` header, offered only for
  a session in a workspace that is done with its turn.
- **`HandoffDialog`** (`components/command-centre/handoff-dialog.tsx`) — the
  agent selector from the connected-agent roster (`handoffAgentOptions`; not
  connected → the existing Connect flow), the runtime's preview with a box per
  mode, the instruction, the project, then progress or a precise failure with
  Try again.
- **Activity** — "Handed off to Codex" (with "Open Codex session"), "Handoff
  received · From Claude Code", "Couldn't hand off to Codex".
- **Inspector** — the existing `ActionInspector` with a handoff section: From,
  To, Workspace, Context, Previous result, Instruction, Created.
- **Session list / history** — a quiet "← Claude Code" / "→ Codex" line on the
  shared `SessionListRow`.

## 8. Landing page

The demo opens the same `HandoffDialog` with the same `handoffAgentOptions`,
and its deterministic transport computes the preview and the envelope with
`prepareHandoffPreview`, `buildHandoffEnvelope`, `readHandoffInstruction` and
`selectHandoffContext` — the host's functions. `demo-handoff.test.tsx` fails if
it drifts, and drives the whole flow with the network stubbed to fail.

## 9. Limits (v1)

- A handoff starts from a live session this runtime holds; a session read back
  from history after a restart can be opened, not handed on.
- On a remote (per-request) host, the "→ / ←" links on *live* session views
  come from the request's memory; history always has them.
- The previous result is structural (what was made or changed). An agent's
  prose answer is not passed — by design.
