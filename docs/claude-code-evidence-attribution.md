# Claude Code adapter → work-item evidence

Audit of the existing Claude Code adapter, and the attribution contract that
governs whether it may emit `AgentWorkItemEvidence`.

Surveyed live against the 181 transcripts under `~/.claude/projects` on the
development machine, 2026-09-20. Every count below is measured, not estimated.
Where the transcript does not carry something, this document says so rather
than describing a plausible substitute.

---

## Part 1 — Audit

### 1.1 Transcript source

| | |
|---|---|
| Session registry | `~/.claude/sessions/<pid>.json` |
| Transcript | `~/.claude/projects/<slug>/<sessionId>.jsonl`, JSONL, append-only |
| Task state | `~/.claude/tasks/<sessionId>/` — **contains only `.highwatermark` and `.lock`** |

The `tasks/` directory is worth naming explicitly because it looks like it
should be authoritative and is not: both session directories on the survey
machine hold a high-water integer and a lock file, and no task content at all.
The transcript is the only source of task information.

`file-history-snapshot` and `file-history-delta` records exist (58 + 8 in the
task-using transcripts) and carry `trackedFileBackups` — i.e. **file contents**.
They are not read by the adapter and must not be: they would confirm nothing
about task attribution that the tool call did not already state, at the cost of
pulling file contents into the parser.

### 1.2 Parser entry point

```
reader.ts    (server-only; discovery, byte-windowed reads, cursor)
  └─ parser.ts        parseTranscriptLine() → ClaudeParsedRecord
       └─ normalizer.ts   normalizeSession() → AgentAdapterObservation[]
            └─ contract.ts   ClaudeObservationResponse  (wire, to browser)
                 └─ adapter.ts (client) → ingestObservation()  [generic domain]
```

`parseTranscriptLine` is pure and allowlist-driven. It reads `tool_use` blocks
out of `assistant` records only; every other record type is recognised and then
contributes nothing.

### 1.3 Normalized event model

`ClaudeParsedRecord` carries `{ type, uuid?, timestamp?, gitBranch?, tools[], tasks[] }`.

`ClaudeToolUse` is the whole of what survives from a tool call:

| field | source | notes |
|---|---|---|
| `id` | `tool_use.id` (`toolu_…`) | the dedup key |
| `name` | `tool_use.name` | |
| `filePaths[]` | `file_path`, `path`, `notebook_path` | **server-side only** |
| `fileName` | basename of `filePaths[0]` | |
| `description` | `input.description`, shell tools only | never the command |
| `url` | `input.url`, http(s) only | |

`ClaudeTaskEvent` is `{kind:"create", subject, description?}` or
`{kind:"update", taskId, status}` where status ∈ `in_progress | completed`.

Two separate pipelines, deliberately: tools become activity summaries and
artifacts; task events become work items. **They never meet.** That is the gap
this phase is about.

### 1.4 Task boundary mechanism

Boundaries are **derived, not explicit**. `TaskCreate`'s input carries no id —
the id is assigned by the tool and returned in its *result*, which the adapter
does not read. So identity is re-derived from creation order: the Nth
`TaskCreate` in a session is task N, 1-based, via `taskExternalId(ordinal)`,
with the running counter held in the server-owned cursor (`taskOrdinal`).

Verified on the survey machine: a session with 11 `TaskCreate` calls produced
exactly `taskId` 1…11.

### 1.5 Where artifacts are already known

- `normalizer.artifactsForTool()` converts `filePaths` to project-relative form
  (`toProjectRelative`) and emits `AgentArtifactObservation{projectPath,
  relativePath, role, sourceId}`. An absolute path stops here.
- `role` is `edited` for `Edit|Write|NotebookEdit|MultiEdit`, `inspected` for
  `Read|Grep|Glob|NotebookRead`, and **undefined for every other tool** — an
  unknown tool contributes no artifact.
- `adapter.applyArtifacts()` resolves each to a `WorkArtifact` and links it to
  the **run** via `recordArtifactWork`.

### 1.6 Does the adapter have enough information today?

**Not as currently shaped, in two distinct senses.**

*Structurally, no.* Work items ride on the session-level **base** observation;
artifacts ride on **per-tool** observations. Nothing connects the two, and the
existing comment in `normalizeSession` says why that was right at the time:
attaching a work item to whichever tool call happened to be nearby "would make
its arrival depend on unrelated activity".

*At the domain boundary, no.* `recordWorkItemEvidence` takes a `targetId` that
is a **domain id** (`eventId` / `tabId` / `artifactId`). Those ids are minted
during ingestion. The adapter never sees one. So the adapter cannot call the
evidence API directly — the wiring point has to be inside ingestion, where the
artifact id exists, which means the *observation schema* must carry the
work-item association. See §3.2.

*Informationally, yes — but only within a bounded window.* See §1.7.

### 1.7 What the transcript does and does not carry

Every `tool_use` block in the task-using transcripts was enumerated. The full
set of block keys is `type, id, name, input, caller`. `caller` has exactly one
observed value, `{"type":"direct"}`.

**There is no field anywhere in a `tool_use` block, or on its containing
record, that names a task.** Not on `TaskUpdate` (input keys are exactly
`[taskId, status]`), not on `TaskCreate` (exactly `[subject, description]`), not
via `parentUuid`, not via `caller`.

So the only observable task scoping is **ordering**: the transcript is
append-only, and a tool call physically sits between two task status events.

The measured shape of that ordering, across all 4 transcripts that use the task
tools (of 181 total):

| | |
|---|---|
| Max tasks simultaneously `in_progress` | **1** (never 2, in any transcript) |
| File-touching tool calls with exactly 1 task active | **44** |
| File-touching tool calls with 0 tasks active | 142 |
| File-touching tool calls with ≥2 tasks active | **0** |
| `completed` for a task never seen `in_progress` | 2 (both in one transcript) |

The zero in the "≥2 active" row is what makes attribution possible at all: when
a task is active, it is the *only* active task. The 142 in the "0 active" row is
what makes a refusal rule necessary: most tool calls, even in sessions that use
tasks, happen outside any task window.

---

## Part 2 — The attribution contract

### 2.1 The rule

An evidence row may be written for (work item W, artifact A) when **all** hold:

1. W is a work item the adapter itself created, from a `TaskCreate` it observed
   in this session (so W's ordinal identity is known, not guessed).
2. An explicit `TaskUpdate{taskId: W, status: in_progress}` was observed, and no
   later `TaskUpdate` has closed it. W is *open*.
3. Exactly one work item is open at that point in the transcript.
4. The tool call sits after (2) and before W's close, **in transcript record
   order** — not within any clock interval.
5. The tool call named A through an allowlisted structured path key, and its
   tool maps to a known role. A is the artifact ingestion already resolved and
   linked to the run.
6. The window is not contaminated (§2.2).

7. The span **closed** — an explicit matching `completed` was read — inside
   the same poll that read the tool call. See §2.2a.

Anything else writes nothing.

**On the distinction from temporal proximity.** The window is not a time
interval and is never computed from timestamps. It is a state machine driven by
two explicit, provider-written events, evaluated over an append-only log in the
order the provider wrote it. A tool call two hours after the `in_progress` that
opened the window is inside it; a tool call one millisecond before that event is
outside it. Clock values are never consulted, and an out-of-order timestamp
cannot move a tool call into or out of a window.

### 2.2 Contaminated windows

A `completed` for a task that was never observed `in_progress` is proof that
work happened for a task the window structure did not track. Its work must have
occurred somewhere earlier — most plausibly inside the window that was open
immediately before it.

**Rule: an orphan completion contaminates the most recent window, and a
contaminated window emits no evidence at all.**

Measured effect on the one transcript where this occurs (`9fdc10e8`): 2 windows,
1 contaminated. 3 rows emitted, 4 rows suppressed. Without the rule, four file
operations would have been attributed to task 2 when task 3 — completed
moments later, never marked started — is an equally good candidate.

### 2.2a Why a span pays out only at its close

Contamination is discovered *after* the records it invalidates have been
walked past. Within one poll that is recoverable: spans are resolved first and
observations stamped second, so a damaged span is retracted before anything is
emitted. Across a poll boundary it is not — the records are gone and the
observations carrying them have already been sent.

This is not theoretical. Attributing at the tool call instead of at the close
was implemented first, and replaying the real transcripts in poll-sized batches
produced **2 wrong rows out of 28**: two files belonging to task 3 — which was
completed having never been started — credited to task 2, because task 3's
orphan completion fell in the next batch.

So a span pays out when it closes, or never. The cost is under-attribution when
a `completed` lands in the next poll; measured over the survey transcripts at
realistic poll sizes, coverage went from 26 possible rows to 22, with zero
false rows. Under-claiming is the direction this feature is required to fail in.

A future ingestion-side relaxation is possible — carrying the last-closed task
forward and retracting rows via `removeWorkItemEvidenceForWorkItem` when a late
orphan arrives — and would recover the remainder without weakening the rule.

### 2.3 Validation against ground truth

Task *subjects* are never used for attribution. That makes them an independent
check, and on `ed25345f` (11 tasks, 11 clean windows, 23 rows) the result is
exactly right:

| task subject | attributed files |
|---|---|
| "Write Medium-Term Causes.md" | `Medium-Term Causes.md` |
| "Write Immediate Causes.md" | `Immediate Causes.md` |
| "Write **5** Key Individuals notes" | **5** files |
| "Write **7** Key Organisations notes" | **7** files |
| "Write **2** Revision sheets" | **2** files |
| "Write 00 - Overview.md (central hub)" | `00 - Overview.md` |

The counts and the names match the subjects in every one of the 11 windows,
derived purely from ordering.

Re-run through the **real parser and normalizer** (not the survey script) in
poll-sized batches, the shipped engine reproduces this: 22 rows across the two
task-using transcripts, every one correct against its subject, with the only
deviations being under-attribution where a span straddled a batch boundary
(task 5 showed 4 of its 7 files).

### 2.4 Cases intentionally rejected

| case | outcome | why |
|---|---|---|
| Tool call while no task is open | no evidence | 142 of 186 file calls; nothing says which task |
| Task completed without ever starting | no evidence, and contaminates its window | untracked work existed |
| Filename appearing in a task `subject` | no evidence | prose, not an observed operation (rule G) |
| Artifact touched elsewhere in the same run | no evidence | shared run is not attribution |
| Two tasks open at once | no evidence for either | never observed; refuse rather than pick |
| Session first seen mid-transcript | no evidence until an `in_progress` is read | window state is unknown, not assumed |
| Span still open when the poll ends | no evidence (yet) | it may still be contaminated by unread records |
| Record mixing a task event with a file tool | no evidence | intra-record order is not recoverable from the parser |
| Unknown tool with a `file_path` | no evidence | `roleForTool` yields nothing, so no artifact exists to evidence |
| Shell command that touched a file | no evidence | the command is never read; no structured path |

### 2.5 Deduplication

The evidence id is already derived: `${workItemId}:${kind}:${targetId}`. Two
reads of the same transcript bytes therefore produce one row, and
`recordWorkItemEvidence` returns `created:false` with state unchanged. The same
file read twice inside one window is one row, not two. No new dedup mechanism is
needed, and none should be added.

### 2.6 Malformed and partial transcripts

Existing behaviour already fails safe and is inherited rather than re-derived:
a malformed line yields `null` and is skipped; a torn final line is not parsed
until its newline arrives; a `TaskUpdate` with an unrecognised status means *no
status change*. For evidence specifically, an unparseable record inside a window
cannot fabricate attribution — it simply contributes no tool call. A window
whose opening `in_progress` was never read does not exist, so its tool calls
fall into the "no task open" case and are dropped.

### 2.7 Privacy and security

Evidence rows carry `{id, workItemId, runId, workspaceId, kind, targetId,
createdAt}` — ids and a timestamp. No path, no prose, no transcript content.
`targetId` is an `artifactId`, and the containment rule in
`recordWorkItemEvidence` already refuses a target the run does not touch, so a
work item cannot become a side door to another workspace's files. Nothing in
this phase adds a field that could hold a command, a prompt, a tool result or a
file's contents.

Note that `WorkArtifact` ids embed the absolute project root, so they must not
be serialized into anything user-visible — the Session View's existing opaque
session artifact keys already handle this, and evidence must route through them
rather than exposing `targetId`.

---

## Part 3 — Implementation plan

### 3.1 Observed evidence vs run-level context

These must not be collapsed, and the domain already keeps them apart:

- **Run-level context** — `AgentRunArtifactLink`, `AgentRunLink`, `AgentEvent`.
  "This run touched this file." Recorded for every tool call with a path,
  whether or not any task was open. Unchanged by this phase.
- **Observed evidence** — `AgentWorkItemEvidence`. "This *task* touched this
  file, and the transcript says so." A strict subset: on the survey data, 26 of
  186 file-touching tool calls (14%) qualify.

Evidence is never derived from context. The 88% that does not qualify is the
honest empty state, not a gap.

### 3.1a Test coverage

`src/lib/agents/claude-code/evidence.test.ts`, 26 tests, all driven through the
real parser from transcript lines rather than hand-built records. Covers the
matrix A–N: single read, single edit, multiple files, two tasks separated, one
file evidenced for two tasks, files outside any window, prose-only mentions,
orphan completions, overlapping windows, mixed records, empty tasks,
session-scoped ids, unknown cursors, determinism on re-read, malformed and torn
records, unrecognised statuses, shell commands, unknown tools, paths outside the
project, cross-poll window carrying, contamination carrying, and the
close-before-payout rule.

### 3.2 The change

The adapter cannot reach domain ids (§1.6), so the association travels on the
observation and is resolved during ingestion.

**Done on this branch:**

1. `AgentArtifactObservation` gains one optional field,
   `workItemExternalId?: string`. This is the only schema change, it is
   additive, and an observation without it behaves exactly as today. Added to
   `ARTIFACT_OBSERVATION_ALLOWLIST`, which the security suite asserts against.
2. `normalizer.ts` resolves task spans over the batch (`resolveWindows`),
   applies §2.1, §2.2 and §2.2a, and stamps qualifying artifact observations.
3. `ClaudeTranscriptCursor` carries `taskWindow` alongside `taskOrdinal`, so a
   span survives a poll boundary. `decodeCursor` bounds the client-supplied
   task id to `^[0-9]{1,6}$` and defaults `contaminated` to *true* for a
   malformed value. A first sight of a session starts with no window open.

**Not done — blocked:**

4. `adapter.applyArtifacts()`, which already holds the resolved `artifactId`,
   should look up the work item by `(runId, workItemExternalId)` and call
   `recordWorkItemEvidence`. A miss writes nothing.

No second store, no bypass of domain validation, no direct Session View write.

### 3.3 Status

Parts 1 and 2 are complete and grounded in the survey above. Part 3 is
complete except for step 4, which is blocked rather than deferred: the
`AgentWorkItemEvidence` entity, its persistence, the domain-index evidence maps
and the Session View do not exist on this branch or on any branch in this
repository. They exist only as uncommitted work in a separate worktree
(`tabdump-phase-12-verify-8009ae`), so there is nothing here for the adapter to
write into, and nothing to render what it would write.

The attribution engine is therefore finished, tested and verified against real
transcripts, and the remaining wiring is a lookup-and-call in one function once
the evidence domain is on a branch.

### 3.4 Known limitations

- A span whose `completed` lands in a later poll than its file operations
  yields nothing (§2.2a). Recoverable later via ingestion-side retraction.
- Attribution exists only for `artifact` evidence. Claude Code's transcript
  offers no structural basis for attributing a *tab* or an *event* to a task,
  so those two evidence kinds stay empty for this provider.
- 4 of 181 transcripts on the survey machine used the task tools at all. For
  every other session the Session View will correctly show no evidence.
- `Write` is recorded as `edited`, never `created`, inherited from the existing
  role mapping and for the same reason: nothing observed says the file was new.
