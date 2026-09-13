# Workspace synchronization

How TabDump's local-first application talks to the server, and — mostly —
what it deliberately refuses to do.

The governing rule, from which nearly everything else follows:

> A server response must never silently destroy or replace local workspace
> data.

## The layers

```
DOMAIN REDUCERS          pure: (state, args) -> state
        |
LOCAL COMMIT             commitStore: React state + localStorage
        |                 |
        |                 +-- mark dirty (notification only)
        v
SYNC ENGINE              scheduling, queue, cursor, retry, conflicts
        |
SERVER API               /api/sync/{initial,push,pull}, authenticated
        |
REPOSITORY               transactional, ownership-scoped
        |
POSTGRES
```

Each layer only knows about the one below it. In particular the engine is
handed state that has **already been committed locally**; it is never part of
the path that makes an edit durable.

```
                 +--------------+
                 | Local Store  |
                 +------+-------+
                        |
                  local mutation
                        v
                 +--------------+
                 | commitStore  |   <- synchronous, deterministic, local
                 +------+-------+
                        |
                   mark dirty        <- notification; cannot fail the commit
                        v
                 +--------------+
                 | Sync Engine  |
                 +------+-------+
                        |
                +-------+--------+
                v                v
             PUSH              PULL
                |                |
                +-------+--------+
                        v
                 Conflict layer
                        v
                  Local apply       <- back through commitStore, origin=remote
```

## commitStore and CommitOrigin

`commitStore(next, origin)` stays exactly what Phase 2.5 made it: synchronous,
non-async, and local. It sets React state, writes localStorage, and only then
notifies sync — inside a `try/catch`, because bookkeeping must never be able
to fail an edit that is already persisted.

`origin` is the loop prevention, and it is structural rather than a flag
someone has to remember:

| origin | meaning | marks dirty? |
|---|---|---|
| `"local"` (default) | a user action | yes |
| `"remote"` | data the server just sent | **no** |

Hydration does not call `commitStore` at all — it sets state directly — so
startup never enqueues anything either.

Without this, applying a pulled change would mark it dirty, push it back,
pull it again, and loop forever. `engine.test.ts` pins that it does not.

## Coverage

| Entity | Reaches the engine via | Dirty tracking |
|---|---|---|
| Workspace | `commitStore` diff | yes |
| Section | `commitStore` diff | yes |
| Group | `commitStore` diff | yes |
| Tab | `commitStore` diff | yes |
| Collection | published event | yes |
| Collection membership | inside its collection's payload | via the collection |
| Dependency | published event | yes |

Two routes, because the entities live in two places. Tabs, sections and
groups are inside `WorkspaceStore` and therefore pass through `commitStore`,
where they are diffed. Collections and dependencies have their own
localStorage blobs behind `useCollectionStore` / `useDependencyStore`, which
are mounted deep in the tree (WorkspaceView or GraphView) and are documented
to have **exactly one live instance at a time** — a second reactive instance
would race on the same key through its own debounced writer.

So rather than hoisting those stores (creating that race) or threading a
callback through two large components, a mutation publishes a small event on
`src/lib/sync/notify.ts` and the engine subscribes. The event carries
identity and intent only; the payload is read from the store at push time,
exactly as the workspace's is.

A dependency names no workspace — its store is flat and global — so the
engine resolves the owning workspace from the parent tab. An unresolvable one
is dropped rather than guessed, since scheduling against the wrong workspace
would push a relationship into one that does not own it.

Collection membership is not separately versioned (see `schema.sql`): it
travels inside the collection's payload, so a membership change marks the
collection dirty and the push carries its current tab list.

**Adding a tab to a collection marks two collections dirty.** A tab belongs
to at most one collection, so the add silently removes it from wherever it
was. Reporting only the named collection would leave the other's membership
stale on every other device.

### Remote changes for these two

The engine cannot write those blobs itself — each hook is the single writer
of its key, and its debounced effect would clobber an external write with
stale React state. So pulled collections and dependencies travel back on a
second channel (`publishRemoteEntities`) and the hooks apply them.

That channel **never feeds the dirty channel**: a store applying a remote
value does not publish. It is the same no-loop rule `CommitOrigin` enforces
for workspace data, expressed here as two separate channels rather than a
flag, and pinned by tests for both entity types.

## What counts as dirty

`diff.ts` compares the **syncable projection** of two committed stores, not
the objects themselves. Fields Phase 3 decided not to sync — `normalizedUrl`,
`domain`, `isDuplicate`, `favicon` — are absent from the projection, so
recomputing them schedules nothing. An identical re-commit produces an empty
diff. This is the same discipline Phase 2 applied to `updatedAt`, for the same
reason: a render is not an edit.

## The queue is a set, not a log

A push carries the **current state** of an entity rather than a delta, so the
only durable record needed is *which* entities changed and whether they were
deleted. That gives three properties for free:

- **Coalescing.** Twenty edits to one tab are one entry, so one upsert.
- **Idempotency.** Replaying sends whatever the workspace holds now, however
  many times it runs — which is what makes a lost response safe.
- **Bounded size.** The journal cannot grow with edit count.

An event log would need ordering, compaction and replay to produce exactly the
same request.

Journal state lives in `tabdump:sync-journal:v1` — its own key, account-scoped,
never part of a workspace export.

## The cursor

The cursor is this device's promise that it has *incorporated* everything up
to that point. So it advances **last**:

```
push -> retire what the server accepted
     -> pull -> apply locally -> commit workspace
     -> only then persist the cursor
```

It specifically does **not** advance because a push succeeded, or because a
pull returned 200. If the local apply throws, the cursor stays where it was
and the same page is fetched again. Repeating work is safe; skipping it is
not — a skipped change is gone forever, because the next pull starts after it.

## Conflicts

Detection is the server's (Phase 4, per-entity against `baseCursor`).
Phase 5 makes conflicts **durable and actionable**, and keeps both sides:

- `local` — captured at detection time, so it survives later local edits
- `remote` — filled from the pull that follows
- deterministic id, so re-detecting one updates a record rather than piling up

| choice | local state | queue |
|---|---|---|
| Keep mine | unchanged | entity re-marked dirty — the resolution becomes a real mutation pushed against the server's *new* cursor |
| Keep theirs | server value applied | nothing — re-pushing the server's own value is the loop above |

There is no automatic field-level merge. Two devices that both changed a tab
since their shared base have genuinely conflicting versions, and without
per-field base information there is no honest way to distinguish "they changed
the title, I changed the favourite" from "we both changed the title". Guessing
would silently discard an edit.

**Manual organization has standing.** `sectionLocked` means a human placed a
tab. The server refuses an automatic placement that would move a locked tab
(Phase 4), and the UI says so rather than offering two equivalent-looking
buttons. `lastAccessedAt` is deliberately *not* a conflict field — opening a
tab is not a content mutation.

## Retry

| failure | classification | behaviour |
|---|---|---|
| network / offline | retryable | exponential backoff, jittered, capped at 5 min |
| 5xx (incl. a bare 503) | retryable | same |
| 503 with `reason: "not-configured"` | permanent | `paused` — this deployment has no database |
| 401 | permanent | `paused`, pending work kept for after sign-in |
| 409 | conflict | recorded; not retried blindly |
| 400 / 413 | permanent | `error`, no retry armed |

A bare 503 is treated as transient on purpose: only *our* 503 carries
`reason`, and a proxy's 503 must not pause sync forever.

Nothing about a failure discards a dirty ref. An outage costs latency, never
an edit.

## Offline

`navigator.onLine` is a hint that a request is worth *attempting*; a captive
portal reports "online". The authority is an actual failed request, which the
engine records as `offline`. Local editing is unaffected throughout.

## Scheduling

- **Debounce** (~800 ms) so rapid edits become one push.
- **Per-workspace lock.** A second request while one is running returns the
  same in-flight promise and schedules one rerun afterwards — never a second
  concurrent sync.
- **Bounded concurrency** (3) across workspaces, so twenty workspaces are not
  twenty simultaneous requests.
- **Triggers**: reconnect, focus, tab becoming visible, and a 60 s timer,
  coalesced to at most one pass per 2 s. Hidden tabs do not poll.
- Every listener and timer is removed on teardown, so a StrictMode
  mount/unmount/remount leaves exactly one of each.

## Initial migration is explicit

A `never-synced` workspace is marked dirty but **never uploaded** by ordinary
sync. Absence on the server is not permission to upload, and signing in must
not turn into a silent migration. Only `migrateWorkspace` — behind a user
action — moves a workspace out of that state.

## Account switching

Cursors, dirty refs and conflicts are all account-scoped. A different `userId`
reads as a fresh `never-synced` entry rather than inheriting the previous
account's state, which would otherwise push one user's edits at another user's
workspace.

## Device-local, and staying that way

Never synchronized: camera, viewport, selection, sidebar state, graph
positions, boundary offsets, layout cache, the sync journal itself. The graph
store keeps its own key and its own prune; the engine does not touch it.

## Out of scope, deliberately

No WebSockets, SSE or BroadcastChannel. No CRDTs, vector clocks, operational
transforms or event sourcing. No realtime collaboration or presence. No
desktop authentication. No extension synchronization.

## Deletes

A delete must produce a tombstone, never a quiet disappearance from the dirty
set — a collection or dependency that merely vanished locally would live on
forever on every other device.

Two things make this work with a set-based journal:

- The dirty entry records `deleted`, and the **last intent wins**. An entity
  edited then deleted is a deletion; one deleted then re-created is an upsert.
- `buildPush` reads **current state** regardless. An entity marked dirty that
  is no longer in its store becomes a delete whatever the event said, so a
  create→delete before the first push sends only the tombstone and cannot
  resurrect the entity server-side.

Both survive a reload: the journal is persisted, including the `deleted` flag.

## Known limitations

- **Desktop sync is inert**, because the static export ships no API routes and
  therefore has no session. This is the intended state.
- **No real Postgres** in this environment — no `POSTGRES_URL`, no `psql`, no
  Docker, nothing on 5432, and only the `pg` client driver is installed. So
  transactions, `FOR UPDATE`, cascade behaviour and foreign-key enforcement
  remain verified structurally and against a recording fake rather than
  executed. **Real Postgres integration is environment-blocked**, and no
  claim is made that those behaviours were runtime verified.
- Workspace deletion is still not part of the push surface; tombstoning a
  whole workspace needs a decision about its children that belongs with the
  deletion UX.
