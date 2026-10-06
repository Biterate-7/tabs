# Hubble 1.6 — Project Execution

Hubble's loop becomes **Workspace → Context → Project → Agent → Proposed
action → Approval → Apply → Verify → History**. 1.6 lets a workspace be
associated with a real local project, and makes Hubble the control plane
around the agent's work on it. It is not an editor, a terminal or a file
browser: the agent keeps using its own tools; Hubble decides what it may
touch, asks before anything changes, measures what actually changed, checks
it, can put it back, and remembers the chain.

## 1. Audit (before any code)

| Area | What existed | Where |
| --- | --- | --- |
| Project model | `AgentProject { id, name, source, path, providers, additionalDirectories, permissions }` — a grant of scope over one directory, chosen by a person, never discovered. Path validator refuses roots, home folders, traversal, drive-relative forms. | `control/projects.ts` |
| Project persistence | localStorage (`loadControlProjects`), synced to the runtime by `authorize_projects` (replace, never merge — revocation); the host re-validates every record. | `control/persistence.ts`, `hooks/use-agent-projects.ts` |
| Permissions | 7 scopes; project-scoped `read_project` / `write_project` / `run_commands`; `write_project`, `run_commands`, `write_workspace` ask at every use; nothing granted by default. A folder grant = the agent's Connect-Agent approval ∩ grantable scopes. | `control/permissions.ts`, `platform/roster.ts` |
| Folder choice | Web local runtime: typed path, validated. Desktop: native folder dialog; Rust refuses any `authorize_projects` path that was not picked (`FolderRegistry`). | `new-session-dialog.tsx`, `src-tauri/src/agent_runtime.rs` |
| Execution planes | `local-desktop` (sidecar), `local-server` (explicit opt-in, hosted markers veto), `remote-sandbox` (uploads in a microVM). Browser/hosted: no local execution at all. | `control/runtime.ts`, `runtime/gate.ts` |
| Session ↔ project | `create_session { projectId }` by id only — no path crosses the protocol. Working directory = project root. Handoff target revalidates `isProviderAuthorized`. | `runtime/host.ts`, `runtime/protocol.ts` |
| Agent file work | Agents write files themselves. Every write/command passes the broker (`approval_requested` → Command Centre → `respond_to_approval`). Approvals name project-relative paths only. ACP/Claude/Codex adapters read **no tool content**. | `control/approvals.ts`, `providers/*` |
| Change records | Workspace changes: before/after snapshots, exact undo. **Files: never undoable** — "Hubble doesn't keep a copy". | `activity/inspector.ts`, `lib/collections/restore.ts` |
| Activity / Inspector / History | Pure builders over journal + approvals + changes; Postgres copy of journal-accepted events. Hubble-only event kinds (`context_*`, `handoff_*`, `delivery` slice) are raised by the host and refused from adapters. | `activity/*`, `control/service.ts` |
| Context Pack (1.5) | `buildContextPack` is the only constructor; fingerprint excludes the instruction; `pack-<fp>` is the attached snapshot id; `contextDeliveryState` → "changed" + Send update. `project` and `file` attachment kinds already existed in the control plane but were unused. | `context-pack/*`, `control/context.ts` |
| Workspace | `Workspace { …, brief? }` — **no project link**. The Command Centre's context panel already has a "Project" section showing the session's authorized project. | `lib/workspace/*`, `context-panel.tsx` |

**What could not be done before 1.6:** say which project a workspace is
about; know whether that project is reachable before starting; tell the agent
which project it is in (beyond its working directory); see what an approved
write actually changed; undo a file change; check the result; tell that the
project moved under a delivered context.

## 2. What is reused, unchanged

- **The project model.** A workspace project is a *reference* to an
  `AgentProject` (`Workspace.project = { projectId, attachedAt }`), never a
  second record. Paths stay where they were: in the project grant, on this
  device, never in a pack, an event, an approval or history.
- **Permissions and approvals.** Every project mutation is still an agent
  tool call that the broker gates. 1.6 adds what the broker could not know:
  the measured result.
- **The journal → history path.** Measured changes, undos and checks are
  Hubble-only events (like `handoff_sent`), so the timeline, inspector and
  history read them with no second store.
- **The Context Pack.** The project is one more section of the one pack, with
  the same determinism, scrubbing and fingerprint.
- **The launch layer.** Checks resolve programs with `resolveExecutable` and
  start them with `shell: false` and the stripped agent environment.

## 3. What was missing, and is added

| Piece | Shape |
| --- | --- |
| Workspace link | `lib/workspace/project.ts` — `{ projectId, attachedAt }`, read strictly, kept by the persistence repair pass. |
| Project domain | `lib/agents/project/` — pure: capabilities, readiness, inspection reader, checks, change records, line diff, secret-path rule, presentation wording. |
| Filesystem seam | `lib/agents/project-host/` (server-only; types in `lib/agents/project/seam.ts`) — the **only** code that touches a project's files or runs a check: realpath containment, symlink refusal, bounded reads, the undo write, marker-file detection, `.git/HEAD`, and the check launcher. Imported only by the local and desktop runtime wiring (guard-tested), never by the host, never in the browser. |
| Change ledger | `runtime/project-ledger.ts` — in the host's memory: before-state snapshotted at the moment an approval is granted (before the agent is unblocked), after-state measured when the agent reports the file or the turn ends. |
| Runtime verbs | `inspect_project`, `run_project_check`, `undo_project_change`, `review_project_change` — ids only, no path or command text crosses. |
| Events | `project_changed`, `project_change_undone`, `verification_started`, `verification_finished` — Hubble-only, refused from adapters, kept by history (counts and outcomes, never content). |

## 4. Desktop-only (and local-server-only)

Everything that reads or writes a project file or runs a check requires a
**local** execution plane (`local-desktop`, or `local-server` with the
explicit opt-in) because only there does the runtime run on the machine
holding the project. Concretely:

- **Browser / hosted:** no project attachment. The panel says *"Project
  attachment is available in the Hubble desktop app."* Nothing pretends to
  hold a path.
- **Remote sandbox:** uploaded remote projects keep working as before;
  attaching a *local* project is refused, and no local path is ever sent to a
  remote agent (the pack has no path field).
- **Desktop:** folders come only from the native picker; the Rust bridge's
  screening is unchanged; the sidecar gets the filesystem seam.

## 5. How it connects

```
Workspace.project ──► AgentProject (grant, path — local only)
       │                     │ authorize_projects (+ workspace binding)
       ▼                     ▼
inspect_project ──► ProjectInspection { state, type, git, checks, file states }
       │
       ▼
buildContextPack(… project) ──► pack.project { name, type, location, git, capabilities }
       │                         + "file" attachments for relevant files
       ▼ attach / create_session (host refuses a project attachment that isn't the session's)
Agent ── asks to edit ──► broker ──► Approval card (files, sensitive/changed-outside flags)
       │ granted: ledger snapshots before-state, THEN the agent is unblocked
       ▼
agent writes ──► file events / turn end ──► ledger measures ──► project_changed (+N −M, undoable?)
       │
       ├─► run_project_check ──► verification_started / verification_finished
       ├─► undo_project_change (refused unless every file still equals what the agent left)
       └─► history (events) ──► timeline · Action Inspector · provenance
```

The rest of this document describes each part as built.

Module map: pure domain in `lib/agents/project/` (capabilities, checks,
inspection, describe, changes, diff, secrets, present, seam types); the Node
implementation in `lib/agents/project-host/` (server-only, imported only by
`runtime/server.ts` and `runtime/desktop.ts`); the in-memory ledger in
`runtime/project-ledger.ts`; UI in `components/command-centre/workspace-project.tsx`
and `components/agents/project-work.tsx`; hooks `use-workspace-project.ts`
and the extended `use-session-context-pack.ts`.

## 6. Project model and attachment

- `Workspace.project = { projectId, attachedAt }` (`lib/workspace/project.ts`),
  read strictly by the persistence repair pass. Local to the device, like the
  brief: a path is meaningful only on the machine that holds it.
- `AgentProject.workspaceIds?` — the workspaces a project is attached to,
  derived from the workspaces at sync time (`workspaceProjectBindings`) and
  sent with `authorize_projects`. The host refuses the project to a session in
  any other workspace (`project_scope_violation`), in `create_session`,
  `inspect_project` and the handoff target. A project attached nowhere keeps
  its pre-1.6 meaning.
- Attach flow (context panel → **Attach project**): choose an authorized
  project or authorize a folder (native picker on desktop; typed and
  validated on the opted-in local web runtime) → `inspect_project` → "Hubble
  found Next.js · Git main · 2 checks" and what agents may do → **Attach
  project**, enabled only when the folder is reachable. A new folder is
  authorized for the connected agents with the *intersection* of their
  Connect-Agent approvals.
- States (`lib/agents/project/present.ts`, one sentence each): Connected · Not
  connected · Unsupported ("Project attachment is available in the Hubble
  desktop app.") · Checking · Runtime disconnected · Removed · Moved or
  deleted · Permission denied · Not a folder · Unavailable.
- New session defaults to the workspace's project and cannot start in it while
  it is not ready; the host independently refuses with `project_unavailable`
  ("Hubble can't access this project.").

## 7. Capabilities

`ProjectCapability = read_files | write_files | run_commands |
inspect_repository | run_checks` (`project/capabilities.ts`). The first three
are the project grant ∩ the agent's own adapter capabilities and are enforced
by the adapters' policies and the broker; the last two are Hubble's own and
need a local runtime (and `run_commands` for checks). There is no "git diff"
capability: Hubble measures changes itself.

## 8. Context Pack

`ContextPack.project = { id, name, location, state?, type?, repository?
{ branch, head, detached }, capabilities }`, and `files[]` gain `state` /
`hash` from the runtime's last look. Never a path. `describeProject` is the
one describer (Command Centre, host handoff, demo). The fingerprint covers all
of it, so a commit, a branch switch or an outside edit to a named file makes
the pack "changed"; `contextChangeOf` says **Project changed since … received
it** when nothing else moved, and **Send update** re-attaches. Secret-like
files are left out (`omitted.sensitive`). The projection adds a `project`
attachment (kind, Git, location, what it may do) and `file` attachments; the
host refuses a `project` reference that is not the session's own, and `file`s
for a session without a project. The delivery slice records `projectId` and a
file count, giving the provenance line "hubble project · 3 relevant files".

## 9. Execution, approval and the change model

No new execution path. `respond_to_approval` (granted, `write_project`, a
file action, a local project) first finalizes any open change on the same
files, then `ledger.open` copies each target, then unblocks the agent. File
events and the end of the turn trigger `finalize`, which raises
`project_changed { changeId (= the approval id), files: [{ path, change,
added, removed, sensitive?, binary? }], outcome: applied | partial |
not_applied, undo, contextId }`. The timeline replaces the agent's own
"Edited x" rows with Hubble's measurement; the Action Inspector shows the
measured lines, the verification, Review (live hunks via
`review_project_change`, scrubbed) and Undo.

The approval card for project file actions shows **Project changes · N
files**, per-file warnings (secret-like; changed outside this session since
its last measured change) and **Approve changes** — no line counts, because
none exist before the agent writes.

## 10. Undo

`undo_project_change` re-reads every file; if any differs from what the agent
left (SHA-256), nothing is written: "This change can't be undone because the
project has changed since it was made." Otherwise each file is written back
by temp file + rename (a created file is removed). There is no force option.
Undo is unavailable, with its reason, for secret-like files, files over
512 KB, links or outside paths, files Hubble never saw, after a runtime
restart (copies are memory-only), and from history (read-only).

## 11. Verification and Git

`run_project_check { sessionId, check }`, check ∈ typecheck | lint | test |
build | git_status. The runner re-reads `package.json` at run time, runs
`npm run <script>` through Hubble's own Node (npm's CLI resolved the way the
agent launcher follows shims) or `git -c core.fsmonitor=false
--no-optional-locks status --porcelain`, with `shell: false`, the stripped
agent environment plus `CI=1`, a 10-minute bound and whole-tree kill, and
output discarded (Git's is counted). `verification_started` /
`verification_finished` carry outcome, exit code, duration, Git counts and
the change being verified. A check needs the project's `run_commands` grant,
one at a time per session. The branch and commit come from `.git/HEAD`
without running Git.

## 12. History, handoff, provenance

The four event kinds pass through `historyEventOf` (paths, counts, outcomes)
and revive through the same validator; history views pass no project
actions, so they are read-only. The handoff target's pack carries the project
described for the target agent (`describeProjectFor`), after the existing
`isProviderAuthorized` check and the new workspace binding.

## 13. Security summary

| Threat | Defence |
| --- | --- |
| `../`, absolute, drive-relative paths | rejected on the wire, in the broker, in `isAcceptableRelative`, and by realpath containment |
| Symlink / junction escapes | the nearest existing ancestor's realpath must stay inside the real root; a link at the target is refused |
| Secret files | `isSecretLikePath`: never read, copied, diffed, packed or undone |
| Arbitrary commands | closed check ids; the script re-read from disk; literal argv; no shell |
| Repository-configured programs via Git | fsmonitor off, optional locks off; only `status` |
| Cross-account / cross-workspace | per-actor project maps; workspace binding enforced by the host |
| Agents forging Hubble's records | the service drops the four kinds from adapters |
| Logs / history | no contents, output, environment or command text: counts and outcomes only |

## 14. Landing demo

Development workspace, `hubble` project, Codex asking to modify two auth
files. Its deterministic adapter (`marketing/demo/demo-project.ts`) holds two
versions of each file; the numbers come from `lineDiff`, the description from
`describeProject`, every sentence from `lib/agents/project`. Approve →
measured change → tests pass → inspector → review → undo; a past session in
history is read-only. `demo-parity.test.tsx` pins the shared components and
forbids restated wording.

## 15. Limitations

- The workspace ↔ project link is per device (as the brief is); a path cannot
  travel between machines.
- Proposed line counts are not shown before approval: providers' proposals are
  not read (the adapters deliberately read no tool content). Hubble measures
  after the write.
- Copies for undo and review live in the runtime's memory (64 MB cap, oldest
  released first); a restart ends undo for earlier changes.
- A stale project context is flagged on the approval card and refused for
  undo; agent writes are not auto-rejected, because agents re-read before
  editing.
- Remote (sandbox) projects keep working as before but cannot be attached to a
  workspace in 1.6; hosted and browser builds show Unsupported.
- Checks run with the stripped agent environment; a suite that needs a secret
  from the environment fails here and says so (exit code) rather than passing.
- When a handoff leaves the workspace unshared, the project travels only as
  the target session's project, not inside a pack.

## 16. Verification record

Gates: `npx tsc --noEmit -p .`, `npm run lint`, `npm run build`, `npm run
desktop:export` and the full suite (with real Postgres) — see the commit
message for the counts. Live QA ran on `next dev --webpack` with the local
runtime opt-in, embedded Postgres, scripted ACP agents standing in for Gemini
and Grok, and a real Git project:

- attach (choose → "Hubble found Next.js · Git main · 4 checks" → attach);
- Gemini research session: the agent received the project line (kind,
  branch and commit, location, what it may do) — no path, no `.env` value;
- handoff Gemini → Grok: Grok received brief, project (described for Grok),
  previous result and instruction — no transcript, path or secret;
- approval "Project changes · 2 files" → approve → measured `+17 −6` →
  review hunks → Tests passed → Git status "2 modified" → undo, disk clean;
- second change, outside edit → "Project changed since Grok Build received
  it" → undo refused with the canonical sentence, edit untouched → Send update;
- dev server stopped and restarted → history keeps every session, the
  measured change, both undo outcomes and provenance, read-only;
- 390 px: no horizontal overflow on New session, approval, inspector, context
  popover or history; reduced motion collapses transitions and animations.

Two defects found and fixed during QA: overlapping event reads (poll +
refresh) could append the same events twice (`use-agent-session.ts`, with a
regression test), and a runtime that restarted under an open page made the
attach preview say the project was unreachable (now one re-handshake, and
runtime failures are reported as such).
