# Agent History (Hubble 1.3)

> **Workspace → Agent session → Activity → Action → Result**, kept after the
> runtime that hosted it is gone.

The Activity Timeline and Action Inspector were built over the runtime's
in-memory event journal: they survived remounts and reconnects, but not a
runtime restart. Agent history makes the same records durable — not a second
timeline, a second store of the *same* records.

## 1. One event model

```
runtime ─▶ canonical control event ─┬─▶ journal ─▶ live Activity Timeline
                                    └─▶ recorder ─▶ agent history (Postgres)
                                                         │
          list_history / get_history ◀───────────────────┘
                     │
                     ▼
   reconstructHistorySession ─▶ buildAgentActivityTimeline / inspectActivityEntry
                     │                       (unchanged, shared)
                     ▼
   AgentHistoryList · HistorySessionView · AgentActivity · ActionInspector
```

What is kept is exactly what the timeline and inspector read — the control
events, the approvals they reference, the workspace changes the Command Centre
applied, undos, and plans' verified outcomes — reduced on the way in
(`src/lib/agents/activity/history.ts`). Read back, they are put into the live
model unchanged, so the past timeline is built by the same builder, joined by
the same ids (`approvalId`, `changeId`, `planId`), never by time or wording.
`history.test.ts` asserts the timeline and every inspection are identical
from live and from persisted records.

## 2. What is not kept

- No conversation: `text` is dropped from every event; `thinking` and
  `message_delta` are not kept at all.
- No command lines (`ApprovalCommandPreview`), no non-file approval targets,
  no tab titles (approval change/plan details), no free-text summaries except
  on `approval_requested` and `error`.
- No credentials, headers, URLs or raw protocol payloads — there is no column
  or field to hold one.
- Kept beyond names and counts: the collection snapshot either side of an
  applied change (ids, names, tab ids), because it is the exact inverse undo
  needs. Bounded (`HISTORY_LIMITS.snapshotBytes`) and dropped whole otherwise.

## 3. Where it lives

| Piece | File |
|---|---|
| Reducers, revivers, reconstruction | `src/lib/agents/activity/history.ts` |
| Store interface + memory store | `src/lib/agents/activity/history-store.ts` |
| Postgres store (shared pool) | `src/lib/agents/activity/history-store-postgres.ts` |
| Schema | `src/lib/agents/activity/history-schema.sql` |
| Recorder (batched, failure-isolated) | `src/lib/agents/activity/history-recorder.ts` |
| Process wiring | `src/lib/agents/activity/history-server.ts`, `runtime/server.ts` |
| Runtime commands | `list_history`, `get_history`, `record_workspace_change`, `record_workspace_undo` |
| Client hooks | `src/hooks/use-agent-history.ts`, `useHistorySessionActivity` |
| UI | `command-centre/agent-history-list.tsx`, `command-centre/history-session-view.tsx` |

Apply the schema with `npm run migrate:agent-history` (additive, idempotent;
touches no existing table). Without a database, or before the migration,
history is reported **unavailable** — never empty — and live sessions work as
before.

## 4. Rules

- **Scope.** Every read takes the actor (`account:<id>` or `local`) and the
  workspace, in the SQL predicate. Another workspace's or account's session is
  indistinguishable from a missing one. A session never moves workspace.
- **Status.** A session recorded as live but held by no runtime reads as
  `disconnected` (`historySessionStatus`), never "Running".
- **Immutability.** Records are written once. An undo is a new `undo` record;
  the change it undid is never rewritten. A plan outcome is the one record that
  may be updated (the runtime's latest word on that plan).
- **Undo.** Offered only when the change kept both snapshots *and* the
  workspace still equals `after` (`collectionsMatch`); applied through the same
  `restoreWorkspaceCollections`; refused with nothing moved otherwise.
- **Limits.** 20 sessions per page (keyset paging, max 50); 1,000 events per
  session, after which the session is marked `truncated`.
- **No polling.** The list is re-read when the workspace changes or a live
  session appears, ends or is disposed.

## 5. Desktop

The packaged app's runtime sidecar has no database, so it answers
`history_unavailable` and the Command Centre says "Agent history
unavailable". Local-first workspace behaviour is untouched.

## 6. Landing page

The demo renders the same `AgentHistoryList`, `HistorySessionView`,
`useHistorySessionActivity` and `AgentActivity`, fed deterministic records
produced by the same reducers (`DEMO_HISTORY` in `marketing/demo/data.ts`).
`demo-parity.test.tsx` fails if it stops.
