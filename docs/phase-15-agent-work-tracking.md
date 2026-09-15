# Phase 15 — Agent work tracking and spatial progress

Phases 11–14 established *who* an agent is, *when* it ran, *what files and
tabs it touched*, and *where that sits on the canvas*. What they could not
answer is the question a user actually asks: **what is it working on?**

Phase 15 adds one domain concept to answer it — the `AgentWorkItem` — plus the
observation, persistence, spatial, inspector and search surfaces that make it
visible.

It remains strictly observational. Nothing added here can start, stop, prompt,
retry, assign or otherwise drive an agent, and the seams are shaped so that
none of those can be added without deleting a documented invariant first.

---

## 1. The domain model

```ts
type AgentWorkItemStatus = "pending" | "active" | "blocked" | "completed" | "cancelled";

type AgentWorkItem = {
  id: string;
  workspaceId: string;
  runId: string;
  externalId?: string;        // the provider's own id, opaque, never rendered
  title: string;
  summary?: string;
  status: AgentWorkItemStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  progress?: { completed: number; total: number };
};
```

Defined in `src/lib/agents/types.ts`; operations in
`src/lib/agents/work-items.ts`.

### Why `workspaceId` is denormalised

`createWorkItem` takes a `runId` and **no workspace at all** — the workspace is
read from the run. A caller therefore *cannot* file a work item into a
workspace its run does not belong to, because it never gets to name one. The
cross-workspace check `links.ts` has to perform at runtime is, here,
structurally impossible to fail.

The field is still stored rather than joined through the run at read time, for
the same reason `AgentRun` carries one: a selector that had to join to know
which workspace an item belongs to would be one refactor away from leaking
across the boundary.

### Why the status vocabulary differs from `AgentRunStatus`

Deliberately, in two places:

| | `AgentRunStatus` | `AgentWorkItemStatus` |
|---|---|---|
| `blocked` | **terminal** — the session stopped | **not terminal** — it can be unblocked |
| `pending` | does not exist — a run exists because a session started | exists — work can be known about before anything is done |

Collapsing them into one vocabulary would force one of those two truths to be
wrong.

---

## 2. Lifecycle

```
pending ──▶ active ──▶ completed
              │
              ├──▶ blocked ──▶ active
              │
              └──▶ cancelled
```

The complete policy (`ALLOWED_TRANSITIONS` in `work-items.ts`):

| from | may become |
|---|---|
| `pending` | `active`, `cancelled` |
| `active` | `blocked`, `completed`, `cancelled` |
| `blocked` | `active`, `cancelled` |
| `completed` | — |
| `cancelled` | — |

Two rules shape it:

- **`cancelled` is reachable from every live state.** Abandoning work that was
  never started is ordinary.
- **`completed` is reachable only from `active`.** An item cannot finish
  without having been worked on. Allowing `pending → completed` would let a
  provider mark work done that was never observed being done.

**There is no reopening.** A provider re-reporting a finished item as active is
a stale observation, not a resurrection.

### Timestamps

| event | effect |
|---|---|
| creation | `createdAt = updatedAt = now` |
| created directly `active` | `startedAt = now` |
| created directly `completed`/`cancelled` | `completedAt = now`, **no `startedAt`** |
| first transition to `active` | `startedAt = now`, only if absent |
| `active → blocked → active` | `startedAt` **not** rewritten |
| transition to `completed`/`cancelled` | `completedAt = now` |
| re-asserting a live status | **no-op**, returns the identical state object |
| re-asserting a terminal status | refused (`invalid-transition`) |
| invalid transition | refused, state untouched |

An item discovered *already finished* gets no `startedAt`. It plainly started
at some point, but nothing observed when, and stamping `now` would assert a
beginning that is merely the moment TabDump happened to look. This is the same
under-claiming principle that makes Claude Code's `Write` map to `edited`
rather than `created` (Phase 13).

The no-op on re-assertion matters operationally: an observer reporting "still
active" every five seconds must not rewrite the record and retrigger every
consumer downstream of it. The test asserts object identity, not just equality.

---

## 3. Progress — the part most likely to lie

Two different things are called progress, and only one is stored.

**`AgentWorkItem.progress`** is *explicit provider-counted* progress. It exists
only for providers that literally count something. It is never derived from
event volume, tool-call counts, elapsed time, or transcript position. A
provider that cannot count leaves it `undefined`, and every consumer then omits
the indicator rather than rendering a fabricated ratio.

`normalizeWorkItemProgress` **drops** a ratio that fails validation (zero
total, negatives, non-integers, `completed > total`) rather than clamping it. A
provider that sent `12/10` has a bug; silently rendering `10/10` would turn its
bug into a false claim that the work is finished.

**Derived run progress** (`getRunWorkProgress`) is the only progress TabDump
computes, and it is evidence-based by construction: `total` is how many work
items actually exist, `completed` is how many actually reached `completed`.
Cancelled items count toward neither side, so a plan whose last two items were
abandoned can still read as finished. A run with no work items gets
`undefined`, never `0 / 0`.

**Claude Code never supplies explicit progress.** Its task tools carry no
counts. So in practice `AgentWorkItem.progress` is always `undefined` for the
one provider that ships, and the ring on a run card is driven entirely by the
derived count of real item statuses.

---

## 4. Observation

The provider-neutral shape (`src/lib/agents/adapter.ts`):

```ts
type ObservedWorkItem = {
  externalId?: string;
  title?: string;              // absent = update-only, can never create
  summary?: string;
  status?: AgentWorkItemStatus;
  progress?: { completed: number; total: number };
};
```

carried on `AgentAdapterObservation.workItems`.

`title` being optional is the load-bearing detail. An entry with no title can
only ever **update** an item that already exists. That lets a provider report
"task 3 is now complete" on a later poll than the one that named task 3,
without either inventing a placeholder name or losing the update. An entry with
neither a title nor a match is **dropped** — no evidence, no work item.

Ingestion rules (`applyWorkItems`):

- **Identity is `(runId, externalId)`.** Provider task ids are frequently
  session-scoped small integers and collide constantly across runs; scoping by
  run is what keeps two sessions' task `"1"` apart.
- **Absent fields are no news** and never erase what is known.
- **A refused transition is not an ingest failure.** Existing state is
  preserved and the rest of the observation still applies.
- **Nothing is ever closed by omission.** An item missing from a poll's list is
  an item that poll said nothing about. This is the Phase 12 rule restated at
  the work-item level: a session going quiet, a transcript ending, a process
  becoming idle, a `.desktop-released.json` sidecar appearing, or a task
  falling out of a list is **not** evidence that anything finished.

---

## 5. Claude Code mapping

### What the provider actually exposes — the survey

Measured against the 148 real transcripts in `~/.claude/projects/` on the
development machine:

| tool | transcripts using it | verdict |
|---|---|---|
| `TodoWrite` | **0** | never fires. Its 146 textual occurrences are the tool listing inside system prompts; the `todos` key appears **0** times. |
| `TaskCreate` / `TaskUpdate` | **2** | real, structured, usable |
| `mcp__ccd_session__spawn_task` | several | **forbidden** — carries a raw `prompt` field |

So work-item evidence from Claude Code is **real but rare**. Most sessions
produce none, and the system is built to say so rather than to compensate.

### The two tools that are read

```
TaskCreate  { subject, description }      → title, summary
TaskUpdate  { taskId, status }            → status
```

`subject` and `description` are the human-readable task text Claude Code
renders in its own UI. They are not a prompt, not a command, not a tool result
and not hidden reasoning — all of which live in fields the parser has no branch
for.

Reading them is the **existing Phase 12 pattern**, not a new liberty: the
parser already reads named structured input keys (`file_path`, `path`,
`notebook_path`, a shell tool's `description`, `url`). Phase 15 adds four keys
across two explicitly named tools to that allowlist. The Phase 12 allowlist is
not otherwise weakened.

### What is deliberately not read

`mcp__ccd_session__spawn_task` carries a `prompt` field holding raw
instructions and frequently code. It is **not** in the tool allowlist and must
never be added. The allowlist is two exact tool names rather than a pattern
precisely because a pattern such as `/task/i` would have matched it.

Also never read, here or anywhere: `thinking`, `toolUseResult`, `old_string`,
`new_string`, `content`, `command`, `messagingSocketPath`.

### Task identity — the ordinal, and why it is safe

`TaskUpdate` refers to tasks by a small integer that `TaskCreate` never writes
into its own input; the id is assigned by the tool and returned in its
**result**, which this feature does not read. So identity is re-derived from
creation order: **the Nth `TaskCreate` in a session is task N, 1-based.**

This was verified against real data, not assumed. In one surveyed transcript,
11 `TaskCreate` calls were followed by `taskId` 1 through 11, each moving
`in_progress` then `completed`, in exactly creation order (subjects elided —
they are the surveyed user's own project content, and only the shape matters):

```
 1  TaskCreate  "<subject 1>"
 …
11  TaskCreate  "<subject 11>"
12  TaskUpdate  taskId "1"  in_progress
13  TaskUpdate  taskId "1"  completed
14  TaskUpdate  taskId "2"  in_progress
 …                                        (through taskId "11")
```

A second transcript showed the same correspondence at 4 creates. Re-run the
survey with the procedure in §15 rather than trusting this table.

The counter lives in the server-owned cursor (`ClaudeTranscriptCursor.taskOrdinal`),
because the cursor is the only per-session state that survives a poll.

**It fails safe, not wrong.** When a session is first seen mid-transcript, the
early creations are outside the tail window, the ordinal starts behind, and
updates for tasks that were never observed match nothing — so the domain
records nothing for them rather than attaching a status to the wrong title.
A forged ordinal in a tampered cursor can only cost work items, never
mis-attach one: matching is always scoped within a single run.

### Status mapping

| Claude Code | TabDump |
|---|---|
| `in_progress` | `active` |
| `completed` | `completed` |
| anything else | **no status change** |

Nothing maps onto `blocked` or `cancelled`, because Claude Code writes neither.
Inventing a mapping would manufacture states that were never observed.

### Path redaction in task prose

Task subjects and descriptions are prose a model wrote, so unlike a `file_path`
they cannot simply be resolved against a project root. `redactAbsolutePaths`
removes drive-letter paths (`C:\Users\…`), UNC shares (`\\server\share`), and
well-known POSIX roots (`/home/…`, `/Users/…`, `/root`, `/var`, `/tmp`,
`/opt`, `/etc`), replacing each with `[path]`.

It deliberately leaves `/api/users` alone — that is overwhelmingly an API route
rather than a filesystem path, and redacting it would mangle ordinary task text
to guard against nothing.

---

## 6. Spatial representation

**Work items are not spatial nodes.** They never appear in
`AgentSpatialScene.nodes`; they live on `AgentSpatialScene.workItems`, a list.

This is the whole of Phase 15's spatial footprint, and it is what makes the
stability invariant structural rather than a matter of care:

- `placeAgentScene` reads only `scene.nodes`, so a work item has **no
  position** and cannot be placed, drawn as a card, or hit-tested.
- The tab force simulation consumes `GraphNode`, an entirely separate model the
  agent layer never touches. Agent nodes were already outside d3-force
  (Phase 14); work items are outside even the agent layer's arithmetic
  placement.
- Therefore adding, completing or deleting a work item **cannot** move a tab,
  a run, an agent or a file node. The tests assert this over 13 runs × 8 items.

What *is* added to the canvas is small and lives inside the run card's existing
bounds:

- a **progress ring** in the top-right corner, drawn only when the run has
  countable work items;
- the fraction written beside it as **text** (`3/7`), so the ring is never the
  only signal;
- the **primary work item's title** as the card's detail line, preferred over
  the raw activity line because "what is being worked on" beats "what happened
  a second ago";
- an `N items` count in the card's meta row.

The ring does not animate. Progress changes on completion, not continuously, so
there is nothing for motion to express — and the working-status dot remains the
only moving thing on the canvas.

### The primary work item

Derived, never stored. There is no `isPrimary` flag, because a flag would have
to be maintained on every transition and would go stale the moment an item
finished. The rule is attention order:

```
active > blocked > pending > completed > cancelled
```

ties broken by creation order. A run with no items has no primary, and the
card then shows no work subtitle at all.

---

## 7. Inspector

`buildInspectorSelection` gains a fourth selection kind, `workItem`, alongside
`agent`, `run` and `artifact`. Selecting a work item shows:

- title, summary, status (glyph **and** word)
- explicit progress, only when it exists
- owning run — as a **control**, so selection can be returned in one keystroke
- agent name and provider
- started / updated / completed times, each only when present
- the run's files, tabs and recent events

A run's own selection gains a **WORK** section listing its items with a tally
(`1 of 2 done`), each row selectable.

Every referent is optional and every fallback is honest: a run deleted out from
under a selected item renders `Untitled run`, a missing agent renders `Agent`,
a deleted tab renders `Deleted tab`. A work item the scene no longer holds
returns `null`, which the panel renders as its ordinary "nothing selected"
state. Nothing throws.

---

## 8. Search

Extends Phase 14's matcher — no second search engine, nothing indexed, nothing
fetched. Results are typed: `Agent`, `Agent run`, `File`, **`Work item`**.

Searchable fields are an **allowlist**: title, summary, status, and the status
label as the UI spells it (so typing "blocked" finds blocked work).

Not searchable, by omission: `workItemId`, `runId`, both spatial ids, and
`externalId` — the provider's task id is not even present on the scene-side
summary, so there is nothing to exclude.

Work items rank **above** runs: someone searching agent work usually wants what
is being done before which session is doing it.

Search is scoped to the scene, which gives workspace scoping and filter scoping
for free — every result corresponds to something that can actually be selected.

Selecting a work-item result:

1. selects the work item,
2. focuses its **owning run** spatially — via `runIdForWorkItemSelection`,
   using the existing focus abstraction, because the item itself has no
   position,
3. opens the inspector.

---

## 9. Filtering

**There is no second filter state.** Work items inherit their owning run's
visibility from the existing `AgentSpatialFilter`:

> A work item is listed when its run passes the current filter, and hidden when
> it does not.

An item detached from its run's visibility would be a row the user cannot
navigate to. Filtering affects visibility only; it never mutates domain state,
and it persists through the existing agent-layout store.

---

## 10. Persistence

Work items are stored as an additive `workItems` array inside the **existing**
`tabdump:agents:v1` record — not a separate namespace.

This is a deliberate deviation from the phase brief's suggested
`tabdump:agent-work-items:v1`. The repository's actual scoped-storage
architecture keeps the whole agent domain in one atomically saved record, and
`artifacts`/`artifactLinks` were added the same way in Phase 13. Splitting work
items into a second key would create two records that can disagree — a work
item whose run was rolled back, or vice versa — and there is no transaction to
prevent it.

Guarantees, all re-established on read because **storage is not a trust
boundary**:

- account-scoped through `scopedKey`, so one account's work is invisible to
  another;
- schema-versioned; a **newer** version fails closed (`unsupported`) and the
  store stands down rather than overwriting data it does not understand;
- an item whose run is gone is **dropped**;
- an item whose `workspaceId` disagrees with its run's is **dropped** — that
  could only arise from editing the file, and honouring it would be the exact
  cross-workspace leak this phase must not have;
- timestamps are **reconciled** with status rather than trusted independently;
- titles are re-normalised and bounded; untitled items are dropped;
- invalid progress is dropped while the item is kept;
- the per-run cap (`MAX_WORK_ITEMS_PER_RUN = 100`) is re-applied to state this
  build did not write.

### Compatibility

State written before Phase 15 has no `workItems` key. It loads normally, the
field defaults to `[]`, and nothing else is invalidated: no version bump, no
changed ids, no invalidated spatial positions. Verified by test.

The Claude Code cursor gained an additive `t` field; a cursor written before it
existed decodes with the ordinal defaulting to `0`, so an in-flight client is
not forced to restart its sweep.

---

## 11. Accessibility

The canvas is supplementary; **the inspector is the canonical representation**.

- Every status carries a **glyph and a word**, never colour alone
  (`WORK_ITEM_STATUS_VISUALS`).
- Each work-item row's accessible name states its title, its status in words,
  and its progress when present — so the row never depends on the glyph or its
  colour being perceived.
- Progress is always available as text, never as geometry alone.
- Rows and the owning-run control are real `<button>`s inside labelled lists
  (`aria-label="Work items"`), so they are reachable and operable by keyboard,
  and selection can be returned to the run in one keystroke.
- The ring does not animate, so reduced-motion preferences are respected by
  construction; the only animated element on the canvas remains the
  working-status dot, which Phase 14 already gates.

---

## 12. Empty and unavailable states

Three genuinely different situations, kept distinct:

| situation | what is shown |
|---|---|
| no agent activity in this workspace | "No agent activity in this workspace." |
| provider cannot be observed, but history exists | "Claude Code unavailable" + "This workspace still shows previously observed agent activity." |
| provider cannot be observed, no history | "Claude Code unavailable" + "Agent activity cannot be observed on this machine right now." |
| runs exist but the filter hides them | "No runs match this filter" + the hidden count |
| **a run exists with no work items** | **nothing** — no WORK section at all |

The last one is an absence rather than a message on purpose. A run legitimately
has no observed plan — for Claude Code that is the *common* case — and saying
so on every run would be noise. Nothing is ever fabricated to fill it.

Historical work items remain visible when the provider is unavailable; they are
stored state, not a live view.

---

## 13. Security

The generic agent domain (`src/lib/agents/*.ts`, directly) gains no new
capability. `work-items.ts` imports `@/lib/id` and `./runs` and nothing else,
and is covered automatically by the existing structural scan in
`security.test.ts`, which forbids `fs`, `node:fs`, `path`, `node:path`,
`child_process`, `spawn`, `exec`, `execFile`, `fork`, `eval`, shell and git
across the whole directory.

Provider code remains read-only. No new filesystem API, no write path, no
process, no control channel.

Never persisted: raw transcripts, prompts, tool inputs beyond the named
allowlist, tool outputs, shell commands, hidden reasoning.

Never rendered: absolute filesystem paths, session identifiers, provider task
ids, internal record ids.

Two fields are **stored but never rendered**, and the distinction is
load-bearing:

| field | phase | why it is stored | why it is safe |
|---|---|---|---|
| `AgentRun.externalId` | 11 | session identity, so re-observing updates one run | absent from every spatial node, every search haystack, every inspector selection |
| `WorkArtifact.projectPath` | 13 | part of artifact identity | same |
| `AgentWorkItem.externalId` | 15 | task identity, so re-observing updates one item | same — not even present on the scene-side `WorkItemSummary` |

The security assertions therefore test the **presentation** boundary — the
scene, every search result, and every inspector selection — rather than the
storage record.

---

## 14. Performance

- Scene construction stays single-pass per relation, with `Map`/`Set` lookups.
  Work items are grouped once into `workItemsByRun` and both progress and the
  primary item are derived from that bucket, so no nested scan is introduced.
- Placement is unchanged and untouched by work items.
- The per-run cap bounds both stored size and render cost.
- No new polling loop, no second observer, no second adapter instance, no
  provider-specific React polling. The single Phase 12 observer remains mounted
  exactly once and feeds the existing store pipeline.

---

## 15. Real-provider verification — a MANUAL procedure

> **The automated suite never reads `~/.claude`.** Every committed test runs
> against a temporary `CLAUDE_CONFIG_DIR` fixture tree
> (`reader.test.ts`) or against pure inputs (`tasks.test.ts`,
> `work-items.test.ts`, …). Running `npm test` requires no Claude Code
> installation, no sessions, and no transcripts, and produces the same result
> on every machine.
>
> The verification below is therefore **manual and local**, performed before
> release rather than on every run. An earlier draft of this phase implemented
> it as a test that scanned the developer's own `~/.claude`; that was removed,
> because deciding whether to skip required `readFileSync` over every
> transcript on the machine — 432 MB across 148 files, one of them 59 MB, at
> module-load time — and because its assertions depended on whatever that
> developer's transcripts happened to contain. See §15.2.

### 15.1 The procedure

1. Confirm a local installation: `~/.claude/projects/` exists and
   `~/.claude/sessions/` holds at least one live `<pid>.json`.
2. Build and start the production server (`npm run build`, then
   `npx next start`). **Dev mode is not usable for this offline**: Next's
   Google-font fetch fails without network and returns 500 for every route,
   including the API.
3. `POST /api/agents/claude-code` with `{}`. Expect `available: true` and the
   live session listed, with a mapped status and a safe title.
4. In the app, open the Graph view, map the session's project to a workspace,
   and confirm a run appears with safe activity summaries.
5. **Work items.** If the observed session used `TaskCreate`/`TaskUpdate`,
   confirm items appear with real titles, that statuses follow real
   `TaskUpdate` records, and that derived progress matches the real counts.
   If it did not — the common case — confirm **no work item is invented**:
   no WORK section, no ring, `getRunWorkProgress` undefined.
6. Search a work item's title; confirm a typed `Work item` result. Select it;
   confirm the inspector opens and the owning run is focused.
7. Leave the page open for one poll interval and confirm the inspector
   advances (event count, activity) **with no reload**.
8. Switch workspaces; confirm no cross-workspace work items appear and search
   returns nothing.
9. Scan the rendered page for absolute paths, session ids, `thinking`,
   `toolUseResult`, `old_string`, pipe paths and raw commands.
10. Confirm existing tab positions are unchanged, and that
    `tabdump:agent-layout:v1` holds no `workitem:` key.

### 15.2 Results of the last run (development machine, 2026-09-15)

Driving the shipped reader, parser, normalizer and ingestion over a real
historical transcript — staged and **appended to between polls exactly as a
live session appends to its own**:

- **4 real work items** materialised from real `TaskCreate` records, each
  carrying the provider's own non-empty subject as its title (the subjects
  themselves are the surveyed user's project content and are not reproduced
  here)
- derived progress **2 / 4**, from real `TaskUpdate` completions
- before the task records arrived, the run existed and **no** work items were
  invented
- no `thinking`, `toolUseResult`, `old_string`, `messagingSocketPath`, absolute
  path, `$HOME` or session id reached the presentation layer
- the cursor carried no path and no filename

Additionally verified in the running production build against the **live**
session observing this very worktree: the session was discovered, attached on
an explicit project mapping, produced a run with safe activity summaries, and
contributed **zero work items** — correctly, because it never called the task
tools. The inspector advanced from 8 to 9 events with no reload. Switching to
a second workspace showed "No agent activity in this workspace" and zero
cross-workspace search results, while the work items remained intact in
storage. No `workitem:` key ever reached the layout store.

### 15.3 What the automated suite covers instead

Every behaviour the manual pass confirms has deterministic coverage that needs
no Claude Code installation:

| behaviour | deterministic coverage |
|---|---|
| `TaskCreate`/`TaskUpdate` parsing, allowlist, `spawn_task` exclusion | `claude-code/tasks.test.ts`, `claude-code/security.test.ts` |
| creation-order identity, fail-closed unmatched updates | `claude-code/tasks.test.ts` |
| ordinal carried and advanced across polls | `claude-code/reader.test.ts` ("task ordinals across polls") |
| cursor encode/decode of the ordinal, forged input | `claude-code/cursor.test.ts` |
| ingestion, idempotency, no invented completion | `work-item-ingestion.test.ts` |
| lifecycle, timestamps, cascade, isolation | `work-items.test.ts` |
| sanitised load, malformed records, account isolation | `work-item-persistence.test.ts` |
| scene, placement stability, search, inspector | `spatial/work-items.test.ts` |
| inspector rendering, keyboard, accessible names | `graph-agent-panel-work-items.test.tsx` |
| progress ring, no fabricated ratio, no animation | `agent-progress-ring.test.ts` |

---

## 16. What is deliberately NOT implemented

- Any form of agent control: no prompt sending, command or shell execution,
  process spawning, stopping, killing, or writing to a Claude Code session.
- Filesystem mutation, git execution, terminal integration.
- Autonomous orchestration, automatic task execution, AI-generated task
  planning, automatic task decomposition, multi-agent messaging.
- Work-item **creation by the user**. The store exposes the operations, but no
  UI calls them: Phase 15 represents observed work, and a hand-authored item
  would be indistinguishable from an observed one in the record.
- Work items as canvas bodies (see §6).
- A second filter state, a second search engine, a second observer, a second
  storage namespace.
- `TodoWrite` ingestion — the tool never fires in this Claude Code build.
- `isPrimary` as a stored flag — derived instead (see §6).
- Inference of `blocked` or `cancelled` from Claude Code, which reports
  neither.

## 17. Known limitations

- **Work-item evidence from Claude Code is rare.** 2 of 148 transcripts on the
  survey machine used the task tools. Most runs will legitimately show no work
  items at all.
- **Task ordinals depend on seeing the creations.** A session first observed
  mid-transcript loses the tasks planned before observation began; their later
  status updates match nothing and are dropped. This is the intended
  fail-closed behaviour, but it means attaching a long-running session late
  yields fewer work items than it "should".
- **Explicit per-item progress is never populated in practice**, because no
  shipping provider counts. The field exists for one that might.
- **Path redaction is heuristic** for prose. It targets the machine's own
  directory layout; an unusual absolute path form could survive it. Structured
  paths (`file_path`) remain handled exactly, and non-heuristically, by
  `toProjectRelative`.
- **`getPrimaryWorkItem` scans all work items per call.** Fine at the per-run
  cap, and the scene builder does not use it (it derives from the grouped
  bucket), but a caller in a tight loop should memoise.
