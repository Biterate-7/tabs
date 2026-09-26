# Phase 11 — Agent Command Center Foundation

The provider-agnostic agent domain: the data model and local state Hubble
needs in order to *represent* work done by an external coding agent.

**Phase 11 does not integrate Claude Code.** It reads no files, watches no
directories, parses no transcripts and starts no processes. What it provides
is the domain that a later phase's observer will feed, plus the read-only seam
that observer must plug into.

## Why this phase exists

Hubble wants to show what an agent has been doing alongside the tabs it was
doing it with. That needs somewhere to put the answer before anything can go
looking for it. Building the observation first would have meant inventing the
model one provider-specific field at a time, which is how a domain ends up
shaped like whichever tool was integrated first.

So the model comes first, and it is deliberately ignorant of every provider.

## Domain model

```
Agent                      a persistent identity ("Claude Code")
  └── AgentRun             one session of that identity, inside a workspace
        ├── AgentRunLink   this run touched this tab
        └── AgentEvent     a bounded, safe activity log
```

| File | Responsibility |
| --- | --- |
| `src/lib/agents/types.ts` | Entities, statuses, roles, event kinds, bounds, failure reasons |
| `src/lib/agents/registry.ts` | Agent identities: create, read, update, delete, cascade delete |
| `src/lib/agents/runs.ts` | Run creation, metadata, the transition policy, delete cascade |
| `src/lib/agents/links.ts` | Run↔tab links, and the workspace boundary check |
| `src/lib/agents/events.ts` | Append, dedupe, order and cap the activity log |
| `src/lib/agents/persistence.ts` | Account-scoped localStorage, with sanitisation on read |
| `src/lib/agents/selectors.ts` | Read-only views for future UI consumers |
| `src/lib/agents/adapter.ts` | The observation seam, plus provider-agnostic normalisation |
| `src/lib/agents/mock-adapter.ts` | An in-memory adapter, for tests only |
| `src/hooks/use-agent-store.ts` | React access: load, mutate, persist |

Every function in `src/lib/agents/` outside `persistence.ts` is a pure reducer
over `AgentState`. None reads the clock — callers inject `now`, which is the
rule `src/lib/reducer-purity.test.ts` already enforces for the other domains
and the reason a later sync pass can replay them.

### Agent vs. AgentRun

An `Agent` is an identity and outlives any session; an `AgentRun` is one
session. One agent has many runs.

Minting an agent per session would be the central modelling mistake available
here: it would make "how much has this agent done in this workspace"
unanswerable and grow the registry without bound. `findAgentByProvider` is how
an adapter resolves *its* identity rather than creating a second one.

Agents are account-scoped. Runs are workspace-scoped.

## Run lifecycle

Six statuses. Two are live, four are terminal:

```
live      working, waiting
terminal  completed, failed, blocked, cancelled
```

The whole transition policy:

- a terminal run does not transition at all;
- the two live states may swap freely;
- a live state may end in any terminal state.

`endedAt` is stamped exactly when a run reaches a terminal status, and is
absent while it is live. `loadAgentState` reconciles the two on read in both
directions — a terminal run always has a timestamp, a live one never does —
rather than trusting them independently.

`blocked` is terminal in this phase. A run that needs something it cannot get
has stopped. If a later phase wants "paused, may resume", that is a new live
state, not a loosening of this one.

Two deliberate details, both aimed at the pollers a later phase adds:

- **Re-asserting a live status is a no-op that succeeds**, leaving `updatedAt`
  untouched. A session reporting "still working" every few seconds must not
  rewrite the record, and so retrigger every consumer, each time.
- **Re-asserting a terminal status is refused** with `terminal-run`, distinct
  from `invalid-transition`, so a caller can tell "this run is over" from
  "that particular hop isn't allowed".

## Workspace boundary

`AgentRunLink` is the only place a run reaches outside itself, and it is the
place the boundary is enforced:

```
addRunLink(state, { runId, tabId, role, tabWorkspaceId }, now)
  → cross-workspace  when run.workspaceId !== tabWorkspaceId
```

`tabWorkspaceId` is **supplied by the caller**, not looked up. This domain
does not import the workspace store and must not: inferring a tab's workspace
from ambient state — the active workspace, a name match, the nearest graph
node — is exactly the guess that would file a link in the wrong place. The
caller knows which workspace it read the tab from, so it says so, and the
domain holds it to it.

`updateRun` deliberately cannot change `workspaceId`, because moving a run
between workspaces would strand its links on the far side of the boundary. It
also cannot change `status`, because that would be a second, unguarded door
into the field `transitionRunStatus` exists to protect.

### Link roles

`context` — the tab was input for the run. `produced` — the run worked on it.

Link ids are derived from `(runId, tabId, role)`, the same approach
`dependencyId` takes, which makes linking idempotent for free: re-adding
returns `created: false` and the untouched state. Role is part of the identity,
so one tab can be both `context` and `produced` for a run — the agent read a
page and then edited it — which is a real situation, not a duplicate.

Deleting a run deletes its links and events. Deleting an *agent* is refused
while runs exist; `deleteAgentAndRuns` is the explicit destructive
counterpart, separate rather than a boolean flag so the intent is
unmistakable at the call site.

## Events and retention

```
MAX_EVENTS_PER_RUN = 200
MAX_SUMMARY_LENGTH = 200
```

The cap is applied on write **and** re-applied on read, because persisted
state is not necessarily state this build wrote — an older build with a
different limit, a restored backup, a hand-edited file. Without the read-side
cap, one oversized array read once would keep being written back at full
length.

Events are bounded in three directions: how many a run keeps, how long one
summary may be, and what an event may say at all (a closed set of kinds plus a
plain string). There is nowhere to put a prompt, a tool result, a shell
command or a model's reasoning, and that absence is the design — a provider
reduces its records to a safe summary *before* calling in, and the domain has
no field that would accept the raw thing.

`sourceId` carries a provider's stable id for the record an event came from.
Appending the same `sourceId` twice to one run appends nothing, which is what
lets a poller re-read the same source without duplicating history.

Appends are permitted on a terminal run: the event recording a run's end is
itself appended after the status change, and a log is a record of what
happened rather than a live control surface.

## Persistence

Namespace: `tabdump:agents:v1`, registered in `SCOPED_STORAGE_KEYS`.

Local only — no server, no sync, no Postgres. Signed out the key is literal;
signed in it is prefixed with the account, which is what keeps two accounts
sharing a browser from sharing agent history. Registering it also means
signing in carries anonymous agent state into the account alongside workspaces
and collections.

Loading never throws. Every entity is validated on read, and each layer is
validated against the one above it, so dangling references are dropped rather
than persisted back out:

- an agent needs an id, a provider, a name and a valid `createdAt`;
- a run needs an agent that exists, a workspace, a known status;
- a link needs a run that exists and a known role;
- an event needs a run that exists, a known kind, a finite timestamp and a
  non-empty summary.

A missing `updatedAt` falls back to `createdAt` — unchanged since creation,
which is the honest reading — rather than epoch zero.

### Unknown schema versions

`loadAgentState` returns a status, not just state:

| status | meaning |
| --- | --- |
| `empty` | nothing stored, or stored state was unusable |
| `loaded` | state read and sanitised |
| `unsupported` | written by a **newer** build than this one |

On `unsupported` the hook marks itself read-only and stands down from saving.
An older tab that happens to open the key cannot flatten agent history it does
not understand. The user still gets a working session; they just do not get to
overwrite real data with it.

## Account isolation

Enforced at the persistence layer via `scopedKey`, the same mechanism
workspaces and collections use, and tested through the real load/save
functions rather than the key helper: Ada's agents, runs, links and events are
invisible to Grace, the signed-out domain is invisible to both, and signing
out returns the anonymous one untouched. No module-level state ignores the
namespace.

## The adapter seam

```ts
interface AgentAdapter {
  readonly provider: string
  subscribe(observer: AgentObserver): AgentAdapterUnsubscribe
}
```

**The omissions are the design.** There is no `start`, `stop`, `kill`,
`prompt`, `sendMessage`, `exec` or `write`, and none may be added. Hubble
observes agents; it does not drive them. An adapter that could control a
coding agent would make this app a remote-execution surface for anything that
could reach its state — a categorically different and much more dangerous
product than the one being built.

Everything an adapter knows arrives as `AgentAdapterObservation`: provider,
external id, and optional workspace, status, title, activity, project key, git
branch, source id, url and timestamp. Two notes on that list:

- `projectKey` is explicitly **not** a filesystem path. A provider that knows
  an absolute path should key it before putting it here, so local directory
  layout does not travel with the observation.
- `url` stays a URL rather than a tab id, because resolving one to a tab needs
  the workspace's tabs, which this domain does not import. The caller resolves
  it and calls `addRunLink`; an unmatched URL links nothing.

`ingestObservation` is the provider-agnostic fold, kept here so every adapter
gets the same behaviour instead of each reimplementing it:

- identity is `(agentId, externalId)`, so observing one session repeatedly
  updates one run rather than minting a new one;
- absent fields are *no news* and never erase what is known;
- a refused transition is not an ingest failure — a finished run re-reported
  as working is a stale observation, not a corrupt one, and the rest of the
  observation is still kept;
- **an observation with no workspace creates nothing.** It is reported as
  `unattached`, a success. A session discovered before its project is mapped
  to a workspace can attach later, on a subsequent observation.

## Security boundary

`src/lib/agents/security.test.ts` enforces this mechanically rather than by
review, in the spirit of `no-tauri-in-web.test.ts`. Nothing under
`src/lib/agents/` (nor `use-agent-store.ts`) may:

- import `child_process`, `node:fs`, `node:os`, `node:path`, `node:net`,
  `node:http(s)`, `node:worker_threads`, `node:vm` or `server-only`;
- contain `spawn(`, `exec(`, `execFile`, `execSync`, `fork(`, `readFileSync`,
  `writeFileSync`, `createReadStream`, `eval(` or `new Function(`;
- run a git command or mention a terminal;
- reference `~/.claude`, a provider's session/project directories, or
  `homedir()`;
- touch any storage key but its own;
- make a network request (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`).

The distance between "represents" and "performs" is the entire safety story of
this feature, and it is not self-enforcing. A single `child_process` import
added later — to "just check the git branch", or to "just stop a stuck run" —
would silently cross it.

## What Phase 11 deliberately does not implement

No Claude Code reader, `~/.claude` access, JSONL parsing, session discovery,
filesystem watching or polling. No git integration, commit model, file or
artifact model. No spatial command center, graph physics, agent nodes, cards,
dashboard or notifications. No execution controls of any kind. No WebSockets,
remote agents, multi-agent orchestration or AI-generated summaries. No sync
and no server persistence.

No UI at all: the store is infrastructure for later phases.

## Verification

### Baseline, at `34331b3` with a clean tree

| Gate | Result |
| --- | --- |
| Tests | 2774 passed / 91 skipped / 0 failed, 210 files |
| Lint | clean |
| Typecheck | **1 pre-existing error** (below) |
| Build | fails, on that same pre-existing error |

### Known pre-existing typecheck issue

```
test/pg/cluster.ts(88,54): error TS2307: Cannot find module 'embedded-postgres'
```

`embedded-postgres` is an optional dependency not installed in this worktree.
It is also why 91 suites skip rather than the 17 some earlier notes claim: the
Postgres-backed tests self-skip when the package is absent. **Not touched by
this phase** — it is unrelated to the agent domain.

It also fails the production build, because `next build` runs the same `tsc`.
The application itself compiles ("Compiled successfully in 5.8s"); the build
then stops at the type-check step on this one error. That this is pre-existing
rather than introduced here is verifiable directly:

- the failing import is present at baseline in
  `git show 34331b3:test/pg/cluster.ts` (line 88);
- `test/pg/cluster.ts` is unmodified by this phase;
- nothing under `src/` references `embedded-postgres`.

Installing the package (or fixing the import) would make the build pass, but
that is unrelated work and was deliberately left alone.

### After Phase 11

| Gate | Result |
| --- | --- |
| Tests | 2915 passed / 91 skipped / 0 failed, 219 files |
| Lint | clean |
| Typecheck | same 1 pre-existing error, no new ones |
| Build | app compiles; still blocked by that same pre-existing error |

141 tests added across 9 files; zero regressions. Every gate is exactly where
the baseline left it, apart from the added tests.

### Test coverage

| Suite | Covers |
| --- | --- |
| `registry.test.ts` | Agent CRUD, delete-refusal with runs, explicit cascade |
| `runs.test.ts` | Creation, ownership, metadata stickiness, the full transition matrix, terminal protection, `endedAt`, delete cascade |
| `links.test.ts` | Both roles, same-workspace success, cross-workspace rejection in both directions, idempotency, pruning, reverse lookup |
| `events.test.ts` | Append, ordering, `sourceId` dedupe, the 200-cap, defensive read cap, out-of-order retention, terminal-run appends |
| `persistence.test.ts` | Round trip, schema versions, corrupt/hostile state, account isolation, quota failure |
| `adapter.test.ts` | Seam shape, subscribe/unsubscribe, unattached→attached, identity, incremental observation, status handling |
| `security.test.ts` | Forbidden imports, call shapes, git/shell, `~/.claude`, storage keys, network, adapter surface |
| `verification.test.ts` | The end-to-end sequence, twice: manual run, and observed session |
| `use-agent-store.test.ts` | The same scenarios through the real React hook and real localStorage |

### On manual verification

Phase 11 ships no UI by design, so there is no screen to click through. The
verification sequence was instead executed against the **real React hook and
real localStorage** in `src/hooks/use-agent-store.test.ts`: create an agent,
create a run in a workspace, add context and produced links, append events,
move through `working → waiting → working → completed`, reload on a fresh
mount, delete the run, confirm the cascade, confirm the agent survives, switch
account namespace and confirm isolation, and confirm a cross-workspace link is
rejected.

That exercises the actual runtime path a UI would use. It is not a substitute
for clicking a screen, and no screen exists yet to click.

## Next phase

Phase 12 — the real Claude Code read-only adapter — implemented against
`AgentAdapter` and `ingestObservation`, with the reader, parser and normaliser
living entirely outside `src/lib/agents/`.

Source-format discovery for that phase was carried out separately and is
recorded in `docs/phase-12-real-claude-code-adapter.md`; the formats there
should be re-verified rather than trusted, since the installation may have
moved on.
