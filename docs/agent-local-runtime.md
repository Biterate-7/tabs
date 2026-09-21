# The Local Agent Runtime

> **The browser asks. The control plane authorizes. The local runtime
> executes. The provider adapter speaks to the provider.**

The control plane (`docs/agent-control-architecture.md`) established *what*
may be asked of an agent. The Claude integration (`docs/claude-code-control.md`)
established *how* one provider is driven. The context bridge
(`docs/agent-context-bridge.md`) established *what an agent is told*.

This document is the missing piece between them: the trusted surface on which
all three actually run, and the correlation layer that joins what TabDump
*did* to what TabDump *saw*.

---

## 1. The shape

```
                          ┌────────────────────────┐
                          │       TABDUMP UI       │
                          │   (browser / desktop)  │
                          └───────────┬────────────┘
                                      │
                      one of 14 typed commands, no paths,
                      no provider options, no shell
                                      │
   ═══════════════════════════════════╪═══════════════════ TRUST BOUNDARY
                                      │
                          ┌───────────▼────────────┐
                          │     LOCAL RUNTIME      │
                          │  lib/agents/runtime/   │
                          │                        │
                          │  gate ─ built once     │
                          │  ownership per actor   │
                          │  event journal         │
                          │  correlation registry  │
                          └───────────┬────────────┘
                                      │
                          ┌───────────▼────────────┐
                          │    CONTROL SERVICE     │   ◀── context bridge
                          │  runtime · provider ·  │       attaches snapshots
                          │  capability · session ·│       here, separately
                          │  project · permission  │
                          └───────────┬────────────┘
                                      │
                          ┌───────────▼────────────┐
                          │    PROVIDER ADAPTER    │
                          │  ClaudeCodeControl…    │
                          └───────────┬────────────┘
                                      │
                          ┌───────────▼────────────┐
                          │   Claude Agent SDK     │
                          └───────────┬────────────┘
                                      │
                             normalized events
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
           ┌────────▼────────┐              ┌───────────▼───────────┐
           │ control history │              │  CORRELATION REGISTRY │
           │  (the journal)  │              │                       │
           └─────────────────┘              └───────────┬───────────┘
                                                        │
                                              ┌─────────▼─────────┐
                                              │  OBSERVATION      │
                                              │  (independent)    │
                                              └───────────────────┘
```

The arrow into observation points **out of** the correlation registry, not
into it. That direction is the whole design of §7.

---

## 2. Where the trust boundary is

**It is the construction of the runtime host**, not a check inside it.

`createRuntimeHost` cannot be called without an `ExecutionGateResult`. A
refused gate produces a host that answers `get_status` truthfully and refuses
everything else, permanently, with no path to re-deciding. The decision is
taken once, at the one point in the process where a real server environment
was available, so nothing a request carries can influence it.

That is why the gate is a constructor argument rather than a per-command
consultation. A check inside a command handler is a check somebody can
forget to write in the fifteenth handler.

### What the browser is on the far side of

A transport that carries **data, not closures**. The browser cannot construct
a host, cannot reach an adapter, cannot name a path, cannot name a provider
option and cannot name its own identity. It can send one of fourteen verbs.

---

## 3. Runtime identity

`lib/agents/control/runtime.ts` decides; `lib/agents/runtime/gate.ts` is the
single entry point every execution path crosses, and projects the answer into
four environments a UI can reason about.

| Environment | Executable? | Provider access | Behaviour |
|---|---|---|---|
| `browser` | no | none | `get_status` says "this build cannot run agents". Everything else refuses. |
| `local` | **yes** | full, subject to the control plane's gates | The product. |
| `hosted` | no | none | Refuses. Cannot be overridden by the opt-in — the hosted veto is ordered first. |
| `unknown` | no | none | Refuses. The default answer, including for an empty environment. |

`local-desktop` and `local-server` both project to `local`: the difference is
which transport reached the runtime, and a client asking "can I use this" does
not care. `unknown` stays distinct from `hosted` even though they behave
identically, because telling a developer who forgot the opt-in that they are
on a hosted platform would be false.

### What does not make a runtime local

None of these appears in the decision, and the guard suites assert it:

- `Host: localhost`, a loopback remote address — set by whoever made the
  request; true for every visitor to a hosted server behind a proxy.
- The user agent — a string the client chooses.
- `window.__TAURI_INTERNALS__` — a browser global. Right for rendering
  decisions, wrong here, because the decision must not be made in the browser.
- "the `claude` binary is on PATH" — true on any developer's hosted box.
  Presence of a tool is not authorization to run it.
- `NODE_ENV !== "production"` — a build flag, not a statement about whose
  machine this is.

What is required is exactly one of: **the desktop shell** (local by
construction, and see §5 for why it has no transport today), or **a deliberate
operator opt-in** — `TABDUMP_LOCAL_AGENT_RUNTIME` set to one exact string, on
a process showing no sign of being a hosted platform.

---

## 4. The execution gate

```
assertLocalExecutionAllowed(env)   ← the one gate; takes an environment, reads none
denyLocalExecution()               ← the answer where there is no server at all
```

One boundary, not one per provider. No adapter has an `isVercel()` of its own,
and `security.test.ts` asserts that `process.env` is read for this purpose in
exactly one module: `lib/agents/runtime/server.ts`.

A refusal is always `runtime_unavailable`, whichever check fired. A user
deciding whether to install something or move machines needs one answer, not
one that varies with the internals.

The refusal sentence never names the opt-in variable. That sentence is
renderable by a hosted deployment, and it must not be instructions for
turning execution on.

---

## 5. The transport

**A Next.js route handler on the Node runtime: `POST /api/agents/control`.**

### Why this rather than Tauri

TabDump's desktop shell is a **static export** loaded from `tauri://localhost`.
`next.config.ts` sets `pageExtensions: ["tsx"]` for the desktop target, which
drops every `route.ts` from the route tree. The transport that exists in every
context where agents can legitimately run — `npm run dev`, a self-hosted
`next start` on the user's own machine — is a route handler, and that is also
what the existing local Claude Code *observation* endpoint already is.

Adding a Rust command would mean either reimplementing the control plane in
Rust, or having Tauri spawn a Node process to host it: a second runtime, a
second lifecycle, and a second place for the trust boundary to be wrong.

### The honest consequence

**The packaged desktop build has no local execution surface.** `get_status` is
unreachable there and the client reports `runtime_disconnected`. This is
recorded rather than papered over, and it is the single largest gap Phase F
leaves. Closing it is a desktop-architecture decision, not a runtime one.

Phase F adds **no Tauri command and widens no permission**. The capability
manifest is still `["core:default"]` and the guard suite asserts it.

### What the route does, and only this

1. **Same-origin plus a required JSON content type.** The one real
   browser-borne threat against a localhost server is a page the user happens
   to visit calling `fetch` on it. A cross-site form, image or classic script
   tag cannot set a JSON content type without a preflight that nothing here
   answers. Reuses `lib/auth/origin.ts`.
2. **Identity.** The signed-in account where a deployment has accounts; the
   anonymous local actor where it does not. Derived from the request, never
   read from the body — which is why `RuntimeCommand` has no actor field.
3. **The generation check.** See §6.
4. **Delegate.** No control logic, no provider knowledge, no path handling, no
   permission decision.

A well-formed command always answers `200`, whatever the host decided: the
result carries the outcome, so a caller has one shape to read.

---

## 6. `runtimeId` — a generation guard, not a credential

Every command but `get_status` must carry the host's `runtimeId`. It is
**not a secret**: it travels in a response, it is not authentication, and it
proves nothing about who is calling.

What it proves is that client and host are the same generation. A browser tab
left open across a server restart is told `runtime_disconnected` and
re-handshakes, instead of silently addressing sessions that no longer exist —
which, from the UI, looks like every session vanishing at once.

**What TabDump does not do here, and why.** A browser-served local runtime has
no way to distinguish the user's own page from another process on the same
machine beyond the origin check and the session cookie. Inventing a
"local secret" delivered over the same channel any local caller can reach
would not change that, and would read like a guarantee it is not. The honest
statement is: cross-site is closed, cross-account is closed, and
same-machine-different-process is bounded by the project validator (§8)
rather than by authentication.

---

## 7. Control, observation, correlation

The three words are kept apart deliberately.

| | Knows | Does not know |
|---|---|---|
| **CONTROL** | control session id, control run id, and eventually the provider's own session id | anything about what observation ingested |
| **OBSERVATION** | the provider session id read off a transcript, the observing agent, the domain `AgentRun` it minted | who started it, or whether anybody did |
| **CORRELATION** | that those two describe the same provider session | — |

**The evidence is the provider session id, and nothing else.** It is the one
identifier both planes independently arrive at: `AgentRun.externalId` on the
observation side, the id Claude reveals on its first stream frame on the
control side.

### What the registry may never do

Label observed activity as controlled because it is convenient. A session
somebody started in a terminal five minutes ago genuinely has no control run,
and a registry that invented one would make the command centre claim TabDump
did something it did not do.

So every field is optional, and a record with only the observation half is a
**complete, valid record** rather than a partial one waiting to be filled in:

```
TabDump-started run:   controlSessionId + controlRunId + providerSessionId
                       (+ observationAgentId + observationRunId, once linked)

Externally started:    providerSessionId + observationAgentId + observationRunId
                       and no controlRunId, ever
```

`isControlled()` is the single function that answers "did TabDump drive this",
and it requires a **run**, not merely a session: a session created and then
failed before a run started drove nothing.

### Observation does not depend on this

Nothing under `lib/agents/claude-code/`, `lib/agents/connectors/`, or the
domain ingestion path imports the runtime module, and `security.test.ts`
asserts it. Observation must keep working with the control plane switched off
entirely — which is a hosted deployment's permanent state. Correlation is
something a reader *consults*, never something ingestion *needs*.

The seam is one command, `link_observation`, supplied by the side that owns
the domain. It associates three ids and can do nothing else.

---

## 8. Projects, and the limit of what this proves

Every command names a project by **id**. The host resolves it. There is no
field on any command into which a directory could travel — except the project
record itself, on `authorize_projects`.

The durable project record lives in the browser (TabDump is local-first), so
the host has to be told about one before an id can mean anything. It does not
trust what arrives: every path goes back through `validateProjectPath` and
`createProject`, which reject filesystem roots, home directories, unresolved
and traversing paths, and refuse a grant the permission model calls
incoherent. A record that fails is dropped and named in the reply.

**What that buys:** a caller cannot widen a project into somewhere the
validator refuses, cannot grant itself scopes the model rejects, and cannot
reach another actor's projects.

**What it does not buy:** a guarantee that the path is one the user actually
pointed at. A browser-served runtime has no trusted path source to compare it
against. The thing that would provide one is a **native folder picker in the
desktop shell**, and it is named here as future work rather than pretended to.

The grant always comes from the project, never from the request. A client
cannot ask for permissions; it can only name a project the user authorized.

---

## 9. Session lifecycle

Unchanged from the control plane — Phase F introduces no new states and no
conflicting ones. `SESSION_TRANSITIONS` remains the exhaustive table.

```
  created ──▶ connecting ──▶ ready ──┬──▶ running ──┬──▶ ready
     │            │            │     │              │
     │            │            │     ├──▶ waiting_for_approval ──▶ running
     │            │            │     ├──▶ waiting_for_input    ──▶ running
     │            │            │     │
     ▼            ▼            ▼     ▼
  ╭──────────────────────────────────────────╮
  │  completed · cancelled · failed ·         │   terminal; nothing leaves
  │  disconnected                             │
  ╰──────────────────────────────────────────╯
```

`disposed` is not a status. Disposal removes the session from the host
entirely: there is no record left to be in a state, which is stronger than a
state nothing may leave. A command naming a disposed session gets
`session_not_found`.

---

## 10. Runs

```
control session ──▶ control run ──▶ bound to adapter ──▶ every event carries runId
```

A run is minted when the session starts driving a provider — the process is
live the moment the session is — and a **new** run for each subsequent turn
once the previous one ended. `service.attachRun` and the adapter's `bindRun`
are both called; before Phase F they existed and nothing invoked them.

**Concurrent runs within one session are refused**, explicitly, with
`invalid_session_state`. One provider process holds one conversation; two
turns interleaved on one event stream could not be untangled afterwards.
Explicit serialization over unsafe concurrency.

The control run id is **not** a second run system. The agent domain owns
`AgentRun`; what the host mints is TabDump's own identifier for one stretch of
driving, which the correlation registry then joins to whatever observation
independently discovers.

---

## 11. Event ordering and idempotency

**A timestamp is not an order.** Two events can share a millisecond; a clock
can step backwards over an NTP correction; one provider message can normalize
into three events that all read `now()` once. A UI that rendered a tool result
above the tool call that produced it would be showing something false.

So the journal stamps a monotonic `sequence` per session, starting at 1. It is
not a guess about provider ordering — it is the exact order this runtime
received them, which is the only ordering this runtime can honestly assert. If
a provider ever supplies its own sequence, that belongs beside this one.

**Idempotency** deduplicates on the strongest identity available: `provider +
sourceId` when the provider gave one, `event.id` otherwise. A duplicate is
*dropped*, never renumbered, so it never reaches a listener and cannot produce
a second approval, a second tool execution or a second completion.

The journal is bounded (500 events per session, 100 sessions) and reports
`truncated` and `oldestSequence`, so a client whose cursor has fallen off the
back is told rather than handed an incomplete history silently.

---

## 12. Reconnect and resume

A **browser disconnect does not kill anything.** Nothing in the host is tied
to a client's lifetime; a refresh is a fresh `list_sessions` against a runtime
that never noticed.

```
UI reconnects ──▶ get_status ──▶ list_sessions ──▶ get_events(afterSequence)
```

`resumable` is true only when **both** halves hold: a provider session id
exists *and* the adapter declares `resume_session`. Neither alone is enough,
and claiming resumability without both is how a UI offers a button that cannot
work.

The host does not persist. It is the *live* layer: its sessions are sessions a
provider process is actually attached to. The durable record is the browser's
(`lib/agents/control/persistence.ts`), which already restores everything live
as `disconnected` — so a remembered session is reattached by an explicit
resume, never by being told it is still running. Never claim a session is
alive if the provider cannot prove it.

---

## 13. Cancellation and cleanup

Cancellation reaches the provider's own interrupt through the adapter. There
is deliberately no path that marks a session cancelled without the provider
having been told: a status reading "cancelled" over a process still editing
files would be the worst lie this system could tell.

Cleanup:

- **`dispose_session`** cancels a live session *before* forgetting it. A
  session dropped from the host's map with its process still running would be
  a process nothing could reach.
- **`disposeRuntimeHost()`** cancels every session, then disposes each
  service, then the adapter — which is what actually releases the provider
  processes.
- **`SIGINT` / `SIGTERM` / `beforeExit`** are wired to it, then re-raise with
  the handler removed so the correct exit code still ends the process. Without
  this, killing a dev server mid-run leaves Claude Code children orphaned.

---

## 14. Approvals

The broker stays authoritative and there is no second approval system.

```
Claude ──▶ canUseTool ──▶ adapter emits approval_requested
                                    │
                          ControlService mints the broker record
                                    │
                        journal ──▶ runtime ──▶ future UI
                                    │
                          respond_to_approval (ownership checked)
                                    │
                          broker settles FIRST, then the adapter
```

Phase F closed a real gap: `approval_requested` events previously reached no
broker at all, so `respondToApproval` could never find the record. The service
now mints it through a provider-neutral accessor (`approval-details.ts`) — the
adapter still has no route to the broker, and a provider adapter importing the
broker still fails the build.

Two refusals, deliberately opposite:

- **`scope-needs-no-approval`** → granted immediately. The grant already
  settles it (a read inside an authorized project), and a dialog saying
  "Claude would like to read a file you already let it read" is how people
  learn to click yes without looking.
- **anything else, or a request the adapter cannot describe** → denied. An
  approval nobody can answer must not become one nobody has to.

Either way the adapter gets an answer. Leaving one unanswered blocks the
provider on a decision that can never arrive.

An **approval id is not a capability**. It travels in an event; answering one
requires owning the session it belongs to. An actor who does not is refused by
a service that holds no record of it.

---

## 15. Context

Phase E's bridge is unchanged. A snapshot attaches to a session through
`attach_context`, and the host consults **nothing** on the way: not the grant,
not the project, not the capability set.

```
context ≠ permission        attaching a workspace grants no scope
context ≠ project scope     attaching a project's metadata authorizes no directory
```

`create_session({ projectId, context })` validates both independently. A
session started with project context and a grant of nothing still refuses
every local-effect operation, and the security suites assert it on both sides
of the boundary.

A malformed snapshot fails the attach (`context_invalid`) rather than being
silently dropped — silently less context than the caller attached is the quiet
failure the omission model exists to prevent.

---

## 16. The error model

Closed codes, messages from a fixed table, nothing interpolated:

```
runtime_unavailable      runtime_disconnected     ownership_denied
provider_unavailable     authentication_required  session_not_found
invalid_session_state    permission_denied        approval_required
project_scope_violation  context_invalid          provider_error
cancellation             timeout                  invalid_request
unsupported
```

No message names an environment variable, a path, a port, a command line or a
provider's own error text. The guard suite checks every one.

---

## 17. Security invariants

Each is asserted mechanically, because each fails silently if it regresses.

| Invariant | Where it is enforced |
|---|---|
| The browser cannot execute a provider | No component or hook imports the host, the server wiring or an adapter |
| A hosted runtime cannot execute | Gate refuses; the shipped wiring also withholds the adapter resolver |
| An unknown runtime cannot execute | Default is no, not "no unless something looks local" |
| No arbitrary shell | Fourteen-verb closed union; no `exec`/`spawn`/`shell` in the module |
| No arbitrary filesystem | No `read_file`/`write_file` verb; no `node:fs` import anywhere in the module |
| No path from a client | Projects named by id; the one record that carries a path is revalidated |
| Project scope enforced | Grant comes from the project, resolved per actor |
| Cross-account denied | One control service per actor; another's sessions are not reachable, not merely refused |
| Approval broker authoritative | Runtime mints no approval; adapter has no route to the broker |
| No credentials anywhere | No credential field in the module; status and session views carry no env value, token or path |
| Desktop capabilities unchanged | `["core:default"]`, asserted |

---

## 18. What the future Command Centre can ask

All of it through typed commands, none of it requiring a new surface:

| Question | Command |
|---|---|
| Can I use this at all, and why not? | `get_status` |
| What sessions exist, on what provider, in what project? | `list_sessions` |
| What context is attached? What run is active? | `list_sessions` → `RuntimeSessionView` |
| What happened, in order, since I last looked? | `get_events` with a cursor |
| Is approval required, and for what? | `get_session` → `approvals` |
| Can this be cancelled? Can it be resumed? | `cancellable` / `resumable` on the view |
| Did TabDump drive this observed run? | `resolveControlRun(correlations, provider, providerSessionId)` |

---

## 19. Not implemented

Stated plainly rather than left to be discovered:

- **The Command Centre UI.** Phase F is runtime infrastructure.
- **Local execution in the packaged desktop build.** No route handlers exist
  there. See §5.
- **A trusted path source.** No native folder picker; see §8.
- **A streaming transport.** `host.subscribe` exists and the route does not
  use it; clients poll `get_events` with a cursor.
- **Host-side persistence.** Deliberate; see §12.
- **Codex.** No Codex control adapter exists on this branch. The runtime is
  provider-neutral and would need no change to gain one.
- **Gemini, Grok, automatic context, hosted execution, broad Tauri
  permissions, browser process execution.** None of these, and none intended.
