# Claude Code Control (Phase C)

Hubble can now drive Claude Code: create a session, send messages, stream
activity back, resume, cancel, and hold an agent at a real permission prompt
until the user answers.

This is the first provider to cross from the observation plane into the
control plane. The observation pipeline is untouched and still works on its
own — see `docs/agent-control-architecture.md` for the two-plane design.

---

## 1. The environment, verified

Checked against the installed binary at the start of the phase, not assumed
from the previous phase's notes:

| | |
| --- | --- |
| Claude Code | **2.1.229** |
| `@anthropic-ai/claude-agent-sdk` | **0.3.278** (added as a dependency in this phase) |
| Runtime mechanism | **Agent SDK** |

### Why the SDK and not the CLI

The deciding factor is approvals.

`claude --help` on 2.1.229 has **no `--permission-prompt-tool` flag**.
`--permission-mode` picks a policy up front — `default`, `plan`,
`acceptEdits`, `dontAsk`, `bypassPermissions` — and cannot hand an individual
tool call back to the host for a decision. So the CLI alone can express *"allow
all edits"* or *"allow nothing"*, and cannot express:

> Claude wants to modify `literature-review.md` and `references.bib` — approve?

The SDK's `canUseTool(toolName, input, options) => Promise<PermissionResult>`
is invoked **per tool call** and awaits a verdict. That is exactly the shape
the approval broker needs, and it is the only supported way to get it on this
version.

Everything else the CLI offers, the SDK offers too, so nothing was traded away:

| Need | SDK |
| --- | --- |
| multi-turn in one process | `query({ prompt: AsyncIterable<SDKUserMessage> })` |
| streaming output | `Query extends AsyncGenerator<SDKMessage>` |
| cancel a running turn | `query.interrupt()` |
| working directory | `options.cwd` |
| extra directories | `options.additionalDirectories` |
| resume | `options.resume` |
| tool restriction | `options.allowedTools` / `disallowedTools` |
| approvals | `options.canUseTool` ← **only here** |
| no inherited MCP | `options.mcpServers: {}` + `strictMcpConfig: true` |

The SDK also owns the process, so Hubble never assembles an argv — there is
no command line for a caller to influence.

---

## 2. Working capabilities

Declared in `CLAUDE_CODE_CONTROL_CAPABILITIES`, and each one exercised by the
deterministic suite and again by the opt-in integration suite:

```
message                 create_session          resume_session
cancel_run              stream_events           read_files
write_files             run_commands            approvals
working_directory       additional_directories
```

**`mcp` is absent and stays absent.** Hubble configures no MCP servers, so
there is nothing to declare. Declaring it because the provider has a flag is
precisely what the capability model forbids.

`observe` is absent from the *control* adapter because it belongs to the
observation plane, which has its own adapter for the same provider.

---

## 3. Where the pieces live

```
src/lib/agents/control/providers/claude-code/
├── runtime.ts        the seam — Hubble's vocabulary, no SDK types
├── sdk-runtime.ts    the ONLY module that imports the SDK · server-only
├── adapter.ts        AgentControlAdapter implementation
├── normalize.ts      SDKMessage → AgentControlEvent
├── permissions.ts    Hubble scopes ↔ Claude mode + tools
├── index.ts          exports, and the browser seam
└── __fixtures__/scripted-runtime.ts
```

### The runtime seam

`ClaudeRuntime` is the smallest surface the adapter needs, in Hubble's own
vocabulary. Two implementations satisfy it:

- `createSdkClaudeRuntime()` — the real one, `server-only`, dynamic-imports
  the SDK from a module-scoped constant specifier.
- `createScriptedRuntime()` — a **real implementation**, not a mock, driven by
  tests. The adapter cannot tell them apart.

That is why lifecycle behaviour is genuinely tested rather than mocked away: a
`vi.mock` would assert that a function was called; this asserts that a whole
session lifecycle behaves correctly.

### Multi-turn without a process per message

The SDK wants `prompt` as an `AsyncIterable`. Hubble receives messages one at
a time from a user. `createMessageQueue()` bridges the two — `push` hands a
turn to whatever the generator is awaiting. One process for the whole
conversation; context is never lost between turns.

---

## 4. Session lifecycle

```
createSession ──► runtime.start()  ──►  process live
                        │
                        ├── system/init          → session_started
                        │                          (provider session id captured here)
sendMessage   ──► queue.push(turn)
                        │
                        ├── assistant text       → message_received
                        ├── assistant thinking   → thinking          (content dropped)
                        ├── tool_use             → tool_started
                        │                          + file_read / file_modified
                        │                          (only from a structured path key)
                        ├── canUseTool           → approval_requested
                        │        ⇅                  …blocks until answered…
                        │   respondToApproval    → allow / deny to the provider
                        ├── tool_result          → tool_finished     (content dropped)
                        └── result               → run_completed | error

cancelRun     ──► query.interrupt()  →  run_cancelled
resumeSession ──► runtime.start({ resume: providerSessionId })
```

The provider's session id is captured from the **first frame that carries
one**, so a session is resumable even if the run then fails. It is read back
through `adapter.providerSessionIdFor(sessionId)` — the `SessionHandle`
returned by `createSession` cannot carry it, because it resolves before the
first frame arrives.

---

## 5. Permission model

Two systems, deliberately not conflated:

```
Hubble project scope   →  outer boundary: is this dispatchable at all?
Claude mode + tools     →  provider boundary: may this tool run?
```

An action happens only if **both** allow it. The redundancy is the point: a
bug in Hubble's gate is caught by the tool list, and a misunderstanding of
Claude's mode is caught by Hubble refusing to dispatch.

### Scope → tools

| Hubble scope | Claude tools |
| --- | --- |
| `read_project` | `Read`, `Glob`, `Grep`, `NotebookRead` |
| `write_project` | `Edit`, `Write`, `NotebookEdit` |
| `run_commands` | `Bash`, `BashOutput`, `KillShell` |
| `network_access` | `WebFetch`, `WebSearch` |
| `mcp_tools` | *(none — no servers configured)* |
| `read_workspace` | *(none — workspace context travels as message text)* |

### The three-way split, and the trap in it

A granted tool goes in **neither** of Claude's lists:

| | contents | effect |
| --- | --- | --- |
| `allowedTools` | `TodoWrite` only | auto-approved, no prompt |
| `disallowedTools` | every known tool the grant did not authorize | hard denied |
| *neither* | every tool the grant **did** authorize | falls through to `canUseTool` |

The obvious reading of `allowedTools` — "the tools this grant authorizes" — is
wrong and dangerous. **A bare tool name there auto-approves that tool before
`canUseTool` is consulted.** The SDK says so itself:

```
[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked for:
Glob, Grep, NotebookRead, Read, TodoWrite. Bare allowedTools entries
auto-approve the whole tool before the callback is consulted.
```

That warning is how this bug was found — the first version listed every
granted tool and would have silently suppressed the prompt for all of them.
It is the same trap as `acceptEdits`, one layer down.

Only `TodoWrite` is auto-approved: the agent's own task list, no effect on the
machine, and without it Claude cannot plan. `security.test.ts` asserts that
`allowedTools` never contains a tool from any scope, under any grant.

**Never allowed: `Task`.** It spawns a subagent whose tool use Hubble cannot
attribute or gate at the point of use, so the parent's grant would silently
become the child's.

This is an **allowlist**. A tool a future Claude version adds is not granted
until someone classifies it — `scopeForTool` returns `null` and
`isToolPermitted` denies.

### Scope → mode

| Grant | Mode | Why |
| --- | --- | --- |
| permits something | `default` | prompts for dangerous operations — and a prompt is what invokes `canUseTool` |
| permits nothing | `dontAsk` | denies anything not pre-approved; there is nothing to ask about |

**Scoping is the tool list's job. The mode's only job is keeping the decision
with Hubble.**

Claude Code has five modes. `ClaudePermissionMode` contains two, and the three
omissions are the design:

- **`bypassPermissions`** skips Claude's checks entirely.
- **`acceptEdits`** auto-accepts file edit operations — which means the host's
  `canUseTool` is **never called** for them. Sending it would silently
  suppress the approvals this integration exists to produce: Hubble would
  show no prompt and Claude would write the file. It is the most dangerous of
  the three precisely because it reads as a reasonable choice for a grant that
  includes writing, which is exactly the mistake this codebase made and caught.
- **`plan`** stops tool execution and makes Claude produce a plan. A real
  mode, but a different product — someone who granted read access expects
  answers about their project, not a plan document.

A value the union does not contain cannot be sent by accident. That is a
structural guarantee rather than a convention, and `security.test.ts` asserts
both the union's contents and that no grant can yield anything outside it.

---

## 6. Approvals

```
Claude decides a tool needs permission
        ↓ canUseTool(...)
sdk-runtime → ClaudePermissionRequest
        ↓
adapter.handlePermission
        ├─ 1. Hubble's own check first — isToolPermitted()
        │      an ungranted tool is denied WITHOUT asking the user
        ├─ 2. emit approval_requested  → the broker, via the service
        └─ 3. hold the promise open   → no timeout, no default
        ↓
respondToApproval("granted" | "denied")
        ↓
{ behavior: "allow" } | { behavior: "deny", message }
        ↓
Claude runs the tool, or does not
```

Guarantees, each covered by a test:

- **Never auto-approves.** `behavior: "allow"` appears exactly once in
  `adapter.ts`, inside the branch handling an explicit `granted`. A guard test
  counts the occurrences.
- **Never auto-denies silently** — a denial is always either the user's
  decision, an ungranted scope, an abort, or the session ending.
- **Cannot be answered twice.** The resolver is removed when consumed.
- **Nothing hangs.** An abort denies; a session end denies every pending
  approval; no promise is left dangling and no provider is left blocked.
- **The provider's own words.** `title`, `displayName`, `description` and
  `decisionReason` come from Claude. Where it supplies nothing, the approval
  says the tool name rather than inventing a sentence.
- **No payload.** The approval event carries a tool name and an id. Targets
  are project-relative paths, collected through
  `adapter.takeApprovalDetails()`. A `Bash` command string has nowhere to
  live in this system.

---

## 7. Security boundaries

| Boundary | Enforced by |
| --- | --- |
| Hosted deployments cannot execute | `decideServerRuntime` — fails closed, hosted marker vetoes even with the opt-in |
| Browser cannot execute | catalogue registers `createClaudeCodeControlSeam()`; `sdk-runtime.ts` is `server-only` |
| No arbitrary shell | Hubble assembles no argv; the SDK owns the process |
| No arbitrary paths | `cwd` and `additionalDirectories` come from a validated `AgentProject` only |
| No inherited MCP | `mcpServers: {}` + `strictMcpConfig: true` |
| No provider bypass | `bypassPermissions` absent from the mode union |
| No subagent escalation | `Task` in `NEVER_ALLOWED_TOOLS` |
| Credentials are the user's own | **Changed in Phase I.2.** This used to read "Claude Code authenticates itself; Hubble reads no key and stores none", which described inheriting whatever login the server process happened to have — a developer's own on their machine, and the *operator's* on any deployment with `ANTHROPIC_API_KEY` set. The runtime now takes a `ClaudeCredentialSource` bound to one actor, resolves it per run, strips inherited provider variables out of the agent's environment, and refuses to start without one. See docs/provider-connections.md |
| No old control channel | `messagingSocketPath` / `procStart` / `pidDomain` appear nowhere |
| No transcript leakage | thinking, tool inputs and tool results are all dropped at the normalizer |

Paths that will not reduce against the project root are **dropped** rather
than emitted — a tool call outside the project is reported as a tool call with
no file, never as an absolute path.

---

## 8. MCP — deferred, and closed

Hubble configures **no** MCP servers, declares **no** `mcp` capability, and
maps **no** tool to the `mcp_tools` scope. An `mcp__*` tool arriving at
`canUseTool` is unclassified and therefore denied.

`strictMcpConfig: true` is the load-bearing part. Without it, a session would
inherit whatever MCP servers the user's own Claude configuration defines —
tools Hubble never authorized and cannot map to a scope. That is the trust
boundary: MCP configuration must come from Hubble or from nowhere, and today
it comes from nowhere.

---

## 9. What is deliberately not here

- **No HTTP route.** Nothing in this phase exposes agent execution over the
  network. The adapter is a server-side module; the opt-in integration test
  drives it directly in Node. Adding a route before a UI needs one would mean
  shipping an executable endpoint with no consumer, and the runtime boundary
  is easier to reason about when there is no endpoint at all. Phase F's
  transport adds it.
- **No Tauri commands.** The desktop shell still grants only `core:default`.
  The missing piece is unchanged from Phase B and is documented in
  `src-tauri/src/commands.rs`: a structured, scoped command surface that
  takes a project id rather than a path. Implementing it needs the Rust side
  to hold the project registry, which is Phase F work.
- **No UI.** No composer, no approval dialog, no session list.

---

## 10. Tests

| Suite | What it proves |
| --- | --- |
| `adapter.test.ts` | the adapter's behaviour across a whole session lifecycle, against a real implementation of the runtime contract |
| `security.test.ts` | the boundaries above, structurally |
| `integration.local.test.ts` | that the contract matches **Claude** — opt-in |

The integration suite is skipped unless **both**
`TABDUMP_CLAUDE_INTEGRATION=1` and the control plane's own
`TABDUMP_LOCAL_AGENT_RUNTIME` opt-in are set. Requiring the second means it
cannot run anywhere the product itself would refuse to execute — including CI.

It is what would catch an SDK upgrade changing a message shape, which no
amount of deterministic testing can.

### What it has and has not proven on this machine

Run against the real installation, it got as far as the provider's
authentication and stopped there:

```
✓ the SDK loads and reports available
✓ a session starts — the process spawns and system/init arrives
✓ the event stream flows and normalizes: session_started, message_received
✓ the failure path reports truthfully: error
✗ a completed model turn
```

The cause is **not** in this code. Plain `claude -p` fails identically:

```json
{ "is_error": true, "terminal_reason": "api_error",
  "result": "Failed to authenticate: OAuth session expired and could not be refreshed" }
```

Zero tokens, zero cost — the API call never happened. Re-authenticating the
local Claude Code installation (`claude` → `/login`) is what unblocks the rest
of the suite: the approval test, cancellation against a live turn, and
resume-and-recall.

Worth noting that the normalizer handled this correctly without being told to:
the result frame carried `subtype: "success"` **and** `is_error: true`, and
`fromResult` checks `is_error` first, so the run was reported as an error
rather than as a success.
