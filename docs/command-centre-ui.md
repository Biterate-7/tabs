# The Command Centre UI

Phase G. The first surface that drives the Phase F local runtime.

Everything before this phase built the machinery: an observation plane (Phases
11–22), a control plane and its Claude adapter (Phases A–C), a context bridge
(Phase E) and a local execution surface with a typed command protocol (Phase F).
None of it had a user. This phase gives it one, and adds no new backend
architecture to do it.

## What it is

A destination in the existing shell — a `view` in `app-shell.tsx` and a row in
the rail, beside Agent History — laid out in three columns:

```
rail │ sessions │ the active session │ context
```

- **Sessions** (left): every session the runtime holds, grouped Active / Ended.
- **Centre**: the session's header, its normalized event stream, any outstanding
  approval, and the composer.
- **Context** (right): what is actually attached, what was left out and why,
  and what this machine's providers can do.

## The data flow, end to end

Every control in the surface maps to exactly one runtime command. There is no
other path from the UI to a provider, and `lib/agents/command-centre/security.test.ts`
asserts that the set of verbs the surface issues is a subset of the protocol's
closed union.

| UI action | Command | Backend effect | What comes back | What updates |
|---|---|---|---|---|
| Open the Command Centre | `get_status` | Runtime gate decides | `RuntimeStatus` | Banner, provider rows, whether anything is offered |
| — (mount, and on host change) | `authorize_projects` | Host revalidates every path, drops failures | accepted / rejected ids | Project picker |
| — (mount, then poll) | `list_sessions` | — | session views + correlations | Session rail |
| Select a session | `get_session` | — | view + approvals | Header, approval prompt |
| — (poll, cursor) | `get_events` | — | events past `afterSequence` | Event stream |
| New session → Start | `create_session` | Control service opens a provider session | the new view | Rail + header |
| Composer → Send | `send_message` | Adapter delivers, run starts | updated view | Stream, composer state |
| Stop | `cancel_run` | Adapter cancels the in-flight run | updated view | Header, composer |
| Context picker → Attach | `attach_context` | Snapshot validated and attached | updated view | Context inspector |
| Context → Refresh | `attach_context` (second snapshot) | Replaces what the session was told | updated view | Inspector + delta line |
| Approval → Allow / Deny | `respond_to_approval` | Broker resolves the decision | updated view | Prompt resolves, run continues |
| End session | `dispose_session` | Session torn down | id | Rail, selection clears |

`detach_context`, `resume_session` and `link_observation` exist in the protocol
and are not yet driven by this surface. They are listed here so the gap is a
known one rather than a discovery.

## The five hooks

The transport is invisible above `src/hooks/`. Components receive arrays and
async functions; none of them can tell that events arrive by polling rather than
by a subscription, which is what makes replacing the transport a change in one
file.

- `useAgentRuntime` — one client for the mount, the handshake, the status.
- `useAgentProjects` — the browser's authorized projects, and their sync.
- `useAgentSessions` — the session list and the two lifecycle verbs.
- `useAgentSession` — one session's state, approvals, stream and verbs.
- `useAgentContext` — selection, resolution, the attached snapshot and its delta.

## Rules this surface holds to

**Nothing is invented.** No sample agent, no sample conversation, no activity
count that did not come from the runtime. Where the backend has nothing yet, the
UI shows an empty or unsupported state. There is no file-changes panel, because
Phase F reports file events but no durable change set — the stream shows the
events it is actually sent.

**Attached is not available.** The inspector reports the *snapshot*, never the
selection. A workspace ticked and then dropped for a limit appears under "Not
included" with the resolver's own reason.

**Refresh is explicit.** Phase E snapshots are immutable; a refresh mints a
second one and re-attaches it. Nothing re-resolves on its own, so a tab created
after the snapshot never silently reaches a running agent.

**The UI restates backend state; it never computes it.** Session status, run
liveness, capability and runtime availability are all read from the host.
`lib/agents/command-centre/presentation.ts` is the single place they are turned
into words, and every mapping is total over a closed union.

**A path can only be authorized, never sent.** `create_session` names a project
by id. The one place a directory is typed is the explicit "Authorize a folder"
step, which goes through `createProject` — the same validator the host re-runs on
arrival.

## The honest limits

- **The packaged desktop build cannot execute agents.** `pageExtensions: ["tsx"]`
  drops every `route.ts` from the static export, so the control endpoint is not
  in the Tauri app. The client reports `runtime_disconnected` there and the UI
  says so. Phase G adds no Tauri permission to paper over this; a native runtime
  phase is the proper fix.
- **A hosted deployment cannot execute agents**, and says so with the gate's own
  sentence.
- **A browser-served runtime has no trusted path source.** TabDump validates that
  an authorized folder is shaped like a project — not a drive, not a home
  directory, no traversal — but cannot confirm it is the folder the user meant.
  A native folder picker is the fix, and is named in `agent-local-runtime.md`.
- **Codex is not implemented.** The seam exists; the adapter does not. A provider
  that declares no `create_session` renders as a visible, disabled row that says
  why, rather than being hidden or offered and then failing.
