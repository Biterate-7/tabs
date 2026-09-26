# Phase 12 — Real Claude Code Read-Only Adapter

Hubble observes a real, local Claude Code session and represents its work as
a Phase 11 `AgentRun`, without ever being able to control it.

The invariant this whole phase exists to hold:

> **Hubble observes Claude Code. Hubble never controls Claude Code.**

## Source discovery

Re-verified live, not assumed from earlier notes.

- **Claude Code 2.1.270**, win32, `entrypoint: claude-desktop`.
- Record-level `version` in transcripts also reads `2.1.270`.

### Session registry — `~/.claude/sessions/<pid>.json`

One JSON file per **live** session, named by OS pid. Fields observed:

```
pid, sessionId, cwd, startedAt, procStart, version, peerProtocol,
peerFeatures, kind, entrypoint, pidDomain, messagingSocketPath,
name, nameSource, nameSince, status, updatedAt, statusUpdatedAt
```

`sessionId` is a UUID. `status` was `busy` and `idle`. `name` is Claude's own
derived session name, used here as a run title.

`messagingSocketPath` is a live named pipe (`\\.\pipe\LOCAL\cc-msg-…`) — a
**control channel**. See the security section.

### Transcripts — `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`

The directory name is the absolute cwd with `:`, `\`, `/` and `.` each
replaced by `-`, so `C:\Users\v\tabs\.claude\worktrees\x` becomes
`C--Users-v-tabs--claude-worktrees-x`. **The encoding is lossy and not
reliably reversible**, which is why the reader locates transcripts by
scanning for a UUID-named file rather than re-deriving a directory.

Append-only JSONL, confirmed in practice: across a full session the file only
ever grew, and a live poll at offset 2 743 025 returned 0 new records, then
exactly the newly appended ones after more work.

**Sizes matter.** On this machine: 17.4 MB, 4.0 MB, 3.9 MB, 2.8 MB in one
project directory. Whole-file reads are not viable.

Record types observed across sessions:

```
assistant, user, system, attachment, bridge-session, queue-operation,
last-prompt, custom-title, file-history-snapshot, file-history-delta,
atis-latch
```

`file-history-delta` was **not** present in the earlier survey and appeared in
this one — concrete evidence that the record vocabulary drifts between
versions, and the reason unknown types are ignored rather than rejected.

Common record fields: `uuid`, `parentUuid`, `sessionId`, `timestamp` (ISO-8601),
`cwd`, `gitBranch`, `type`, `version`, `isSidechain`.

`gitBranch` is on the records themselves, so branch metadata needs no git
execution.

### Tool use

`assistant.message.content[]` blocks; in one sampled file, `tool_use` 145,
`thinking` 88, `text` 20. A `tool_use` block has `type, id, name, input, caller`.
`id` is a `toolu_…` string — the stable event identity used for dedup.

Input shapes observed, by frequency:

| Tool | `input` keys |
| --- | --- |
| `Bash` (1028) | `command`, `description` |
| `Edit` (172) | `file_path`, `old_string`, `new_string`, `replace_all` |
| `Write` (166) | `file_path`, `content` |
| `PowerShell` (62) | `command`, `description` |
| `Grep` (24) | `pattern`, `path`, `output_mode` |
| `Read` (17) | `file_path` |
| `mcp__Claude_Browser__navigate` (12) | `url`, `tabId` |
| various `mcp__*` | tool-specific |

MCP tools are common, not exotic — so an unknown tool is the normal case.

### Lifecycle artifacts

Only one kind exists: `<sessionId>.desktop-released.json`, shape
`{ v, releasedAt, reason }`. **All 21 instances had `reason: "delete"`.**

Two findings that correct the assumption in the brief:

1. **It is not an end-of-session signal.** All 20 sidecar'd sessions checked
   still had their transcript present, so it marks the *record* being deleted
   in the desktop app, not the run finishing.
2. **A session that simply exits writes nothing at all.** One observed session
   (`a887a1f5…`, pid 13976) vanished from the registry between surveys leaving
   its transcript and **no sidecar**.

So there is **no reliable terminal signal** for a session ending normally.

### Schema metadata

No schema version field beyond the Claude Code `version` string on records and
registry entries. There is nothing to negotiate against, which is why the
parser validates structurally rather than by version.

## Architecture

```
~/.claude (local, read-only)
      │
      ▼
reader.ts          server-only; the only filesystem access
      ▼
parser.ts          pure; JSONL line → allowlisted record
      ▼
normalizer.ts      pure; record → AgentAdapterObservation
      ▼
route.ts           POST /api/agents/claude-code; opaque cursor in/out
      ▼
adapter.ts         client AgentAdapter; polls, emits, no control surface
      ▼
use-claude-code-observer.ts   attaches workspace from explicit mapping
      ▼
ingestObservation (Phase 11)
      ▼
AgentRun / AgentEvent / AgentRunLink
```

| File | Responsibility |
| --- | --- |
| `claude-code/types.ts` | Claude-specific shapes, status map, bounds |
| `claude-code/parser.ts` | Pure line parsing, allowlist extraction |
| `claude-code/normalizer.ts` | Pure record → observation, safe summaries |
| `claude-code/cursor.ts` | Opaque cursor encode/decode, resume logic |
| `claude-code/reader.ts` | `server-only`; registry sweep, incremental transcript read |
| `claude-code/mapping.ts` | Explicit project path → workspace, account-scoped |
| `claude-code/adapter.ts` | `AgentAdapter` implementation; the poll loop |
| `claude-code/contract.ts` | The wire type, shared by route and client |
| `app/api/agents/claude-code/route.ts` | The narrow endpoint |
| `hooks/use-claude-code-observer.ts` | Wires observations into the Phase 11 store |

Dependency direction is one-way and enforced by a test: the generic domain
imports nothing from `claude-code/` and names no provider in its code.

## Security

### Why `messagingSocketPath` is ignored

It is a live named pipe into a running session — a peer can *talk to* Claude
Code through it. Using it would turn Hubble from an observer into a
controller, so that anything able to reach Hubble's state could drive a
coding agent with filesystem access on the user's machine.

It is dropped in the reader's `toRegistryEntry`, appears in **no type** in this
directory, and a test asserts no executable line anywhere mentions it (doc
comments explaining the omission are allowed, and exist).

### Read-only

`reader.ts` is the only module importing `node:fs/promises`, and a test
confirms it. There are no write calls anywhere in the feature — no
`writeFile`, `mkdir`, `unlink`, `rename`, `createWriteStream` — and every
`open()` uses mode `"r"`, asserted by test. Nothing is ever written under
`~/.claude`, and no project file discovered through a transcript is touched.

### No execution

No `child_process`, `spawn`, `exec`, `execFile`, `fork`, `eval`,
`new Function`, worker threads, `vm`, or net/dgram — asserted by test over
imports, dynamic imports, `require` and raw call shapes. No git command is
ever run; `gitBranch` is read from records that already contain it.

### Why arbitrary paths are impossible

The endpoint's only input is an opaque cursor. It reads exactly one field off
the body (`cursor`) and ignores every other, including path-shaped ones —
tested with `path`, `file` and `dir` keys pointing at `System32` and
`/etc/shadow`.

The cursor contains `{sessionId, offset, size}` triples and **no path**. Every
entry is re-validated on the way in: a session id must match a UUID pattern or
the entry is dropped, offsets and sizes must be finite and non-negative, and
at most 64 entries are honoured. A forged cursor naming `../../../../etc/passwd`
is discarded, tested directly.

Transcripts are then located by scanning `~/.claude/projects/*/` for
`<validated-uuid>.jsonl`, so no client value ever reaches a path join.

### Why sensitive fields are allowlisted, not denylisted

A transcript carries prompts, `thinking` blocks and `toolUseResult` payloads
inline — as ordinary content, not as an edge case. A denylist would need
updating every time Claude Code adds a field, and would fail silently when it
was not.

So the parser copies out only: `type`, `uuid`, `timestamp`, `gitBranch`, and
from `tool_use` blocks only `id`, `name`, a **basename** from structured path
input, a shell tool's human-written `description`, and an http(s) `url`.
There is no code path that forwards an unrecognised field.

Specifically never read: `command`, `content`, `old_string`, `new_string`,
`thinking`, `text`, `toolUseResult`, and user message bodies.

Activity summaries are derived from structured values only:

| Tool | Summary |
| --- | --- |
| `Edit` / `Write` / `MultiEdit` / `NotebookEdit` | `Edited <basename>` |
| `Read` / `Grep` / `Glob` / `NotebookRead` | `Inspected <basename>` |
| `Bash` / `PowerShell` | the tool's own `description`, else `Ran a command` |
| a navigation | `Opened a page` (the URL is not in the text) |
| anything else | `Used tool` |

Absolute paths never appear in a summary — asserted by test, and confirmed
against the live session.

### Hosted deployments

On Vercel, `~/.claude` either does not exist or belongs to the deployment
rather than to the person looking at the page. Either way it is not the user's
sessions, so the endpoint returns:

```json
{ "available": false, "sessions": [], "observations": [], "cursor": "" }
```

Nothing is weakened to make a hosted deployment appear to work. This feature
is local/self-hosted by nature.

`CLAUDE_CONFIG_DIR` is honoured so a self-hosted install with a relocated
config directory still works.

## Cursor strategy

The cursor's `offset` **always sits immediately after a newline**. After each
read the reader finds the last `\n` **in the byte buffer** (not the decoded
string, which would drift on any multi-byte UTF-8 — tested with `café-日本.ts`)
and advances only that far.

That single rule gives all the required behaviour:

- **Partial final line** — Claude Code mid-write — advances nothing and is
  re-read whole next poll. No record is ever parsed in half or skipped.
- **No change** — zero bytes available, zero records, offset unmoved.
- **Append** — only the new bytes are read.
- **Truncation or replacement** — `size < offset` means the file is not the
  one the offset belongs to, so reading restarts at 0.
- **First sight** — starts at `size - 64 KB` rather than 0, so attaching to a
  session does not replay a 17 MB backlog of work the user already watched
  happen. The first (window-cut) line is discarded.

Per-poll work is bounded: 24 sessions, 256 KB per session per poll (a larger
backlog is caught up over subsequent polls), 50 observations per session.
Poll interval **5 s**, with overlapping polls prevented by an in-flight guard.

## Identity and deduplication

```
Agent    provider = "claude-code"     — exactly one, resolved by provider
AgentRun externalId = Claude sessionId — one per session
AgentEvent sourceId = tool_use.id      — one per tool invocation
```

Runs are matched on `(agentId, externalId)`, so repeated polling updates one
run. Events dedupe on `sourceId`, so re-reading the same records — which
happens whenever a poll fails and the cursor is deliberately not advanced —
appends nothing. Both are Phase 11 behaviours; this phase supplies the ids.

## Workspace mapping

```
Claude project path  →  Hubble workspaceId
```

Explicit and nothing else. Hubble never infers a workspace from the selected
one, a similar name, a git branch, or resembling tabs.

Path comparison normalises separators, trailing separators and case (Windows
reports the same directory both ways); two different directories never compare
equal. One project maps to exactly one workspace.

The lifecycle:

```
session discovered
      │
      ├── project not mapped  → observation carries no workspaceId
      │                         → Phase 11 reports "unattached", creates nothing
      │
      └── project mapped      → workspaceId attached
                                → AgentRun created or updated
```

A session discovered before its project is mapped is **not lost**: the mapping
is applied on the next poll and the same session attaches, keeping its
identity, cursor position, title and branch.

Mappings live in `tabdump:claude-code-mapping:v1`, registered in
`SCOPED_STORAGE_KEYS`, so they are account-scoped like every other Hubble
domain.

## Status and lifecycle

| Claude Code | Hubble |
| --- | --- |
| `busy` | `working` |
| `idle` | `waiting` |
| anything else | **no status change** |
| `desktop-released.json` present | `cancelled` |

An unrecognised status produces no status at all rather than a guess. Mapping
the unknown onto `failed` would manufacture failures that never happened.

**What cannot be known.** A session that disappears from the registry without
a sidecar is *not* interpreted. Its run keeps its last known status and gets no
`endedAt`, because disappearance cannot distinguish success from failure from
cancellation, and the source provides nothing that can.

The `cancelled` mapping for an explicit release artifact is an honest reading
of the only signal that exists: the user deleted the session record. It is not
a claim that the work failed or succeeded.

## Tab URL linking

Implemented. When an observation carries a URL:

1. normalise it with Hubble's existing `normalizeUrl`;
2. look for an exactly matching saved tab **in the run's own workspace**;
3. on an exact match, create `AgentRunLink(role = "context")` through the
   Phase 11 `addRunLink`, which enforces the workspace boundary.

No tab is ever created, no fuzzy matching is attempted, and no other workspace
is searched. A near-miss link is worse than no link, because it asserts a
relationship that did not happen.

## Verification

### Baseline (post-Phase-11, `34331b3` + uncommitted Phase 11)

| Gate | Result |
| --- | --- |
| Tests | 2915 passed / 91 skipped / 0 failed, 219 files |
| Lint | clean |
| Typecheck | 1 pre-existing error |
| Build | blocked by that same pre-existing error |

Pre-existing, unchanged:

```
test/pg/cluster.ts(88,54): Cannot find module 'embedded-postgres'
```

### After Phase 12

| Gate | Result |
| --- | --- |
| Tests | 3075 passed / 91 skipped / 0 failed, 229 files |
| Lint | clean |
| Typecheck | same 1 pre-existing error, no new ones |
| Build | app compiles; still blocked only by that pre-existing error |

160 tests added across 10 files.

**One build issue was introduced and fixed.** Turbopack's static analysis
flagged the reader's filesystem calls with *"Dynamic filesystem access causes
tracing of the whole project"* — which would have pulled every source file
(and `public/`) into the deployed server bundle. The paths are inherently
dynamic (they are the user's home directory) and cannot be statically scoped,
so each call carries a `/*turbopackIgnore: true*/` marker. Both warnings are
gone; the build's only remaining warning is the pre-existing missing font
override.

### Real manual verification

Performed against an actual running Claude Code session (2.1.270) — this
worktree's own session — not fixtures.

| # | Scenario | Result |
| --- | --- | --- |
| A | Discovery | `available = true`, 1 live session found |
| B | Identity | `externalId = b70abc10-f01a-48de-8d41-8ac936e8eff8`, matching the registry |
| C | Status | registry `busy` → run `working`; title `remove-governing-law-8bc442-b6` |
| D | Workspace mapping | 0 runs while unmapped; after explicit mapping the same session attached to the mapped workspace |
| E | Activity | real summaries from real work: `Edited live-verification.test.ts`, `Run all Phase 12 tests`, `Opened a page` |
| F | Incremental | re-poll at offset 2 743 025 → **0 records**. Two marker commands + one more action → next poll returned **exactly those three activities**, offset advanced 2 767 325 → 2 783 089 |
| G | Persistence | run round-tripped through Phase 11 persistence with `externalId` intact; same session resolves to the same run |
| H | URL linking | a real `navigate` to `https://example.com/docs` was observed, normalised, exact-matched to a saved tab, and linked as `context`; a cross-workspace attempt was refused (`cross-workspace`) |
| I | Security | resulting domain state contained no `pipe`, no `cc-msg`, no `thinking`, no `toolUseResult`, no absolute path in any activity, and **not the marker strings inside the executed commands** — only the human descriptions |
| J | Hosted unavailable | verified by removing the installation: `available: false`, no sessions, no observations, no crash. **Not** verified against a real Vercel deployment — see limitations |

The most telling detail is in F and I together: the two verification commands
were `echo "PHASE12-VERIFY-MARKER-ALPHA"` and `…-BETA`. What Hubble observed
was `Phase 12 incremental marker alpha` and `…beta` — the descriptions. The
marker strings inside the actual commands never appeared anywhere.

## Limitations

- **Local / self-hosted only.** A hosted deployment cannot see the user's
  machine and honestly reports unavailable.
- **Polling, not push.** The only push channel Claude Code offers is the
  control channel, which is deliberately untouched. 5 s interval.
- **No reliable completion signal.** A normally-exiting session leaves no
  artifact, so its run is left at its last known status rather than guessed at.
- **Limited status vocabulary.** Only `busy` and `idle` exist upstream.
- **URL linking is exact-match only**, within one workspace, against tabs that
  already exist.
- **First sight starts 64 KB from the end** of a transcript, so work done
  before Hubble began observing is not replayed.
- **The project path is the one absolute path that reaches the browser**,
  because explicit mapping cannot be offered without showing the user their own
  project. It never appears in an activity summary.
- **Hosted behaviour was verified by simulation**, not on a real deployment.

## Not implemented here

No execution controls, prompts, or intervention of any kind. No file artifact
or generic `Artifact` model, no project file graph, no git commits or branches
as objects (Phase 13). No spatial command center, agent cards, physics or
visualization (Phase 14). No remote agents, multi-agent orchestration, or
additional providers.

## Next phase

Phase 13 — Agent Work Artifacts / File Links, building the project-relative
file model that lets `Edited app-sidebar.tsx` become a real link to a real
file, rather than a basename in a string.
