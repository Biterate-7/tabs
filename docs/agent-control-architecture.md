# Agent Control Architecture

> **TabDump observes agents through the observation plane, and communicates
> with agents through a separately permissioned control plane.**

That sentence is the architectural principle. Everything below is what it
means in practice, and what is enforced mechanically so it stays true.

---

## 1. Two planes

```
                    ┌──────────────────────────────────┐
                    │   TabDump domain + workspaces    │
                    └───────────▲──────────────────────┘
                                │ observations only
        ┌───────────────────────┴───────────────────────┐
        │                                               │
┌───────┴─────────────┐                    ┌────────────┴────────────┐
│  OBSERVATION PLANE  │                    │     CONTROL PLANE       │
│  lib/agents/        │                    │  lib/agents/control/    │
│    connectors/      │                    │                         │
│    claude-code/     │                    │  AgentControlAdapter    │
│    adapter.ts       │                    │  ControlService         │
│                     │                    │  ApprovalBroker         │
│  AgentConnector     │                    │  permissions / projects │
│  READ ONLY          │                    │  runtime boundary       │
└─────────────────────┘                    └─────────────────────────┘
        │                                               │
   reads transcripts,                        starts sessions, sends
   session registries                        messages, cancels runs
```

They are separate directories, separate interfaces, separate capability sets,
separate guard suites. A provider can be in one, the other, or both — and
today **every shipped provider is observation-only**.

### Why separate rather than one interface with more methods

Collapsing them would mean that "TabDump can see this agent" and "TabDump can
drive this agent" become one fact. They are not one fact, and the difference
is the whole safety story. Claude Code is fully observable right now and
entirely undrivable; the two planes let the product state both without either
implying the other.

---

## 2. The observation plane (unchanged)

`AgentConnector` still cannot act. `AgentAdapter` still has no `start`, `stop`,
`prompt`, `sendMessage`, `exec` or `write`. `claude-code/reader.ts` still
strips `messagingSocketPath`, `pid` and `procStart` at its documented choke
point. Its guard suites are **untouched** by this phase and still pass
unmodified — `control/security.test.ts` re-asserts the most important of them
from the other side, so that someone adding control cannot quietly relax a
failing observation guard.

Traffic remains one-way:

```
external agent → connector → AgentAdapterObservation → agent domain
```

---

## 3. The control plane

| Module | Holds |
| --- | --- |
| `capabilities.ts` | what an adapter can do **today** |
| `session.ts` | session lifecycle + transition table |
| `events.ts` | the normalized live event |
| `permissions.ts` | scopes, grants, capability→scope mapping |
| `projects.ts` | authorized directories + path validation |
| `approvals.ts` | the approval broker |
| `context.ts` | provider-neutral TabDump context attachments — the *contract*. What resolves a workspace id into one lives in `lib/agents/context/`, a sibling directory that reads TabDump's domain so this one never has to. See [agent-context-bridge.md](agent-context-bridge.md). |
| `runtime.ts` | the local-execution boundary |
| `types.ts` | `AgentControlAdapter`, errors, results |
| `service.ts` | the gate; the only thing that may drive an adapter |
| `persistence.ts` | sessions + projects, account-scoped |
| `providers/` | per-provider adapters |

### The gate

Every operation passes the same checks, in this order, before an adapter is
touched. Each denies on its own, and each is tested on its own:

1. **Runtime** — may this process execute agents at all? *Denied by default.*
2. **Registration** — is there an adapter for this provider?
3. **Capability** — does the adapter *declare* it can do this?
4. **Session** — does it exist, and can its status accept this?
5. **Project** — does the project exist, and is this provider on its list?
6. **Permission** — does the grant cover the scope this capability needs?

---

## 4. Capability model

A closed union (`AgentCapability`) of 13 values. Two rules:

- A capability declares what an adapter **implements today**. There is no
  `planned`, `roadmap` or `comingSoon` field anywhere in the module — the
  moment one exists, a UI renders it and a user reads it as a promise.
- Every set starts from `NO_CAPABILITIES`. A provider declaring nothing is
  the default, not an error.

**Today, every control adapter declares the empty set.**

Capabilities that touch the user's machine (`read_files`, `write_files`,
`run_commands`) are additionally classed as *local effects* and can never be
authorized without a project.

---

## 5. Permission model

Six scopes: `read_workspace`, `read_project`, `write_project`, `run_commands`,
`network_access`, `mcp_tools`.

Deliberately coarse. A finer model ("write only these globs") reads as more
secure and is less so: it produces a dialog nobody can evaluate, and the user
clicks yes.

Every function answers *"was this explicitly allowed"*, never *"was this
explicitly forbidden"*. A missing grant, an unknown scope, an absent project
or a malformed record all deny. `write_project` naming no project is not a
broad grant — it is an **invalid** one.

### Grant vs approval

| | Question it answers | Granularity |
| --- | --- | --- |
| Permission grant | may this agent write in this project *at all*? | per project, set once |
| Approval | may it write *these four files, right now*? | per action |

Both are required for `write_project` and `run_commands`. That gap is the
difference between authorizing a tool and authorizing an act.

---

## 6. Project scope

A project is a **grant of scope over one directory**, never a discovered
location. TabDump does not scan, walk, enumerate or suggest.

`validateProjectPath` refuses:

- filesystem roots and bare drives (`/`, `C:/`, `D:`, `//server`)
- home directories, by *shape* rather than name — `C:/Users/alice` and
  `/home/alice` end in a username that cannot be enumerated
- well-known user folders by leaf name (`Desktop`, `Documents`, `.ssh`,
  `.aws`, `.claude`, `System32`, …)
- unresolved (`..`, `.`), drive-relative (`C:foo`), relative and null-byte paths

Containment delegates to `lib/agents/paths.ts` `toProjectRelative` rather than
reimplementing traversal checks — a second implementation would be a second
chance to get it wrong.

**Path validation in the browser is a convenience, never a boundary.** The
local runtime revalidates every path against the registered project before
acting. A path from the client is a claim, not a fact. Persistence
re-validates on load, so a path hand-edited in devtools is dropped rather
than authorized.

---

## 7. The runtime boundary

The most consequential question in the plane: *may this process start an agent
that touches a filesystem?*

The same frontend is served from a user's machine and from a hosted
deployment. On the user's machine, running an agent against their project is
the product. On a hosted deployment, running one against *the server's*
filesystem for any visitor is remote code execution with a friendly UI.

### Signals that are refused, and why

| Signal | Why not |
| --- | --- |
| `Host: localhost`, loopback remote address | set by the requester; true for every visitor behind a proxy |
| User agent | chosen by the client |
| `window.__TAURI_INTERNALS__` | a browser global; the decision must not be made in the browser |
| "the `claude` binary exists" | true on any developer's hosted box; presence ≠ authorization |
| `NODE_ENV !== "production"` | a build flag, not a statement about whose machine this is |

None appear in `runtime.ts`, and the guard test asserts that none appear.

### What is actually required

Exactly one of:

1. **The desktop shell** — Tauri executes through Rust on the machine the user
   launched. Local by construction; the decision is made in Rust.
2. **A deliberate operator opt-in** — `TABDUMP_LOCAL_AGENT_RUNTIME` set to one
   exact string, on a process showing no hosted-platform marker.

Ordering matters: a hosted marker (`VERCEL`, `NETLIFY`, `AWS_LAMBDA_*`, `DYNO`,
`K_SERVICE`, …) **vetoes even when the opt-in is set** — because pasting the
opt-in into a hosting dashboard is the mistake most likely to actually happen.

Everything else, including no information at all, denies.

---

## 8. Session lifecycle

```
created ─→ connecting ─→ ready ⇄ running ⇄ waiting_for_approval
                           │        │     ⇄ waiting_for_input
                           │        └─→ completed
                           └─→ completed
   (any live state) ─→ failed | disconnected | cancelled
```

Encoded as an exhaustive table (`SESSION_TRANSITIONS`) rather than a chain of
conditionals, because a table can be read as a specification. Three properties
are enforced by test:

- nothing leaves a terminal state (the empty arrays are checked, not assumed);
- `failed` and `disconnected` are reachable from every live state;
- **no self-transition** — `running → running` looks harmless and would let a
  second message silently overwrite the first's timestamps.

`ready → waiting_for_approval` is legal: resuming a session that was already
blocked lands in `ready` and only then learns an approval is outstanding.

An adapter **cannot set a status**. It describes what happened; the service
decides what that means, and refuses an impossible transition rather than
applying it.

### Why this is not `AgentRunStatus`

The domain's run status answers *"how is the work going"* and is derived from
observation. This answers *"what is TabDump's connection to this agent
doing"*. A session can be `waiting_for_approval` while its run is still
`working`. There is exactly **one** representation of a run — the domain's —
and a session references it by id.

---

## 9. Event normalization

`AgentControlEvent` has 19 kinds and carries identity plus already-safe
labels. Optional slices (`tool`, `file`, `approvalId`) are required for the
kinds that imply them, checked by `isWellFormedControlEvent` at the service
boundary — an adapter is not trusted to have normalized correctly.

**What may never appear**: file contents, diff bodies, command strings, prompt
text, model reasoning, stdout/stderr. `ControlToolInfo` carries a tool *name*
and an optional prose *description*, never an invocation — a shell command is
the single most dangerous string a provider could put on a screen, and the
only way to be sure it cannot is to have nowhere to put it.

### Two event types, one direction

The domain's `AgentEvent` is a **durable, bounded activity log** (5 kinds, 200
chars, 200 per run, persisted). `AgentControlEvent` is the **live wire**.
`toDomainEventInput` reduces one to the other, and never the reverse.
`thinking` and `message_sent` are deliberately dropped — they fire constantly
and say nothing a week later. Merging the two would put a
tool-call-per-second stream into localStorage.

---

## 10. Approvals

States: `requested → granted | denied | expired | cancelled`. Only
`requested` is live.

- A pending approval is **neither** an implicit allow **nor** an implicit
  deny. It expires — to denied.
- A resolved approval cannot be re-resolved, so a late "granted" cannot
  overturn a deny the user already gave.
- An adapter **cannot mint its own approval**. `AgentControlAdapter` has
  `respondToApproval` and deliberately no `requestApproval`: an adapter raises
  one by emitting an `approval_requested` event, and the service routes it to
  the broker. An adapter that could call the broker could mint one already
  granted.
- The service settles the broker **before** calling the adapter, so a user's
  decision is never lost because a provider was unreachable.
- Expiry is derived from the clock at read time, not from a timer — a timer
  would keep the process awake and would still be wrong after a sleep.

---

## 11. Persistence

Two account-scoped keys: `tabdump:agent-sessions:v1`,
`tabdump:agent-projects:v1`. Both capped.

**No credential of any kind**, and the guard test fails the build if a field
named like one appears. Phase B needs none — no adapter authenticates against
anything. When one does, it gets the existing in-memory mechanism
(`connectors/session-credentials.ts`) or a deliberate new decision, **not** a
field quietly added here.

**No transcript.** A session record is a handle, not a conversation.

Sessions that were live are restored as `disconnected`: the process they were
driving died with the page. Restoring one as `running` would spin forever.

---

## 12. Transport

```
React component
      ↓            (components may not import an adapter — guard-tested)
ControlService
      ↓            (the gate)
AgentControlAdapter
      ↓
agent runtime
```

### Tauri (design only — nothing granted in this phase)

`src-tauri/capabilities/default.json` still grants only `core:default`. No
shell, fs, http or process plugin. When local execution is built, it follows
the shape the two existing commands already use — *structured and scoped, so
the frontend cannot express a dangerous request in the first place*:

```
agent_runtime_status()                     → is this shell permitted to run agents
agent_create_session(provider, project_id) → project_id, never a path
agent_send_message(session_id, text, ctx)
agent_cancel_run(session_id)
agent_approve(approval_id) / agent_deny(approval_id)
agent_project_scope(project_id)            → what the Rust side will enforce
```

Rules carried over from `open_external` / `export_text_file`:

- **No `shell(command)` or `execute(argv)`.** The frontend names an
  *operation*, never a command line.
- **The frontend never supplies a path.** It supplies a project id; Rust holds
  the registered root and resolves against it.
- Rust revalidates containment itself. The browser's check is a convenience.
- The binary is allowlisted, not chosen by the caller.

---

## 13. Provider integration points

### Claude Code — Phase C

Verified against the installed CLI (**2.1.229**):

| Operation | Mechanism |
| --- | --- |
| create | `-p --output-format stream-json --session-id <uuid>` |
| message | `--input-format stream-json` (one long-lived process, not per-turn) |
| resume | `--resume <id>`, `--fork-session` to branch |
| cancel | terminate the process group; session survives |
| stream | `stream-json` stdout, `--include-partial-messages` |
| dirs | process cwd + `--add-dir` |
| tools | `--allowedTools` / `--disallowedTools` / `--tools` |
| MCP | `--mcp-config`, `--strict-mcp-config` |
| budget | `--max-budget-usd` |

**The approval problem decides the dependency.** CLI 2.1.229 has **no
`--permission-prompt-tool` flag**. `--permission-mode` chooses a mode up
front; it cannot hand an individual tool call back for a decision. Real
interception needs `@anthropic-ai/claude-agent-sdk` and its `canUseTool`
callback, which maps onto the broker exactly. Until that is wired, the adapter
must not declare `approvals` — an Approve button bound to a mode flag would be
a control that controls nothing.

Correlation: TabDump supplies the session UUID via `--session-id`, so the
control session and the observation plane's view of the same session share an
id from the first byte. **One run, one domain record.**

### Codex — Phase D

Not installed on this machine, so there is deliberately **no mapping table**.
Writing one would mean transcribing documentation into a plan — the same
mistake as a connector built from a guessed schema. Phase D establishes,
against a real installation: the integration surface, conversation
persistence, whether tool calls can be intercepted, how directories are
expressed, and what the event stream emits. Each answer becomes one declared
capability; anything unanswered stays undeclared.

---

## 14. Machine-enforced guarantees

`control/security.test.ts`:

1. Observation adapters still cannot execute or touch a filesystem.
2. The read-only connector contract has no acting member.
3. No general-purpose shell function exists in the control plane.
4. No arbitrary read/write-a-path function exists.
5. The control domain imports no process, shell or filesystem module.
6. No component or hook imports a control adapter or spawns a process.
7. The runtime denies an empty environment, denies a non-server context,
   accepts only the exact opt-in, and refuses a hosted platform **even with
   the opt-in set**.
8. The runtime consults no forgeable signal and reaches no global.
9. An unregistered provider cannot execute.
10. An undeclared capability is refused before the adapter is reached.
11. A local-effect capability with no project is denied; a grant for another
    project is denied; an unauthorized provider is denied.
12. Project paths refuse roots, homes and unresolved forms; containment
    refuses everything outside.
13. Adapters have no `requestApproval`; no provider adapter imports the
    broker; a decision cannot be overturned; expiry is terminal.
14. No provider name appears in any generic control module.
15. No provider CLI vocabulary appears in the contract.
16. A control event has nowhere to carry a command or payload.
17. Both shipped adapters declare nothing, refuse everything, never report
    connected, and have **no code path that emits an event**.
18. The control plane declares no credential field and touches only its two
    storage keys.

---

## 15. The surface this runs on

Everything above describes what may be asked of an agent. **Where that asking
actually happens** — the trusted local runtime, the browser transport, session
ownership, run correlation, and how a controlled run is told apart from one
TabDump merely observed — is `docs/agent-local-runtime.md`.

Two things in this document were true when it was written and are no longer:

- **`service.attachRun` was uncalled.** The runtime host now mints a control
  run when a session starts driving, binds it to the adapter, and records it on
  the session, so every event a provider emits is attributable. See §10 there.
- **`approval_requested` reached no broker.** The service now mints the broker
  record from a provider-neutral accessor (`control/approval-details.ts`) the
  moment an adapter raises one. The adapter still has no route to the broker,
  and guard 13 above still holds unchanged. See §14 there.
