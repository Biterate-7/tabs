# Phase 13 — Agent Work Artifacts / File Links

What project files an agent run worked on, and how.

```
Agent
  └── AgentRun
        ├── AgentRunLink          → Tab          (human context surface)
        ├── AgentEvent            → activity log
        └── AgentRunArtifactLink  → WorkArtifact (project work target)
```

The invariant:

> **Hubble knows what project files an agent run worked on.
> Hubble does not own, read, modify, or execute those files.**

## Why this exists

Phase 12 could say *"Edited sidebar.tsx"*. That is a string. It cannot answer
"which files has this run touched", "what else has been done to this file", or
"is this the same `sidebar.tsx` the other run edited" — because a basename in
a sentence is not an identity.

This phase gives the file an identity, and gives the run a typed relationship
to it. Nothing more: there is no file content, no diff, no history, and no
viewer.

## Model

| File | Responsibility |
| --- | --- |
| `agents/paths.ts` | Absolute or relative path → project-relative, or refusal |
| `agents/artifacts.ts` | `WorkArtifact` and `AgentRunArtifactLink` reducers |
| `agents/types.ts` | The two entities, roles, kinds, state shape |
| `agents/persistence.ts` | Sanitisation on read, including re-validating paths |
| `agents/selectors.ts` | Run→files, file→runs, workspace→files |
| `agents/adapter.ts` | `AgentArtifactObservation` + provider-neutral ingestion |
| `claude-code/parser.ts` | Keeps raw tool paths, server-side only |
| `claude-code/normalizer.ts` | Tool → role, path → project-relative |
| `hooks/use-agent-store.ts` | `recordArtifactWork`, `pruneOrphanedArtifacts` |

```ts
WorkArtifact {
  id            // derived — see Identity
  workspaceId
  projectPath   // the project root
  relativePath  // path within it, forward-slashed
  kind          // "file"
  createdAt
  updatedAt     // when last worked on
}

AgentRunArtifactLink { id, runId, artifactId, role, createdAt }
```

There is deliberately no `metadata`, `payload`, `content`, `size` or `hash`
field. An open bag would make this a knowledge graph, which is what the phase
is specifically not.

## Identity

```
workspaceId + projectPath + relativePath
```

All three are load-bearing:

- **relativePath, not filename** — `src/lib/foo.ts` and `test/foo.ts` are
  different files, and so is `src/lib/foo.ts` in another project.
- **projectPath** — a workspace may contain several project directories. A
  workspace is not a filesystem project, and this phase does not pretend
  otherwise.
- **workspaceId** — the same file reached from two workspaces is two
  artifacts, because a workspace is the boundary everything else respects.

The id is derived (`wa-<workspace>::<normalized project>::<relative path>`),
never minted. The same file observed on a hundred polls resolves to one
artifact — which is the whole reason a random id would have been wrong.

The project path is case-folded and separator-normalised for identity, so
`C:\repo\project` and `c:/repo/project/` are one project. The relative path
keeps its case, because it is also what gets displayed.

## Path normalization

`toProjectRelative(projectPath, candidate)` is the gate between "somewhere on
a machine" and "a file in this project". It is pure string manipulation:
`node:path` would resolve against the *host's* rules and its own cwd, and the
paths here come from another process's records — Windows paths possibly read
on POSIX or the reverse.

| Input | Result |
| --- | --- |
| `/repo/project/src/foo.ts` | `src/foo.ts` |
| `C:\repo\project\src\foo.ts` | `src/foo.ts` |
| `src\foo\bar.ts` | `src/foo/bar.ts` |
| `./src/foo.ts`, `src/./foo.ts` | `src/foo.ts` |
| `src//lib///foo.ts` | `src/lib/foo.ts` |
| `package.json` | `package.json` |
| `../../secret.txt` | **rejected** `escapes-root` |
| `C:\other-project\secret.txt` | **rejected** `outside-project` |
| `C:\repo\project-other\foo.ts` | **rejected** `outside-project` |
| `C:foo.ts` | **rejected** `unsupported-form` |
| `C:\`, `.`, `""` | **rejected** `empty` / `unsupported-form` |

Three details worth stating:

- **`project-other` is not inside `project`.** The containment check requires
  a separator, so a sibling sharing a prefix is not swallowed.
- **Drive-relative `C:foo` is refused**, not guessed. It means "foo relative
  to the cwd *on drive C*", which is per-process state this code cannot see;
  guessing would silently file a file under the wrong project.
- **Case follows the platform.** A Windows root matches case-insensitively,
  as the filesystem does. A POSIX root matches exactly, because `/repo/Project`
  and `/repo/project` really are two directories.

A rejected path yields **no artifact at all** — never an artifact carrying an
absolute path.

## Roles

`inspected` · `edited` · `created` · `deleted`

From Claude Code:

| Tool | Role |
| --- | --- |
| `Read`, `Grep`, `Glob`, `NotebookRead` | `inspected` |
| `Edit`, `MultiEdit`, `NotebookEdit` | `edited` |
| `Write` | `edited` — see below |
| anything else (incl. every `mcp__*`) | no artifact |
| `Bash` / `PowerShell` | no artifact |

**`Write` maps to `edited`, not `created`, and that is a deliberate
under-claim.** Claude Code's `Write` input is `{file_path, content}`; it says
nothing about whether the file existed. The only way to find out would be to
stat the file, which this phase does not do — it is observational, and
touching the project's filesystem is out of scope. Between two wrong answers,
`edited` claims less: saying a run "created" a file it actually overwrote is a
false statement about history, while "edited" is true either way.

So **Claude Code currently produces neither `created` nor `deleted`.** Both
remain in the vocabulary for a provider that can distinguish them. There is
also no delete tool in the observed vocabulary.

Roles are part of link identity, so one run may hold both `inspected` and
`edited` on one file — a real sequence, not a duplicate.

## Security

- **No file contents, ever.** `Edit`'s `old_string`/`new_string` and `Write`'s
  `content` are never read; the parser's allowlist has no path to them.
- **No arbitrary filesystem access.** Phase 13 adds no endpoint and no reader.
  The only filesystem access in the product remains Phase 12's narrow,
  server-only Claude Code observer.
- **No filesystem crawler.** Artifacts come from observations. Nothing scans,
  walks, or watches a project directory.
- **No execution, no git, no control channel.** Every Phase 12 guarantee is
  unchanged and still asserted by the same tests.
- **Traversal protection at two layers** — at normalization, and again in
  `loadAgentState`, which re-validates every stored relative path and drops
  any that is absolute, escapes its project, or whose id does not match its
  own contents. Storage is not a trust boundary.
- **Paths come only from structured tool input** (`file_path`, `path`,
  `notebook_path`). Nothing is scraped from prose: a path mentioned in a
  model's text or reasoning produces no artifact, and this is tested.

### The one absolute path that is stored

`WorkArtifact.projectPath` holds the project **root** — and the derived `id`
embeds it. This is the same documented exception Phase 12 already makes: the
explicit project→workspace mapping cannot be offered without showing the user
their own project directory, and the root is part of what distinguishes two
projects holding the same relative path.

Verified against live state: the only fields containing an absolute path are
`artifact.projectPath` and `artifact.id`. `relativePath`, every event summary,
and every run field are free of it.

## Persistence

Namespace `tabdump:agents:v1` — the existing agent key, extended. **Additive
and backward compatible:** state written before artifacts existed simply has
neither array, and loading defaults both to empty rather than rejecting the
record. No existing agent, run, event, tab link, Claude mapping or cursor is
invalidated, and no migration is required.

Account scoping is unchanged: the same `scopedKey` mechanism, so one account's
artifacts and links are invisible to another.

Sanitisation drops, individually: artifacts with an unknown `kind`, a missing
field, an invalid timestamp, a duplicate id, a path that no longer normalises
to itself, or an id that does not match its contents; and links whose run or
artifact is gone, whose role is unrecognised, or **whose run and artifact are
in different workspaces**.

### Retention

Artifacts are **not** capped or aged out the way events are. An event is a
moment; an artifact is a durable fact about a project, and discarding the 201st
file a run touched would be losing real information.

Growth is bounded by *identity* instead: the same file resolves to the same
artifact forever, so the set is bounded by the number of distinct files
actually worked on.

The one thing that could accumulate is an artifact whose every run has been
deleted — unreachable and undisplayable. `pruneOrphanedArtifacts` collects
those, and it is **explicit rather than automatic**, because pruning discards
data the user may still care about. Deleting a run removes its artifact links
but keeps the artifacts, so a file worked on by two runs survives the deletion
of one.

## Verification

### Baseline (post-Phase-12)

| Gate | Result |
| --- | --- |
| Tests | 3075 passed / 91 skipped / 0 failed, 229 files |
| Lint | clean |
| Typecheck | 1 pre-existing error |
| Build | blocked by that same pre-existing error |

```
test/pg/cluster.ts(88,54): Cannot find module 'embedded-postgres'
```

### After Phase 13

| Gate | Result |
| --- | --- |
| Tests | 3205 passed / 91 skipped / 0 failed, 233 files |
| Lint | clean |
| Typecheck | same 1 error — **pre-existing, unchanged** |
| Build | app compiles; blocked only by that same pre-existing error |

130 tests added across 4 new files, plus additions to existing suites.

### Real manual verification

Performed against this worktree's own live Claude Code session (2.1.270), not
fixtures. The files below are ones this session genuinely worked on while the
verification ran.

| # | Scenario | Result |
| --- | --- | --- |
| A | File observation | 2 artifact observations from 25 real transcript records |
| B | Relative identity | `src/lib/agents/paths.ts`, `src/lib/agents/claude-code/live-artifacts.test.ts` — **0** containing an absolute path, **0** escaping the project |
| C | Relationship | both roles from real work: `paths.ts : inspected` (a real Grep), `live-artifacts.test.ts : edited` (a real Write) |
| D | Deduplication | ingesting the same batch twice: pass 1 `artifacts=2 links=2 runs=1`, pass 2 **identical** |
| E | Multiple runs | a second run on the same real file → **1 artifact, 2 run links** |
| F | Workspace isolation | a run in another workspace got its **own** artifact, did not reuse the first, and **0** links crossed a workspace |
| G | Sensitive data | state contains no `thinking`, no `toolUseResult`, no `old_string`, no `"content"`, no `pipe`. Absolute paths appear in exactly `artifact.projectPath` and `artifact.id` — the project root, by design |
| H | Persistence | saved and reloaded: `status=loaded`, artifacts and links intact with roles and workspaces preserved |
| I | Phase 12 intact | session discovery, `status=working`, incremental cursor, tab linking still works, cross-workspace tab link still refused, events recorded, exactly 1 agent |

## Limitations

- **No `created` or `deleted` from Claude Code** — the source cannot
  distinguish them, and this phase will not stat the filesystem to find out.
- **No file contents, diffs, versions, snapshots or line-level history.**
- **No Git** — no commits, branches-as-objects, or diff integration. Branch
  metadata observed in Phase 12 is preserved on runs; nothing more.
- **No file viewer, preview, syntax highlighting, or open-in-editor.**
- **No filesystem watcher or project crawler.** A file Hubble has not seen an
  agent touch does not exist in this model.
- **Artifacts are only as complete as what was observed.** Work done before
  Hubble started observing a session is not represented.
- **Local/self-hosted only**, inherited from Phase 12. A hosted deployment
  reports `available: false` and fabricates no artifacts.

## Phase 14 handoff

Phase 14 can now consume, without any of it being built here:

```
Agent
  └── AgentRun               status, title, currentActivity, gitBranch
        ├── AgentEvent       bounded, safe activity log
        ├── AgentRunLink     → Tab          role: context | produced
        └── AgentRunArtifactLink → WorkArtifact
                                   role: inspected | edited | created | deleted
                                   workspaceId + projectPath + relativePath
```

Selectors ready for it: `getArtifactsForRun`, `getRunsForArtifact`,
`getArtifactsForWorkspace`, `getArtifactLinksForRun`,
`getArtifactLinksForRunByRole`, `getArtifactRoles`, `findArtifactByIdentity`,
alongside the Phase 11 run and event selectors.

Phase 14 owns the spatial command center: placement, physics, cards, halos and
interaction. None of it exists yet, deliberately.
