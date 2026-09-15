# Phase 16 — Agent workspace intelligence

Phases 11–15 built the evidence: *who* an agent is, *when* it ran, *what files
and tabs it touched*, *where that sits on the canvas*, and *what work it was
doing*. Each of those added a domain entity and the observation pipeline to
populate it.

Phase 16 adds **no entity at all.** It is a derived read layer that answers one
question from the evidence already stored:

> What is happening in this workspace, and what has it touched?

The whole layer lives in `src/lib/agents/intelligence/`. Delete that directory
and the agent domain is byte-for-byte unaffected — no migration, no lost data,
no dangling reference. That property is the design rather than a side effect,
and §10 below explains why it was worth paying for.

---

## 1. Purpose

Phases 11–15 can each answer a narrow question. What none of them answers is
the one a user actually asks when they open a workspace:

| already answerable | newly answerable |
|---|---|
| "what status is run X?" | "what is live in this workspace right now?" |
| "what work items does run X have?" | "how far through its plan is it?" |
| "what files did run X touch?" | "what does run X connect to in my workspace?" |
| "what tabs did run X use?" | "which of my tabs is this run working against?" |

Each new answer is a **join across existing entities**, not a new observation.
Nothing in this phase reads a transcript, polls a provider, or learns a fact
the domain did not already hold.

---

## 2. Source of truth

Every derived model is computed from exactly these, and nothing else:

```
AgentState
├── agents          Agent            (Phase 11)
├── runs            AgentRun         (Phase 11)
├── links           AgentRunLink     (Phase 11)  run ↔ tab, role context|produced
├── events          AgentEvent       (Phase 11)  bounded activity log
├── artifacts       WorkArtifact     (Phase 13)  a project file
├── artifactLinks   AgentRunArtifactLink (13)    run ↔ file, role inspected|edited|…
└── workItems       AgentWorkItem    (Phase 15)  a unit of planned work
```

There is **no Phase 16 persisted state**, no new storage key, no new namespace,
and no addition to `AgentState`. The existing record `tabdump:agents:v1` is
untouched, and its version is not bumped.

---

## 3. The derived models

All defined in `intelligence/types.ts`.

| model | answers |
|---|---|
| `AgentRunSummary` | what one run amounts to — per-status work counts, progress, reach, last activity |
| `AgentRunImpact` | what one run is connected to — its items, files, context tabs, produced tabs |
| `AgentObjectRelationship` | the same facts as a flat edge list, for highlighting |
| `WorkspaceAgentActivity` | what is happening across a workspace — runs by status, live work, recent completions |
| `AgentActivityCard` | one run reduced to what a card renders |

Plus three **reference types** — `RunReference`, `WorkItemReference`,
`ArtifactReference` — which exist for the reason in §8.

### The index

`intelligence/domain-index.ts` builds one grouped view of `AgentState` in a
handful of linear passes. Every selector takes that index rather than the raw
state, which is what keeps repeated derivation cheap (§9) and what makes the
isolation rules enforceable in one place (§6).

It is **not a cache**: it is a pure function of one immutable `AgentState`, with
no invalidation, no TTL and no staleness. A consumer memoises it keyed on the
state object; a new state makes a new index.

---

## 4. Relationship semantics

Exactly four relationships are emitted, and each maps one-to-one onto a row the
domain already stores:

| relationship | evidence |
|---|---|
| `run → work item` | `AgentWorkItem.runId` names the run |
| `run → artifact` | an `AgentRunArtifactLink` joins them, carrying its role |
| `run → context tab` | an `AgentRunLink` with role `context` |
| `run → produced tab` | an `AgentRunLink` with role `produced` |

### What is deliberately not emitted

**`work item → artifact`.** This is the relationship a user would most like to
have — "which files were changed for this task?" — and the domain does not
record it. A work item knows its run; an artifact link knows its run; nothing
observes which file was touched *for which task*.

Joining them through their shared run would emit an edge for every (item, file)
pair — a cross product presented as knowledge. A run with 4 items and 7 files
would produce 28 confident, unmeasured claims. So it is not emitted, and
`impact.test.ts` pins its absence rather than leaving it to good intentions.

**`artifact → tab`.** No such relationship exists in the domain. Matching a
filename against a URL would manufacture an edge out of a coincidence of
spelling.

**Anything fuzzy.** There is no similarity scoring, no URL comparison, no
filename heuristic and no text matching anywhere in this layer.

---

## 5. Progress and status semantics

### Progress

Phase 15's rule, unchanged:

- `total` = how many work items exist
- `completed` = how many reached `completed`
- **cancelled items count toward neither side**, so a plan whose last two items
  were abandoned can still read as finished
- a run with nothing countable gets `undefined` — never `0 / 0`

Valid:

```
4 work items, 2 completed  →  2 / 4
```

Invalid, and with no code path:

```
agent edited 4 files       →  80%
transcript ended           →  complete
run status is working      →  75%
25 events observed         →  some progress
```

`run-summary.test.ts` asserts the last two directly: a run with 25 events and no
work items reports no progress at all.

Because `deriveWorkProgress` restates the rule to keep the indexed path linear,
a test compares it against Phase 15's `getRunWorkProgress` across **every pair
of work-item statuses**. If the two ever disagree, that test fails.

### Run status

Six statuses, Phase 11's, unchanged and never reinterpreted:

| status | live? | meaning |
|---|---|---|
| `working` | yes | ongoing |
| `waiting` | yes | live, not currently producing |
| `completed` | terminal | |
| `failed` | terminal | |
| `blocked` | **terminal** | stopped needing something it cannot get |
| `cancelled` | terminal | |

`WorkspaceAgentActivity.byStatus` is the exhaustive, mutually exclusive
partition. `activeRuns` is `working ∪ waiting` — `LIVE_AGENT_RUN_STATUSES`,
read from the constant rather than spelled out — and therefore **overlaps**
`byStatus.waiting` on purpose.

`AgentRunSummary.status` is **the run's own status, copied**, never recomputed.
A run whose every work item is complete is still `working` until the domain says
otherwise; inferring completion from finished work is exactly the fabrication
this phase must not commit, and a test asserts it does not.

### Work-item status

Five statuses, Phase 15's. The two vocabularies stay apart, because `blocked`
means different things in each:

|  | run | work item |
|---|---|---|
| `blocked` | terminal — the session stopped | **not terminal** — the next observation may unblock it |
| `pending` | does not exist | exists |

Blocked work is surfaced in words ("1 work item is blocked"), never folded into
"inactive", never rendered as failure, and never as colour alone.

### Waiting

`waiting` stays distinct from `blocked` and is never described as "waiting for
your response". A session can be idle for many reasons, and the observed
evidence does not distinguish them. Fail closed.

### Last activity

A **maximum over timestamps that already exist**: the run's `updatedAt`, its
newest event, its work items' `updatedAt`, its artifact links' `createdAt`.

It is never `Date.now()`. Reading the wall clock would answer "when did TabDump
last look?" while appearing to answer "when did this last happen?" — and the two
diverge exactly when it matters, on a run that has gone quiet.

### The primary work item

Derived, never stored. The algorithm, stated exactly:

1. lowest attention rank — `active > blocked > pending > completed > cancelled`
2. ties broken by creation order, oldest first
3. remaining ties broken by id, so the order is total and stable
4. a run with no items has no primary — `undefined`, never a placeholder

Note what is **not** consulted: the item's title, its summary, its length, or
whether the text "sounds important". Selection is purely structural, so it
cannot be steered by provider-authored prose. A test creates an item titled
"URGENT CRITICAL BLOCKER" and asserts the earlier, blander item still wins.

---

## 6. Workspace isolation

The boundary is crossed **exactly once**, at the top of every selector, via
`index.runsByWorkspace`. Work items, artifact links, tab links and events are
reached only *through* a run already proven to belong to the requested
workspace. No selector reads a work item or link by any other key.

The index is the single choke point, and it fails closed:

- a work item whose run is unknown is **dropped**
- a work item whose `workspaceId` disagrees with its run's is **dropped**
- an artifact link whose run or artifact is unknown is **dropped**
- an artifact link whose file belongs to another workspace is **dropped**

Nothing is repaired, re-parented, or replaced with a fabricated stand-in.

`isolation.test.ts` builds two workspaces that are **as confusable as the domain
permits** — the same agent, the same tab ids, the same relative file paths, the
same work-item titles — so a selector keying on anything but the workspace
visibly crosses over. It then tampers with stored state directly to prove the
two drop rules above hold when in-memory state lies.

Workspace-scoped variants (`getWorkspaceRunSummary`, `getWorkspaceRunImpact`,
`getAgentActivityCard`) refuse a run id from another workspace outright, so a
stale selection cannot read across.

An empty workspace id selects **nothing**, never everything.

---

## 7. Account isolation

Accounts are separated one layer below, by the storage namespace (`scopedKey`).
The intelligence layer receives a single `AgentState` and has no way to reach
another — there is no storage access in the entire directory, asserted
structurally by `security.test.ts`.

What is verified end to end is that the separation actually holds: save as one
account, switch namespace, load as the other, derive, and confirm each sees only
its own work — including when both use the **same workspace id**.

---

## 8. The presentation boundary

Three fields are **stored but never rendered**, and none appears in any derived
model:

| field | phase | stored because | absent because |
|---|---|---|---|
| `AgentRun.externalId` | 11 | session identity | a provider session id is not a caption |
| `AgentWorkItem.externalId` | 15 | task identity | a provider task id is not a caption |
| `WorkArtifact.projectPath` | 13 | artifact identity | it is an **absolute local path** |

This is why `RunReference`, `WorkItemReference` and `ArtifactReference` exist.
Each is built field by field in `references.ts` rather than by spreading the
domain object and deleting keys — a spread would silently carry through any
field added to the domain later, which is precisely the failure being prevented.

### On the project root and artifact ids

Phase 13 makes the project root part of an artifact's **identity**:
`workArtifactId(workspaceId, projectPath, relativePath)`. So an `artifactId` does
embed it, and `ArtifactReference.artifactId` carries it exactly as
`ArtifactSpatialNode.artifactId` already does.

The invariant is therefore precise, and Phase 16 does not widen it:

> The project root may appear in an opaque **key**. It must never appear in a
> field anything **renders**.

`security.test.ts` and `impact.test.ts` assert both halves — the root is present
in the id, and absent from every `relativePath`, title, summary and label — so a
future change to artifact identity is caught here rather than discovered on
screen.

---

## 9. Performance

The naive shape — for each run, scan every work item, artifact link, tab link
and event — is O(runs × everything), recomputed on every React render.

`buildAgentDomainIndex` groups the domain once in linear passes; every selector
then costs only what it returns. `useAgentIntelligence` memoises the index on the
state object, so the inspector, the canvas and the search box share one
traversal.

`scale.test.ts` builds the §32 fixture — 1 agent, 10 runs, 100 work items, 100
artifacts, 500 tab links — and asserts **correctness first** (every count checked
against the fixture's known composition) and only then bounds the work. The
timing bound is deliberately loose: it exists to catch an accidental quadratic,
not to police milliseconds.

No caches were added beyond the index. There is no eviction policy, because
there is nothing to evict.

---

## 10. Why nothing is persisted

The brief allowed a new persisted entity if one proved necessary. None did, and
the reasons are worth recording:

- **Every model is a pure function of existing state.** There is no fact here
  with an independent lifecycle — no summary outlives its run, no relationship
  outlives its link.
- **Persisting would create a second source of truth.** A stored summary and its
  run can disagree; a derived one cannot.
- **Persisting would need invalidation.** Every domain mutation would have to
  know which derived records it invalidated — a new class of bug for no new
  information.
- **Reload is already correct.** `resilience.test.ts` derives, saves the *source*
  state, reloads, derives again, and asserts deep equality across every model.

The test for "is this genuinely a derived layer?" is §48's Q10: *can the whole
thing be removed without affecting the underlying agent data?* Yes — nothing
outside `intelligence/` stores anything it produces, and the two consuming
surfaces both treat it as optional (§11).

---

## 11. Integration

Deliberately **additive**. Every integration point degrades to exactly the
Phase 14/15 behaviour when no intelligence index is supplied.

### Hook

`useAgentIntelligence` (`src/hooks/use-agent-intelligence.ts`) memoises the
index, the workspace activity, and the highlight set. It owns no state, runs no
effect, starts no polling, and has no path that could change the domain —
observation still belongs to the single Phase 12 observer.

### Inspector

`InspectorInput.intelligence` is **optional**. With it, a run selection gains
`summary`, and a work-item selection gains its owning run's `runSummary`.
Without it, both are absent and the panel renders as before — which is why the
existing Phase 14 and 15 inspector tests still pass unchanged.

The panel's new `SUMMARY` section shows progress as a count, a per-status
breakdown, reach split by role, and a blocked callout. Every figure is omitted
when zero: "0 files" reads as a measurement, when the honest reading is that
there are none to mention.

### Graph

One addition: when a **run** is selected, the tabs it touched are ringed where
the tab layer already drew them (`drawAgentTabHighlight`).

The constraints this respects:

- drawn inside the agent layer's own pass, at a position the tab layer decided —
  so it **cannot move a tab**, and adding or removing a highlight repositions
  nothing;
- **nothing enters d3-force.** Work items are still not scene nodes; intelligence
  models are not nodes at all. The force simulation consumes `GraphNode`, which
  this layer never touches;
- highlighting is **per selection, never global** — a canvas that ringed every
  agent-touched tab at all times would be the unreadable web this phase exists
  to avoid;
- only a run selection highlights. An agent spans many runs and a file is reached
  *by* runs rather than reaching them, so for those the answer is simply empty
  rather than an invented rule.

### Search

Phase 15's search is unchanged — no second engine, nothing indexed. One
behaviour was added: selecting a **file** result now focuses a run that worked on
it. A file the scene has not disclosed has no position yet (selecting it is what
discloses it, on the next render), so focusing its owning run is what makes the
result navigable. Workspace-scoped, so an identically-named file elsewhere
cannot move the camera.

### Filters

Untouched. `AgentSpatialFilter` keeps its five values and its existing
semantics; filtering still affects visibility only and never mutates state.

---

## 12. Accessibility

- Status is always **words**, never colour alone — the blocked callout is a
  sentence ("1 work item is blocked"), and the glyph beside it is `aria-hidden`.
- Progress is text (`2 / 3 complete`), never geometry alone.
- The new section adds no interactive control, so it introduces no new focus
  order; existing controls remain real `<button>`s and are asserted reachable and
  operable by keyboard.
- Nothing added animates.

---

## 13. Security

The layer gains **no capability**. `intelligence/security.test.ts` is the
mechanical guard — needed because `lib/agents/security.test.ts` scans only files
sitting directly in `src/lib/agents/`, so a new subdirectory would otherwise be
unscanned.

It asserts the directory:

- imports no `child_process`, `fs`, `path`, `os`, `net`, `http`, `vm`,
  `worker_threads`, or `server-only`;
- contains no `spawn`/`exec`/`fork`/`eval`/`new Function` call shape;
- names no git command, no shell, no `messagingSocketPath`;
- makes no `fetch`, `XMLHttpRequest`, `WebSocket` or beacon call;
- reads no `~/.claude` path and calls no `homedir()`;
- touches **no storage key at all** and no browser storage — it derives, it does
  not persist;
- imports **no domain mutator** (all 22 are enumerated) — a read model must not
  be able to rewrite what it reports on;
- exports no function named to act on an agent;
- imports **no React** — derivation is not a rendering concern.

Provider neutrality is enforced the same way: the directory may not import
anything from `claude-code/` or a provider path, and may not name a provider in
executable code. A future Codex, Cursor or Gemini adapter feeds the same models
without this directory changing.

`__fixtures__/` is excluded from the scan (it is test-only scaffolding that calls
domain mutators to build states), and a separate assertion proves no shipped file
imports it — so the exclusion cannot be used as a loophole.

Phase 12's read-only model, Phase 13's path handling and Phase 15's task-evidence
rules are all untouched. No second task parser was written; Phase 16 consumes the
normalized work items Phase 15 produces.

---

## 14. Verification

Run at commit time on the Phase 15 baseline (`78a31f5`).

| gate | baseline (`78a31f5`) | after Phase 16 |
|---|---|---|
| tests | 3641 passed, 17 skipped, 0 failed (246 files) | 3763 passed, 17 skipped, 0 failed (255 files) |
| typecheck | clean | clean |
| lint | clean | clean |
| build | passes | passes |

**Tests.** +122, all new, none removed, none weakened, no snapshot rewritten.
No existing test was changed: every Phase 16 integration point is optional
(§11), so the Phase 14 and 15 suites still exercise the pre-Phase-16 behaviour
unmodified.

**Typecheck.** Clean. Note that `tsc --noEmit` reports
`src/app/layout.tsx: Cannot find name 'LayoutProps'` on a tree that has never
been built — `LayoutProps` is a Next-generated global that only exists once
`.next/types` has been written. Run `npm run build` first (or after) and the
error disappears; it is environmental and unrelated to this phase.

**Build.** Passes. It emits one pre-existing warning, `Failed to find font
override values for font 'Cascadia Code'`, which is a font-config matter
untouched by this phase.

**Security scan.** No `child_process`, `spawn`, `exec`, `execFile`, `fork`,
`eval`, `new Function` or `messagingSocketPath` anywhere in the new code; no git
or shell invocation; no provider name in generic intelligence; no absolute-path
shape; no React import; no storage key. Enforced mechanically — see §13.

**Real Claude Code verification.** Recorded in §15.

---

## 15. Real Claude Code verification

Phase 16 adds no observation. It consumes what Phase 12's observer and Phase 15's
task evidence already produce, so the provider-facing surface is unchanged and
the relevant question is whether derived models are correct over **real observed
data** rather than whether new parsing works.

### How it was run

A local-only harness drove the **actual shipped pipeline** end to end —
`isClaudeCodeAvailable` → `sweepSessions` → `normalizeSession` →
`ingestObservation` → `buildAgentDomainIndex` → the Phase 16 selectors. No
module was stubbed and no alternate code path was written for verification.

The harness was **not committed**, for two reasons: it depends on a local
Claude Code installation, which §45 forbids in the suite, and its input is the
surveyed machine's own sessions, which §44 forbids in the repository.

### What was observed

Against this machine's real `~/.claude`, in one bounded sweep:

```
available = true          sessions = 1
observations = 6          all 6 ingested
runs = 1   events = 6   artifacts = 1   artifactLinks = 1
workItems = 0
byStatus = { working: 1, waiting: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 }
activeRuns = 1   cards = 1   recentFiles = 1
```

| check | result |
|---|---|
| A real session is observed | **PASS** |
| Run appears with correct status | **PASS** — `working`, copied from the domain |
| Events remain correct | **PASS** — 6 observed, 6 recorded |
| Artifacts associated correctly | **PASS** |
| Run summary matches the underlying data | **PASS** — every count re-derived from raw `AgentState` and compared |
| Impact contains only real relationships | **PASS** — every file, tab and item edge traced back to a stored row |
| Workspace isolation | **PASS** — a second workspace id returns nothing |
| Re-derivation is identical | **PASS** — deep equality after a round trip |
| No absolute path in any rendered field | **PASS** |
| No session id or project root in client-visible models | **PASS** |
| No control channel created, no Claude Code file modified | **PASS** — the pipeline is read-only by construction (Phase 12) |

### What was *not* exercised, and why

**Work items from real `TaskCreate`/`TaskUpdate` evidence.** The observed
session produced none, so `workItems = 0`.

This is the expected common case, not a gap in the implementation: Phase 15's
own survey of 148 real transcripts found structured task evidence in **2** of
them. A run with no observed plan correctly reports no progress, no primary item
and no work section — which is itself the behaviour verified here, and it is the
behaviour that matters most, because fabricating a plan for a run that has none
is the failure this phase exists to avoid.

Work-item derivation over task evidence is covered exhaustively by the
deterministic suites, including an equivalence check against Phase 15's own
selector across **every pair** of work-item statuses.

### Data handling

No transcript content, task description, project name, local username, absolute
path, token or private URL is committed anywhere in this repository. Every
committed fixture is deterministic and machine-independent (§45):
`__fixtures__/domain.ts` reads no filesystem, no network and no local Claude Code
installation, and derives every timestamp from a fixed `T0`.

---

## 16. Non-goals

Explicitly, and enforced rather than promised:

```
No agent control
No autonomous execution
No prompt sending
No starting, stopping, killing or cancelling a run
No shell
No Git execution
No LLM-based workspace interpretation
No fabricated relationships
No persisted duplicate intelligence
No second task parser
No second source of truth
```

The last two matter most. Phase 16's value is that it makes the workspace
legible — and it is only worth having while every figure it shows is a count of
something that was actually observed.
