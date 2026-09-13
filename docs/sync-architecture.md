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

## A stale base is a read, not an error

The server gates a push on strict equality: `baseCursor` must equal the
workspace's current counter (`repository.mutateWorkspace`). So **any**
server-side movement makes the next push stale, whether or not the entities
overlap.

A refused push therefore does **not** end the pass. The engine records the
refusal, keeps every dirty ref, and falls through to the pull — because
reading is the only thing that fixes being behind. The pending work goes up on
the following pass, against a base the device has actually seen:

```
push (409 stale-base) -> pull -> apply -> cursor advances
                      -> next pass: push against the new base -> accepted
```

Returning at the refusal instead would skip the pull that unblocks it, and the
next pass would resend the same stale cursor — a device that fell behind while
holding an edit could never catch up. The follow-up pass is scheduled only when
the catch-up actually moved the cursor, so each repeat requires real progress
and the loop terminates.

One consequence worth stating plainly: because the workspace-level gate fires
first, the server's *per-entity* `changed-since-base` report is not what
surfaces same-entity contention in practice. Contention surfaces on the client,
when the catch-up pull brings back a change to an entity this device has
pending. The per-entity check still stands as the server's own guard, and the
`locked-section` half of it fires independently of staleness.

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

**An unresolved conflict is held out of the push.** Its dirty ref is kept so
Keep mine can re-send it, but the entity is excluded from the next push until
the user chooses. Without that, the following pass would send the local version
against a now-current base and quietly win — last-writer-wins by the back door,
and the opposite of what the conflict UI promises. Everything *else* in the
workspace still goes up, so one contested tab does not hold unrelated edits
hostage.

**A device's own echoed write is not a conflict.** If a push commits and the
reply is lost, the retry pulls that same write back while the entity is still
marked dirty. Comparing the incoming payload against the local one through the
serializers (`apply.ts`'s `matchesLocal`) keeps that from being reported as a
conflict between two identical values — a question the user cannot answer,
raised by nothing worse than a dropped packet. The comparison is exact: any
difference in a syncable field is still a genuine conflict.

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

## Two devices, one account

Identity is the server-side session, always. No sync route reads a `userId`
from a body or query string — the payload types have no such field — so a
client cannot choose who it is. Ownership is enforced in SQL (`WHERE id = $1
AND user_id = $2`), and "not yours" and "doesn't exist" both answer 404 so a
guessed id is not an existence oracle.

What two devices are guaranteed:

- **Different entities converge.** A editing tab 1 and B editing tab 2 both
  survive. The second pusher pays one extra round trip to the stale-base
  catch-up; neither edit is lost and neither is reported as a conflict.
- **The same entity produces an observable conflict**, never a silent winner.
  One push lands; the other device catches up, finds the remote change on an
  entity it has pending, and records a durable conflict. Both versions exist
  until the user picks.
- **Deletes do not resurrect.** A tombstone is a row, not an absence, so a
  device that never saw the delete still learns about it and does not push its
  stale copy back.
- **Dependencies stay single.** Identity is the `(parentTabId, childTabId)`
  pair, so two devices creating the same logical dependency converge on one row.
- **Collection membership is one object.** Membership travels inside the
  collection payload, so "A added tab X" and "B removed tab X" are two writes to
  the same entity and behave like any other same-entity contention.

A **second device joining an already-synced workspace** goes through the
ordinary path rather than a special one: the explicit upload is refused (the
workspace exists), and the sync that follows pulls the server's stream from
cursor 0. The refusal is not destructive — nothing local changes — but it does
leave the workspace briefly in `conflict` with no conflict records until the
next sync clears it. Smoothing that is a UX question, not a correctness one.

## Retry

| failure | classification | behaviour |
|---|---|---|
| network / offline | retryable | exponential backoff, jittered, capped at 5 min |
| 5xx (incl. a bare 503) | retryable | same |
| 429 | retryable | same — the gate shares the auth rate limiter, so a device with several workspaces can rate-limit itself; "too many" means later, not never |
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

## A workspace's lifecycle

Four situations, and which way the data moves in each:

| this device has | the server has | what happens |
|---|---|---|
| a workspace | nothing | **initial upload** — `migrateWorkspace`, user-initiated |
| nothing | a workspace | **adoption** — `adoptWorkspace`, installs it here |
| a workspace | the same workspace | **adoption as a merge** — see below |
| a workspace | nothing yet reachable | **offline** — local editing continues, unchanged |
| deleted here | the workspace | **deletion** — tombstoned on the server too |
| a workspace | tombstoned there | **deleted elsewhere** — reported, never applied |

Throughout, **the workspace UUID is the identity**. A name is a field like any
other: two workspaces may share one, renaming never re-identifies anything, and
no path matches on name, URL or content.

### Discovery

`GET /api/sync/workspaces` lists the workspaces the session's account owns,
**metadata only**. It exists for exactly one situation: a device that is
signed in and holds nothing locally has no other way to learn that a workspace
is waiting. Contents are not returned — hydration is the ordinary paged pull —
and the response is capped, because "a user has few workspaces" is an
expectation, not a guarantee.

Ownership is the repository's `WHERE user_id = $1`; nothing reads an identity
from the request. A signed-out device asks nothing at all.

The client runs it **once per account**, after render, and adopts only
workspaces this device does not already have. A failure clears the guard
rather than latching, so a device that was offline at sign-in still onboards
later. Startup never waits for it.

### Adoption

```
pull every page from cursor 0 -> apply in memory
  -> commit the workspace -> publish collections/dependencies
  -> persist the cursor
```

**Nothing durable happens until every page has arrived.** A half-installed
workspace is worse than none: it looks real while missing tabs the user cannot
tell are missing. A failure on page three therefore leaves the device exactly
as it was — no workspace, no cursor, nothing to clean up — and the operation
simply runs again. The cursor moves last, for the same reason it does
everywhere else: it is a promise that everything up to it has been
incorporated.

Adoption **cannot become an upload**. `commitRemote` is remote-origin and the
entity channel is the remote channel, so neither marks anything dirty — the
device does not push back what it just downloaded.

### Merging onto a device that already has the workspace

Adoption there is a merge, not a replacement, and it is decided entirely by
identity — never by name, URL or content:

| the entity is | what happens |
|---|---|
| on both sides, unchanged locally | the remote version is applied |
| on both sides, edited locally and not yet pushed | withheld and reported as a conflict; the local edit stands until the user chooses |
| only on the server | imported |
| only on this device | kept **and marked pending**, so the next ordinary pass uploads it |

That last row is the one that used to leak. A local-only entity survived the
merge but nothing ever scheduled it, so it existed on exactly one device
forever — present locally and invisible everywhere else. Adoption now records
what the server actually described and marks whatever is left over as pending
work.

It only ever applies to a device that already held the workspace: one adopting
onto nothing has no local-only entities by construction, so a fresh adoption
still pushes nothing.

Relationships are reconciled, never invented. A local-only tab filed in a
section that exists only on the server uploads as a tab and keeps its
`sectionId`; the section comes down rather than going back up. `buildPush`
already orders sections and groups before the tabs that reference them. A
dependency whose parent tab is not in this workspace is skipped rather than
pushed into a workspace that does not own it.

This is why adoption onto an existing workspace is only ever user-initiated:
automatic adoption could merge server state over pending work the user has not
seen, and that is their decision.

## "Already on the server" is not a conflict

The distinction this phase exists to draw.

When a device asks to upload a workspace the account already owns, the server
answers 409 with `reason: "already-exists"`, and the client classifies it as
its own failure kind. It is **not** a conflict: nothing is contended, no entity
disagrees, and there is nothing for a user to choose between. The client's
correct next move is adoption, so `migrateWorkspace` performs it — the single
visible action does the right thing whichever side happens to hold the data.

Previously this shared the entity-conflict response, which sent the workspace
into `conflict` status carrying **zero conflict records** until a later sync
happened to clear it. The status bar read "0 conflicts" and the panel offered
nothing to resolve.

The 409 reasons are now three, and they mean different things:

| `reason` | meaning | client's move |
|---|---|---|
| `already-exists` | this account owns it and it is already here | adopt it |
| `stale-base` | the workspace moved since you last read | pull, then retry |
| `conflict` | named entities disagree, or a locked placement was moved | surface it; the user chooses |

Authorization failures stay 404 (indistinguishable from "no such workspace"),
malformed requests stay 400, and oversized ones stay 413 — none of those are
conflicts either.

### Three things that are not the same

| | what it means | what the user sees | what they do |
|---|---|---|---|
| **entity conflict** | two versions of one entity, both real | "2 conflicts", with both sides | choose Keep mine or Keep theirs |
| **workspace already exists** | this account owns it and it is already on the server | "Syncing…" | nothing — it adopts |
| **workspace lifecycle event** | the workspace itself was deleted elsewhere | "Deleted elsewhere" | nothing is forced; the local copy stays |

Only the first has two sides to choose between. The other two are facts, and
presenting either as something to resolve asks the user a question with no
answer — which is exactly what "0 conflicts" in the status bar used to be.

## Account switching

Cursors, dirty refs and conflicts are all account-scoped. A different `userId`
reads as a fresh `never-synced` entry rather than inheriting the previous
account's state, which would otherwise push one user's edits at another user's
workspace — or replay a cursor from A against B's stream, asking for changes
that never happened to B.

The journal blob records which account it belongs to, so the isolation is a
property of the stored data rather than of remembering to clear something.
Signing back in as the first account finds that account's pending work intact.

## Device-local, and staying that way

Never synchronized: camera, viewport, selection, sidebar state, graph
positions, boundary offsets, layout cache, the sync journal itself. The graph
store keeps its own key and its own prune; the engine does not touch it.

## Out of scope, deliberately

No WebSockets, SSE or BroadcastChannel. No CRDTs, vector clocks, operational
transforms or event sourcing. No realtime collaboration or presence. No
desktop authentication. No extension synchronization.

## Deleting a workspace

The two directions are deliberately asymmetric, because they are different
statements.

**Deleting it here deletes it everywhere.** The action already tells the user
it removes the workspace and cannot be undone, so the server is told: the push
carries a workspace tombstone and `applyDeletes` sets `deleted_at` on the
workspace row. Without that the workspace stayed on the server after the user
deleted it, discovery kept listing it, and onboarding reinstalled it — the
user deleted a workspace and watched it come back.

The row's **children are left alone**. Nothing can reach them once
`listWorkspaces` excludes the workspace, and tombstoning every row would turn
one deletion into a whole-workspace write and flood the change stream of any
device that had not yet heard about it.

Three details make the deletion durable rather than best-effort:

- The pending deletion is an ordinary journal entry, so it survives a reload.
- A workspace gone from this device is no longer in the local list, so
  `syncAll` also considers workspaces the journal still holds a *deletion*
  for. Only deletions — every other kind of pending work needs a local
  workspace to read, and there is none.
- The ordinary pass refuses to run without a local workspace; the deletion
  takes its own path, which needs no local state and performs no pull.

Once both sides are gone the journal entry is dropped, so creating and
deleting workspaces over time does not grow the blob without bound.

**Deleting it elsewhere does not delete it here.** A workspace tombstone
arriving in a pull moves the workspace to the `remote-deleted` status and
changes nothing else. The local copy, its tabs, its collections and its
dependencies are all exactly as they were. Syncing stops for that workspace —
there is nothing left to agree about — and the control says "Deleted
elsewhere" and explains that nothing has been removed from this device.

Removing a user's workspace as a side effect of a background read is the one
destructive act this design will not perform, so there is no automatic
deletion and no restore flow to need: the local copy simply never left.

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

## The journal's own lifecycle

An entry is created when a workspace first has something to record, updated in
place as work is queued and retired, and **dropped entirely** once the
workspace is gone from both this device and the server. Nothing else removes
one: a workspace that merely has no pending work keeps its cursor, because
that cursor is what makes the next sync incremental.

A different `userId` starts a clean blob rather than merging, so an account's
cursors, pending work, conflicts and pending deletions are invisible to the
next account and intact when the first one returns.

## The remote-entity channel is workspace-scoped

Collections live in one flat localStorage key spanning every workspace, but
the engine only ever reads and applies the syncing workspace's share of it. The
channel event therefore names its workspace (`{ workspaceId, items }`) and the
owning hook replaces only that slice.

It used to publish the slice as though it were the whole store, so a pull in
one workspace dropped every other workspace's collections — and the hook's
persist effect then wrote that loss to disk. Dependencies never had the problem:
the engine reads that store whole, so what it publishes genuinely is the whole
list.

## Observability

The engine takes an optional `log(event, detail)` host hook and calls it at
`sync:start`, `sync:push`, `sync:success`, `sync:conflict` and `sync:error`.
`detail` carries only scalars — workspace id, counts, retry/failure counts,
error *category* — and never a payload, a URL, a cookie, a token or an
authorization header. There is no logging framework; the point is debugging a
sync failure, not analytics.

## How multi-device behaviour is tested

`src/lib/sync/multi-device.test.ts` drives **two real `SyncEngine` instances**
against one shared in-memory server (`multi-device-server.ts`) that implements
the wire contract: cursor semantics, the strict stale-base gate, the
locked-section rule, tombstones, version-boundary paging, and 404 for a
workspace the caller does not own. Each device keeps its own journal blob, so
"device reloads" restores that device's own durable state.

That server is **not a database**. It proves nothing about transactions,
`FOR UPDATE`, foreign keys or cascades. What it proves is the client half:
that two devices converge, that conflicts surface instead of resolving
themselves, and that no path silently drops an edit. Every rule it implements
names the production code it mirrors, so drift is visible.

## Four kinds of verification, kept apart

These are not interchangeable, and this document never uses one word for
another.

| Tier | What it means | Where |
| --- | --- | --- |
| **Structural** | Source or config read as text and asserted against | `schema.test.ts`, `desktop-no-sync.test.ts` |
| **Recording-fake** | Production code run against a fake that records statements instead of executing them | `repository.test.ts`, `service.test.ts`, `multi-device.test.ts`, `sync-routes.test.ts` |
| **Real PostgreSQL** | Production code executed against a genuine PostgreSQL server | the `*.pg.test.ts` suites |
| **Authenticated runtime** | A signed-in browser driving the deployed app | **not done — see limitations** |

## Real PostgreSQL integration

**Real PostgreSQL integration is available and is part of the test suite.**

The earlier "no Postgres in this environment" limitation is gone. There is
still no `psql`, Docker, Podman or WSL on the development machine, but the
`embedded-postgres` dev dependency ships the official PostgreSQL binaries for
the host platform, and they run as an ordinary user process with no
administrator rights. `test/pg/` boots one real server per test run:

- `cluster.ts` — `initdb`, start on an OS-assigned free port, apply both
  schemas to a template database. The data directory is a temp directory
  discarded on stop, and the superuser password is generated per run, so there
  is no credential in the repository. It never reads `POSTGRES_URL` or
  `DATABASE_URL` and so **cannot** reach a real or production database.
- `global-setup.ts` — boots the cluster once for the whole suite. It **fails
  soft**: a machine that cannot host a server gets a normal run with the
  integration suites skipped and the reason printed, rather than a broken one.
- `database.ts` — `describePostgres` (skips the block, loudly, when no cluster
  booted) and `freshDatabase()` / `emptyDatabase()`, which clone a fresh
  database per test from the migrated template. Every test gets its own
  database, which is what lets the concurrency suites run genuinely
  independent connections against the same rows.

### What is now verified against a real server

- **Migration.** `npm run migrate:auth` and `npm run migrate:sync` are run as
  child processes against an empty database — the real scripts, not a copy.
  All expected tables, indexes and constraints exist afterwards; the
  auth-before-sync ordering guard fires and leaves nothing behind.
- **Idempotency.** A second run of both scripts changes no table, index or
  constraint, adds no duplicate under a generated name, and preserves existing
  rows.
- **Ownership and the same-workspace invariant.** The composite foreign keys
  really do make a cross-workspace section, group, collection member or
  dependency unrepresentable, and re-upserting a foreign id is a no-op rather
  than a workspace-transfer primitive.
- **Deferred constraints.** A tab may reference a section written later in the
  same transaction.
- **Transactions.** A failure late in a multi-entity push rolls back every
  earlier write *and* the counter bump; a successful one commits under a
  single shared version.
- **The workspace lock.** Two concurrent pushes serialize on `FOR UPDATE`: the
  second is observably parked until the first commits. A burst of six
  concurrent pushes yields six distinct, gapless versions with no lost update.
- **Creation races.** Several simultaneous first uploads produce exactly one
  creation and deterministic `already-exists` answers for the rest.
- **Deletion races.** An update racing a workspace deletion never resurrects
  it, and a stale push is refused as `stale-base`.
- **Tombstones.** Every entity type's deletion survives as a row, reaches a
  second device through a pull, and is not undone by a stale push.
- **Cursors and paging.** Boundaries at `0`, `current`, `current - 1` and
  beyond `current`; no change skipped, duplicated or out of order; a
  transaction is never split across pages; a dropped page resumes safely.
- **Account isolation.** Discovery, pull, push and deletion are all
  indistinguishable-not-found for another account — byte-identical responses —
  and a foreign id cannot be smuggled through a nested entity.
- **Sessions.** Expired, revoked and forged tokens are rejected against real
  session rows, an expired row is deleted on sight, and only the SHA-256 hash
  is ever stored.
- **Error semantics.** `already-exists`, `stale-base`, `conflict`,
  `not-configured` and a sanitized 500 are all distinguishable, and a real
  constraint violation leaks no SQL, table name, constraint name or connection
  detail.
- **Connections.** Success, rollback, ownership refusal, stale base and failing
  pulls all return the client; a pool of two survives eight of each, and no
  connection is handed back `idle in transaction`.

### Four defects this found

Each was a real fault in code that passed the fake-backed suites.

1. **A creation race returned a 500.** `initial()` checked ownership and then
   inserted, as two statements. A second device uploading the same workspace
   concurrently — or any upload naming an id another account owns — lost the
   insert and the raw `unique_violation` escaped as an internal error. Now
   caught and resolved into the existing contract: `already-exists` with the
   real cursor when the caller owns it, and a bare `conflict` when another
   account does, which refuses without confirming that workspace exists or
   leaking its cursor.
2. **A pull could tear across a commit.** `pull()` read six tables on a pooled
   connection with no transaction, so each read saw its own snapshot. A push
   landing mid-pull was invisible to the earlier reads and visible to the
   later ones, so a page could carry a version's dependency but not its tab
   while `nextCursor` advanced past it — silent, permanent loss of the missing
   half. The reads now share one `REPEATABLE READ READ ONLY` snapshot.
3. **A version larger than a page was truncated.** One push may write up to
   `SYNC_LIMITS.entitiesPerPush` (10,000) rows under a single version, while a
   page is 500 and each table was read with `LIMIT limit + 1`. When such a
   version opened a page it could never be collected whole, yet the page ended
   at it and `nextCursor` moved past — so an initial upload of a 600-tab
   workspace silently lost 99 tabs on the second device. Such a version is now
   re-read in full without a limit.
4. **Six queries raced on one connection.** `readEntityVersions` issued its
   reads with `Promise.all` on a single `PoolClient` inside the push
   transaction. `pg` serialized them with a deprecation warning and removes
   that behaviour in `pg@9`. They are now sequential.

A fifth, smaller one: `pull`'s `limit` parameter inferred the literal type
`500` from its `as const` default, so no caller could legally pass another
page size.

## Known limitations

- **Desktop sync is inert**, because the static export ships no API routes and
  therefore has no session. This is the intended state, and it is now
  confirmed by building rather than by reasoning: `npm run desktop:export`
  emits only the six static routes with no `api/` directory at all, while the
  web build serves all four `/api/sync/*` handlers, and `cargo check` on
  `src-tauri` compiles clean. (Cargo runs on this machine after all — the
  "Application Control blocks Cargo" note from earlier phases is out of date.
  A full `tauri build` producing an installer was still not run.) The client
  sync module is bundled but can never activate: `auth/client.ts` returns the
  signed-out-by-design state on desktop, so `useSyncEngine` receives a null
  user and short-circuits before any request.
- **The integration suites need a host that can run the PostgreSQL binaries.**
  Where they cannot, the suites skip with a printed reason and the rest of the
  suite runs normally. A skipped run proves nothing about the database — read
  the output, not this document, to know which happened.
- **`embedded-postgres` is pinned to a beta** (18.4.0-beta.17), the current
  release for this platform. It is a test-only dependency and never ships.
- **The integration suites run against PostgreSQL 18.4.** Behaviour that
  differs by major version is verified only for that one; a deployment on a
  different major is not covered by these tests.
- Workspace deletion is still not part of the push surface; tombstoning a
  whole workspace needs a decision about its children that belongs with the
  deletion UX.
- **No authenticated runtime verification.** This is still true, and the real
  database does not change it. The `*.pg.test.ts` suites drive the real route
  handlers with real Postgres-backed sessions, which is strictly more than
  before — but nobody has signed in through a browser with a Google client ID
  and watched two devices exchange a workspace. That needs Google OAuth
  credentials and a deployed origin, neither of which exists here. **Sign-in →
  create → sync → reload → edit → sync → delete was not runtime verified**, and
  no claim is made that a live two-client exchange was observed.
- **A workspace deleted on another device is never removed from this one.**
  That is deliberate, not a gap — but it does mean a user who deletes a
  workspace on one device still has to remove it on each other device. There
  is no "apply this deletion here" button; the status explains the situation
  and the copy stays until they delete it themselves.
- **Deleting a workspace is not reversible from inside the app.** The action
  says so. There is no trash or restore flow, and this phase deliberately did
  not build one; the protection is that a deletion is never automatic.
