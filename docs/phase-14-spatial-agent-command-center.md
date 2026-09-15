# Phase 14 — Spatial Agent Command Center

Agent work becomes visible on the workspace canvas: runs, the files they
touched, and how those relate to the tabs already there.

**Status: complete.** Delivered in two passes — the spatial layer first, then
the surfaces around it (inspector, filters, empty/unavailable states, search,
accessibility). The completion pass is documented in its own section below.

## Product concept

Phase 12 could say *"Edited sidebar.tsx"* in a log. Phase 13 gave that file an
identity. Phase 14 puts both in the space the user already arranges their work
in, so the question *"what is my agent doing, and where?"* is answered by
looking rather than by reading a list.

```
Agent
  └── AgentRun          the operational object
        ├── Tab         human context surface
        └── WorkArtifact project work target
```

Runs are first-class: a card with a title, a live status, an activity line and
counts — not a row in a sidebar.

## Spatial model

| File | Responsibility |
| --- | --- |
| `agents/spatial/types.ts` | Node/edge types, namespaced ids, filters |
| `agents/spatial/scene.ts` | Domain state → scene. The only place visibility is decided |
| `agents/spatial/placement.ts` | Deterministic, append-only positions |
| `agents/spatial/persistence.ts` | Dragged positions + filter, account-scoped |
| `hooks/use-agent-spatial.ts` | Ties them together for React |
| `components/graph/agent-node-renderer.ts` | Pure canvas drawing |
| `components/graph/graph-canvas.tsx` | Draws the layer, hit-tests, drags |
| `components/graph/graph-view.tsx` | Supplies the layer from the agent store |

### Node types

- **Agent** — the provider identity. Name, provider, active/total run counts,
  and a summary status that reports whichever of its runs most wants attention.
- **AgentRun** — title, status, sanitised activity line, file and tab counts.
- **WorkArtifact** — basename as label, project-relative path as detail, and
  how many runs have touched it.
- **Tab** — *not drawn by this layer.* Tabs belong to the tab layer; the agent
  layer only draws edges to them. Drawing them twice would put the same page on
  screen in two places.

### Stable identity

```
agent:<agentId>   run:<runId>   artifact:<artifactId>   tab:<tabId>
```

Namespaced because a run id and an artifact id are both opaque strings from the
same generator — a position map keyed by the bare value would let one inherit
the other's coordinates. Derived from the domain id, never from an array index
and never minted during render, so identity survives rerenders, polls,
workspace switches and reloads.

### Edge semantics

`owns` (structural) plus the domain's own roles, carried through unchanged:
`context`, `produced`, `inspected`, `edited`, `created`, `deleted`.

Distinguished by **dash pattern and width**, not by colour, so the picture
survives a colour-blind reading and the dimming applied to unemphasized edges.

## Visibility — progressive disclosure

A workspace accumulates agent history indefinitely. Rendering all of it is the
specific failure this phase is meant to avoid, so:

- **Default (`active`)** — live runs, plus runs that finished recently.
- **Files stay collapsed** when several runs compete for the canvas; a run
  carries its counts instead ("4 files · 2 tabs"). A *single* visible run
  discloses its files without a click.
- **Selecting a run** discloses its files. Selecting an artifact discloses the
  runs around it.
- **Edges**: with nothing selected only the structural spine is prominent;
  everything else is drawn faintly rather than hidden, so the shape of the
  whole stays legible while one neighbourhood is in focus.
- **Hidden runs are counted**, not silently dropped — a user who cannot tell
  "no agent work" from "none matching this filter" will misread the canvas.

Verified at scale: 100 runs and 500 artifacts produce 101 nodes by default, and
selecting one run discloses only that run's files.

## Layout — why nothing moves

Two decisions, both protecting what is already on screen.

**The agent layer is not in the physics simulation.** The tab graph runs
d3-force with cluster territories and confinement discs. Adding bodies to it
would change the forces every existing tab feels, and a hand-arranged workspace
would rearrange itself the moment an agent appeared. Agent nodes are placed
arithmetically and never handed to the engine, so the tab layout is exactly
what it was before this phase existed — and the 452 existing graph tests pass
unchanged.

**Placement is append-only.** Nodes are ordered by `createdAt`, not by id: a
newly discovered run always has the largest value, so it takes the next free
slot instead of sorting into the middle and pushing its neighbours down. Each
run occupies a slot of *constant* height, so a run that gains files fans them
out around itself rather than displacing its siblings.

A caught bug worth recording: the first implementation sorted by id, and a
freshly minted uuid that happened to sort early displaced every run below it —
a layout that rearranges itself on a poll, which is the one thing this must
never do. The `createdAt` ordering is what fixes it, and
`placementsAgree` is the property the tests assert.

Dragged positions always win, are keyed by spatial id, and are stored per
workspace.

## Live updates

```
Claude observer (Phase 12)  →  agent store  →  useAgentSpatial  →  canvas
```

The spatial layer starts **no polling loop**, makes **no request**, and has no
timer of its own — asserted by test. There is exactly one observer in the app
and it is not here. A new poll result repaints through a ref the draw loop
reads, so it never reheats the simulation.

"Recent" is derived from the newest thing the agent domain knows about rather
than from the wall clock. That keeps the derivation pure (no interval, no
effect) and behaves better: come back after a week and the last thing your
agent did is still on screen.

Only genuinely live work animates — the working indicator is the only moving
thing on the canvas, so motion always means something.

## Security

- **No filesystem access** from the spatial layer: no `fs`, no `child_process`,
  no `os`, no path reading — asserted by test.
- **No provider coupling**: it imports nothing from `claude-code/` and names no
  provider in executable code. Claude Code specifics stay in the adapter.
- **No mutation**: it imports no domain mutator (`transitionRunStatus`,
  `deleteRun`, `appendRunEvent`, `ingestObservation`, …) — asserted by test.
  Dragging records layout and nothing else.
- **Nothing sensitive reaches the picture**: no `thinking`, `toolUseResult`,
  `old_string`, prompts, commands or `messagingSocketPath`.
- **No absolute path is ever displayed.** One does exist in
  `WorkArtifact.projectPath` and the id embedding it — the Phase 13 identity
  exception, needed because a workspace may hold two projects with the same
  relative path. It is a key, never a caption, and the tests assert that
  precisely: every rendered field (`label`, `detail`, `relativePath`,
  `provider`, `activity`) is checked.
- **Workspace isolation** at the presentation layer as well as the domain:
  another workspace's runs and artifacts never enter the scene.
- **Account isolation** through the existing `scopedKey` mechanism; layout
  lives under `tabdump:agent-layout:v1`, registered in `SCOPED_STORAGE_KEYS`.

## Verification

### A note on worktrees and the `embedded-postgres` error

Earlier phases were developed in a worktree where `embedded-postgres` was not
installed, which produced a pre-existing typecheck/build failure and made the
Postgres suites skip (91 skipped). The completion pass ran in a worktree where
it **is** installed: those suites execute (17 skipped), typecheck is clean, and
the build succeeds. Same code, different local dependency state — worth knowing
before comparing two numbers from different trees.

### Phase 14 (first pass), in the worktree without `embedded-postgres`

| Gate | Baseline | After |
| --- | --- | --- |
| Tests | 3205 / 91 skipped / 0 failed, 233 files | 3319 / 91 / 0, 238 files |
| Lint | clean | clean |
| Typecheck | 1 pre-existing error | same error, unchanged |
| Build | blocked by it | blocked by it |

114 tests added. The 452 existing graph and canvas tests passed unchanged,
which is the no-regression signal that matters most: the tab layout is
untouched by the new layer.

### Phase 14B (completion pass), in the worktree with `embedded-postgres`

| Gate | Baseline | After |
| --- | --- | --- |
| Tests | 3393 / 17 skipped / 0 failed, 238 files | **3460 / 17 / 0, 241 files** |
| Lint | clean | clean |
| Typecheck | clean | clean |
| Build | succeeds | **succeeds** |

67 tests added across 3 files; zero regressions. All four gates green.

### Real Claude Code verification

Performed against this worktree's own live Claude Code session (2.1.270), from
21 real transcript records — not fixtures.

| # | Scenario | Result |
| --- | --- | --- |
| A | Agent appears | real session `b70abc10…` → 3 spatial nodes (agent, run, artifact) |
| B | Working status | run `working`; agent summary `working` |
| C | Activity | `Run live spatial verification` — a real tool description; label `remove-governing-law-8bc442-b1` |
| D | File artifact | `live-spatial.test.ts` at `src/lib/agents/spatial/live-spatial.test.ts` |
| E | Relationship | artifact edge role `edited`; `owns` edge present |
| F | Tab relationship | tab edge kind `context` pointing at `tab:…`; cross-workspace link **refused** |
| G | Live update | new observation → activity became `Edited live-spatial.test.ts` |
| H | Persistence | reload: `loaded`, 3 nodes, artifact intact |
| I | Spatial stability | **positions unchanged by the new event = true**; dragged position honoured |
| J | Workspace isolation | other-workspace run did not leak |
| K | Sensitive data | no `thinking`, `toolUseResult`, `old_string`, `pipe`/`cc-msg`; **no absolute path in any displayed field** |
| L | Unavailable state | empty scene → 0 nodes, 0 edges, placement returns empty, no crash |

L was verified by building the scene with no observation, which is the same
path a hosted deployment takes when Phase 12 reports `available: false`. It was
**not** verified against a real hosted deployment.

## Completion pass

The surfaces around the canvas, added after the spatial layer was verified.

### Observer mounting — a gap the first pass left

`useClaudeCodeObserver` existed but **was mounted nowhere**, so Phase 12's
observation never actually ran in the product: the store was only ever filled
by tests. It is now mounted exactly once, in `graph-view.tsx`, beside the store
it feeds. That is the single authoritative observation loop; the canvas, the
panel and search are all readers of what it produces, and an architectural test
keeps it that way.

### Inspector — `components/graph/graph-agent-panel.tsx`

Another section in the existing `GraphSidebar`, alongside
`GraphDependencyPanel` and `GraphCollectionPanel` — not a dashboard, not a
modal, and not a second selection system. The sidebar takes it as a
`React.ReactNode` so it stays a layout component that knows nothing about
agent state.

| Selection | Shows |
| --- | --- |
| **AgentRun** | title, agent name, status (glyph + word), safe activity, counts, started / last activity / ended, files grouped by role, tabs grouped by role, recent events |
| **Agent** | name, provider, status summary, active/total counts, recent runs (clickable) |
| **WorkArtifact** | basename, project-relative path, and which runs touched it with which role |

Two deliberate details: counts are **omitted rather than shown as zero**
("unknown" is more honest than "0 tabs"), and `endedAt` appears only when the
domain actually recorded it — never inferred from a session disappearing,
which Phase 12 established cannot be interpreted.

Data assembly lives in `lib/agents/spatial/inspector.ts` as a pure function, so
"what does this run consist of" is testable without rendering. It tolerates
every dangling reference — a run whose agent is gone, a link whose artifact is
gone, a tab the user deleted (named "Deleted tab" rather than dropped, so the
count the canvas shows stays honest).

### Filters

All five, as `Pill` controls with `aria-pressed` — the existing filter
convention. Semantics, using the domain's own vocabulary:

| Filter | Shows |
| --- | --- |
| **Active** | `working` and `waiting`, plus anything finished within 6h |
| **Waiting** | `waiting` only |
| **Needs attention** | `failed` and `blocked` |
| **Finished** | every terminal status, `cancelled` included |
| **All** | everything in the workspace |

`active` includes `waiting` because that is what the domain means by a live
run — a run awaiting input has not stopped. Filtering only changes what is
visible: no domain state, no layout, no status and no relationship is touched,
and hidden runs are counted so the user can tell "nothing here" from "nothing
matching".

### Empty and unavailable states

Four distinct states, never collapsed into one:

- **No agent activity** — the observer works, the workspace has none.
- **No runs match this filter** — with how many are hidden.
- **Unavailable, with history** — "still shows previously observed agent
  activity". Historical data is never erased by unavailability.
- **Unavailable, with nothing** — says only that it cannot be observed.

The unavailable copy deliberately does **not** say "Connect Claude Code": there
is no connection mechanism in the product, and offering one would be a lie.

### Search — `lib/agents/spatial/search.ts`

Extends the existing search *idea* (a pure matcher over held state, like
`matchesGraphQuery`) rather than adding an engine. Nothing is indexed.

Searchable: agent name and provider, run title, status, safe activity summary,
and project-relative artifact path. The matched-fields list is an **allowlist**,
so a field added to the scene later cannot become searchable — and therefore
printed back to the user — without someone choosing it. Notably absent:
`projectPath` and the artifact `id`, both of which embed the absolute root.

Results are typed (`Agent` / `Agent run` / `File`) so a run never reads as a
tab. Selecting one selects the entity, focuses its node via
`GraphCanvasHandle.focusPoint` (the smallest helper needed — agent nodes are
not physics bodies, so `centerOnNode` cannot reach them), and opens the
inspector.

**Search is scoped to the scene**, which gives workspace- and filter-scoping
for free: every result corresponds to something the user can then be shown.
Searching a completed run under the Active filter finds nothing rather than
offering a result that cannot be selected. Files collapsed by progressive
disclosure are still findable by path, via `searchHiddenArtifacts`.

### Accessibility

The inspector is the non-spatial fallback: everything the canvas says
spatially is available as linear text. Status is a **word plus a glyph**, never
colour alone, on the canvas and in the panel. The section is a labelled
`region`, filters are a labelled `group` of `aria-pressed` buttons, and lists
use real `ul`/`li` with buttons inside. A run's whole state — name, agent,
status, files, tabs, recent activity — is readable without interpreting a
graph, and asserted as such by test.

### Completion-pass verification

Against the same live Claude Code session, 46 real records:

| # | Scenario | Result |
| --- | --- | --- |
| A | Real run | session `b70abc10…` |
| B | Status | `waiting` |
| C | Activity | `Record the spatial-layer architecture decision` |
| D | Artifact | 1 on canvas |
| E | **Inspector** | title, agent `Claude Code`, status, activity, `edited: docs/phase-14-…md`, `context: API reference`, 6 events, started time, `endedAt (none — never inferred)` |
| F | **Filters** | All→1, Active→1, Finished→0 with 1 hidden |
| G | **Search** | run title → 1 `[Agent run]`; artifact path → 1 `[File]` |
| H | **Search selection** | opened the **artifact** inspector: file + "Claude Code (edited)" |
| I | **Live inspector** | activity became `Edited live-14b.test.ts`, events 6→7, no reload |
| J | Empty | empty workspace → 0 nodes, inspector `null` |
| K | Unavailable | `isClaudeCodeAvailable()` exercised; empty scene path safe |
| L | **Security** | 15 displayed fields checked: no absolute path, no `thinking`, no `toolUseResult`, no `old_string`, no `pipe`/`cc-msg`, **and no session id** |
| M | Spatial stability | **positions unchanged by the new event = true** |
| N | Existing workspace | 452 graph/canvas tests pass unchanged |

Persistence re-checked after the new event: reload preserved 1 file and 7
events.

## Limitations

- Observational only: no agent control, no prompts, no execution.
- No file contents, diffs, viewer, Git, or filesystem watcher.
- Local/self-hosted Claude Code observation only, inherited from Phase 12.
- Artifacts are only as complete as what was observed.

## Phase 15 handoff

Available to build on: spatial Agent/AgentRun/Artifact nodes with stable
identity, deterministic append-only placement, per-workspace dragged positions,
role-typed edges, live status driven by the single observer, and the selectors
behind all of it (`getArtifactsForRun`, `getRunsForArtifact`,
`getArtifactLinksForRunByRole`, `getWorkspaceRuns`, `getRunEvents`, …).

The nearest work is the UI chrome listed above — the model and the canvas are
there; what is missing is the panel and controls that sit beside them.
