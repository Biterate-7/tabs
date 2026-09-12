# Workspace synchronization

How TabDump's local-first workspace data reaches a server and comes back.

TabDump remains local-first. localStorage is the source of truth, every
mutation still goes `reducer → commitStore → local persistence`, and nothing
on that path touches the network. Synchronization sits beside it and is
initiated explicitly.

```
DOMAIN REDUCERS   pure
      ↓
LOCAL PERSISTENCE deterministic (commitStore)
      ↓
SYNC SERVICE      network-aware, outside React      src/lib/sync/client.ts
      ↓
SERVER API        authenticated                     src/app/api/sync/*
      ↓
REPOSITORY        transactional                     src/lib/sync/repository.ts
      ↓
POSTGRES                                            src/lib/sync/schema.sql
```

## The one invariant

**A server response can refuse, but it must never destroy.**

Everything below follows from that. No response empties a workspace, no
failure discards a local edit, and no absence is read as a deletion.

## Identity

An entity is its UUID, minted on the device by `src/lib/id.ts` before the
server has ever heard of it. The server stores exactly what it is given: no
column has a generating default, and nothing is remapped on upload. A tab
created offline uploads, downloads and round-trips as itself.

A dependency is the exception, and deliberately: its identity is the
`(parentTabId, childTabId)` pair, because that is how the client derives its
id. The wire carries the pair; no separate id is invented.

URL equality is **not** identity. Two tabs with the same URL are two tabs —
TabDump has first-class duplicate semantics — and nothing in migration,
serialization or apply ever merges by URL.

### Legacy ids

Entities saved before the UUID migration kept ids like `ws-1699…-1`. Those
are not valid UUIDs and the server rejects them with a distinct `legacy`
error rather than a generic "malformed".

`src/lib/sync/legacy-migration.ts` rewrites such a workspace:

1. build a complete `old → new` map for the workspace, sections, groups,
   tabs and collections — everything, before anything is rewritten;
2. rewrite every reference: `tab.sectionId`, `tab.groupId`,
   `section.parentId`, `collection.workspaceId`, `collection.tabIds`,
   `dependency.parentTabId`/`childTabId` (and the dependency's derived id),
   and the tab/workspace ids embedded in device-local graph state
   (`positions`, `boundaryOffsets`, `manualConnections`, `workspaceFilter`,
   `selectedTabId`);
3. return a **new** representation — the input is never mutated.

The caller keeps the original until the server confirms, so a failed upload
leaves local data exactly as it was. Ids that are already UUIDs map to
themselves, so running it twice is a no-op and a mixed workspace keeps its
good ids unchanged.

## Ownership

```
HttpOnly session cookie → session row → userId → workspace.user_id → entities
```

Identity comes only from the session. No payload type has an owner field, so
there is nothing for a client to forge; a body containing `userId` is
ignored. Every repository method takes `userId` and every statement is
constrained by it — there is no method that accepts a workspace id alone.

Child entities are never checked against the user directly. They are reached
only through a workspace the user owns, and the schema's composite foreign
keys make a child of another workspace unrepresentable.

"Not yours" and "does not exist" both answer **404** with identical wording,
so a guessed id is not an existence oracle.

## API

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/sync/initial` | POST | session | Upload one workspace for the first time |
| `/api/sync/push` | POST | session | Apply a batch of local changes |
| `/api/sync/pull` | GET | session | Changes since a cursor |

All three go through `gateSyncRequest`, which applies the same model as the
existing `/api/auth/google` route: same-origin, `application/json` (POST
only), authenticated session, shared rate limiter. `pull` is a GET and is
genuinely read-only — it writes nothing and advances no server state.

Bodies are capped at 8 MB, measured as read rather than trusted from
`Content-Length`; a push carries at most 2000 changes and an initial
migration at most 10 000 entities.

## Cursor

An opaque string naming a position in one workspace's change stream. It comes
from the workspace's `sync_counter`, incremented once per mutating
transaction under a row lock on the workspace row.

That last detail is the reason a cursor works at all. A bare Postgres
`SEQUENCE` is unsafe here: `nextval()` is handed out *before* commit, so a
transaction holding version 5 can commit after one holding 6, and a client
that read past 6 would never see 5. The row lock makes version order equal
commit order.

Every row written by one transaction shares one version, so a bulk operation
— organize, move twenty tabs, import — is one indivisible step in the stream.
A pull page is therefore cut at a version **boundary**, never mid-version.

Cursors are **device-local** (`src/lib/sync/metadata.ts`, its own
localStorage key, scoped by account). A laptop at 42 and a desktop at 57 are
both correct. Nothing stores a single "last synced cursor" on the workspace,
and no cursor reaches an export.

## Initial migration

Explicit and user-initiated. Signing in never uploads anything.

```
local workspace → validate → migrate legacy ids if needed
                → upload atomically → server confirms → record cursor
```

The whole workspace is written in one transaction, so the database never
holds half of it. If anything fails, it rolls back and the local copy is
untouched.

**Idempotency.** A retry after a lost response sends `knownCursor` — the
cursor the client recorded. The server recognises it and updates in place
using the client's own ids, so no duplicate workspace, tab or section can
appear. A client that sends no `knownCursor` for a workspace that already
exists gets **409**, not an overwrite. There is no force flag.

## Push

```
authenticate → validate → lock workspace → check base cursor
             → check per-entity conflicts → apply → advance version → commit
```

All or nothing. Every refusal happens before any write, and the conflict
check runs inside the transaction holding the row lock, so no other push can
interleave between checking and writing.

The response echoes `accepted` — what the server actually stored — so the
client establishes its new baseline from fact rather than assumption.

## Pull

Returns changes above the cursor, in version order, with `nextCursor` and
`hasMore`. Never the whole workspace.

Tombstones travel with updates. That is the entire reason deletions are
stored rather than removed: a client can distinguish *deleted* from *never
heard of*, and absence never implies deletion.

## Tombstones

Deletion sets `deleted_at`; no row is removed. Nothing purges tombstones —
retention is deliberately unaddressed in this phase. The only hard deletion
in the schema is the account-erasure cascade from `tabdump_users`, where
there is no client left to inform.

The deletion timestamp is stamped by the server. A client-supplied one would
let a wrong clock place a tombstone in the past, where a device reading
forward from its cursor would never see it.

## Conflict detection

**Detection is implemented. Resolution is not.** A conflict is reported with
enough detail to explain it, and nothing is overwritten.

Two levels:

- **Stale base** — the workspace moved since the client last read. `409`,
  `reason: "stale-base"`, with the server's cursor. Pull, then retry.
- **Per-entity** — the specific object's `sync_version` is above the client's
  base. `409`, `reason: "conflict"`, naming each entity.

Per-entity matters: two devices editing *different* tabs in the same
workspace do not conflict and are not told they do.

### Manual organization

`sectionLocked` means a human placed that tab, and the local organizer
already refuses to move such a tab. That guarantee holds across devices too:
an incoming write that would move a locked tab to a different section
**without itself being a manual placement** is refused, even when versions
agree (`reason: "locked-section"`). A genuine manual move from another device
arrives with `sectionLocked: true` and is accepted.

Deliberately conservative. A conflict prompt costs the user a moment;
silently discarding their organization costs them work.

### Not a conflict signal

`lastAccessedAt` is not `updatedAt`. Opening a tab is not a content
mutation, and sync introduces no timestamp churn.

Timestamp comparison alone does **not** resolve any of this, and nothing here
applies last-writer-wins.

## Applying pulled changes

By entity identity, never wholesale (`src/lib/sync/apply.ts`, a pure
reducer). A change names one entity and only that entity is touched.

- Absence removes nothing. Only an explicit tombstone deletes.
- A workspace tombstone is **reported, not applied** — removing someone's
  whole workspace during a background pull is not something this layer does.
- If an entity has an unsynced local edit, the remote change is withheld and
  returned as a conflict rather than overwriting it.
- `normalizedUrl`, `domain` and `isDuplicate` are recomputed locally; a tab
  that round-trips is indistinguishable from one that never left.

## Offline

Every client function returns a discriminated result; none throws. Offline, a
500, a timeout and a 503 all become a recorded `error`/`pending` state. The
workspace stays fully editable — sync failure is never application failure,
and nothing blocks a local mutation.

Retries are safe because ids are stable and writes are upserts. Retry is
bounded and manual in this phase; there is no aggressive background loop.

## Sequence

```
Client                              Server

  | POST /api/sync/initial            |
  |---------------------------------->|
  |            validate + transaction |
  |                        cursor = 42|
  |<----------------------------------|
  | local cursor = 42                 |
  |                                   |
  | POST /api/sync/push (base = 42)   |
  |---------------------------------->|
  |              apply in transaction |
  |                        cursor = 43|
  |<----------------------------------|
  |                                   |
  | GET /api/sync/pull?cursor=43      |
  |---------------------------------->|
  |                        no changes |
  |<----------------------------------|
```

Conflict:

```
Client A cursor 42          Client B cursor 42

A pushes ─────────────────► server cursor 43

                            B pushes base = 42
                                     │
                            stale base detected
                                     │
                            409 + serverCursor 43
                                     │
                            B pulls, reconciles, retries
```

## What is not here

Automatic sync, background/realtime sync, websockets, polling, conflict
*resolution*, CRDTs, desktop authentication, extension sync. Local mutations
make no network requests. The desktop app runs unchanged and needs no server.

## Verification status

Structural, contract and API-level behaviour is tested. **Postgres semantics
are not verified**: this environment has no Postgres, psql or Docker, so
foreign-key enforcement, composite-FK cross-workspace rejection, `FOR UPDATE`
serialization, real transaction rollback and concurrent-push ordering have
been designed and reviewed but not executed. Applying `schema.sql` and
exercising these against a real database remains a required manual step.
