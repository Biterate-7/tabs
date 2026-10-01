# Codex through its own app-server

Hubble drives Codex directly through `codex app-server`, Codex's own JSON-RPC
protocol on stdio. It does not use `codex-acp` any more. Everything below was
verified against **Codex 0.159.0** on Windows 11. That is the oldest version
Hubble accepts; later versions are held to the same checks.

## The trust model

Hubble uses **the same model it uses for Claude Code: per-action approval.**

```
Codex proposes a command
  → Hubble receives item/commandExecution/requestApproval
  → Hubble shows the complete command: program, arguments, paths, working directory
  → the person approves or declines
  → Hubble answers Codex with "accept" or "decline"
  → only then does Codex run it
```

**Codex is not workspace-isolated in Hubble.** On Windows, Codex cannot confine
an approved command to the project. Its sandbox refuses any profile that limits
reads, under every backend:

- **Unelevated:** "cannot enforce split filesystem read restrictions".
- **Elevated:** "requires effective `:root` read access".

So an **approved command runs with the user's own system permissions**, like a
command they typed. The product says so wherever Codex is offered and on every
command approval:

> Codex commands require your approval before execution. Approved commands
> run with your system permissions.

Two things are easy to confuse, so Hubble keeps them apart:

| | What it is | What it is not |
| --- | --- | --- |
| **Hubble context** | What Hubble *tells* Codex: the workspace, the tabs and collections in focus, bound to one session through its context server. | A limit on what Codex can reach. |
| **OS permissions** | What an *approved* command can touch: everything the user can. | Narrowed to the project. |

The project folder is where Codex *starts*. It is not a boundary.

## How "only then" is made true

These layers are independent, and each one was verified against the real
app-server.

### 1. Launch: `lib/agents/launch/allowlist.ts`

The launch arguments are a literal list (`codex app-server --listen stdio://
--disable … -c …`). Each switch closes a surface that could act without
Hubble's approval:

| Surface | Why it is off |
| --- | --- |
| `unified_exec_tty` | Once one interactive shell was approved, `write_stdin` ran further input in it **unasked**. With tty off, the parameter disappears, tty calls are refused, and a non-tty process's stdin is closed. |
| `view_image` | It read an image **anywhere on disk** without asking. |
| `multi_agent`, `multi_agent_v2` | Sub-agents. |
| `apps`, `plugins`, `remote_plugin`, `plugin_sharing`, `tool_suggest` | Connectors and plugins outside Hubble. |
| `hooks` | Hooks run programs on events. |
| `computer_use`, `browser_use*`, `in_app_browser` | Desktop and browser control. |
| `image_generation`, `goals`, `memories`, `worktrees`, `shell_snapshot`, `workspace_dependencies`, `realtime_conversation`, `guardian_approval`, `skill_mcp_dependency_install` | Not needed, and each is surface. |

**Code mode stays on**, deliberately. The default model (`gpt-6-luna` at the time of QA) runs every command through it, so switching it off leaves Codex able to run nothing. It was verified against the real model with every approval declined. A code-mode cell is a bare JavaScript isolate: no `fs`, `import`, `fetch`, `process`, `WebAssembly`, `Deno` or `Bun`. Its bridges are `load`/`store` (a key-value store, not files), `image` (data URIs only), `text`, `notify`, `exit` and `tools`. The tools it can call are `exec_command` and `apply_patch`, each of which raised a Hubble approval and did nothing when declined, plus `write_stdin` (no tty) and a clock.
| `-c web_search=disabled` | Hosted web access. |

With these switches, a model without code mode is offered exactly
`exec_command`, `write_stdin` and `request_user_input`; the default model reaches `exec_command`, `apply_patch`, `write_stdin` and a clock through code mode. `request_user_input` is refused by
Codex itself in Default mode, and Hubble refuses it too. `view_image`,
`spawn_agent` and `create_goal` come back as "unsupported call" without
acting.

Hubble never sets `windows.sandbox`. Its `elevated` value makes Codex open a
Windows administrator (UAC) prompt on its own when a thread starts.

### 2. Hubble's own Codex folder: `lib/agents/launch/codex-home.ts`

Every Codex process Hubble starts runs with `CODEX_HOME` pointed at
`%LOCALAPPDATA%\Hubble\codex`, never at `~/.codex`. In the user's own folder,
Codex 0.159 lets:

- a `rules/*.rules` entry with `decision = "allow"` **run commands unasked**,
  whatever policy the thread carries;
- an `[mcp_servers.*]` entry **start a program** even when overridden on the
  command line, because configuration layers merge.

Hubble rewrites `config.toml` in its own folder on every launch, and refuses to
launch if that folder's `rules` contains anything. The user's own `CODEX_HOME`
variable is not inherited, because it is not on the environment allowlist. A
workspace's own `.codex/` folder is ignored: Codex loads it only for trusted
projects, and Hubble never trusts one.

The cost: the user signs in to Codex once for Hubble. Hubble never copies a
login from `~/.codex`.

### 3. Settings on every thread and every turn: `control/providers/codex-app-server/protocol.ts`

- **Thread settings:** `thread/start` sends `approvalPolicy: "untrusted"`,
  `approvalsReviewer: "user"`, `sandbox: "read-only"` and `ephemeral: true`.
- **Echo check:** Codex's reply echoes what it applied. A thread without
  exactly these settings is closed before any message is sent, with the error
  `approval-unenforceable`.
- **Every turn:** `turn/start` re-sends the same settings.
- **Later changes:** a `thread/settings/updated` that moves out of these
  settings stops the session.

Under `untrusted` on Windows, **every command raised an approval request**:
37 of 37 tried, including plain reads (`ls`, `Get-Content`, `git status`,
`rg`, `type`), other shells, pipes, and working directories outside the
project. That held with and without the unelevated sandbox.

### 4. Enforcement: `control/providers/codex-app-server/adapter.ts`

Codex reports an item before asking about it. The adapter stops the session,
which ends its process, when:

- a command or file change produces output, or completes, without an approval
  Hubble gave;
- an MCP call completes without one. A failed MCP call is the server refusing
  it, so it is not treated as a violation;
- any switched-off item appears: `webSearch`, `imageView`, `imageGeneration`,
  `collabAgentToolCall`, `subAgentActivity`, `dynamicToolCall` or
  `hookPrompt`;
- a hook or an automatic approval reviewer starts.

A declined item never ran, and is not a violation.

## Approvals

| Codex asks | Hubble does |
| --- | --- |
| `item/commandExecution/requestApproval`, kind `command` | A `run_command` approval in the broker, carrying the **complete command line** (see below). Answers `{decision: "accept"}` or `{decision: "decline"}` and nothing else: never `acceptForSession`, never an execpolicy amendment. |
| `item/commandExecution/requestApproval`, kind `writeStdin` | Declined without asking. Interactive terminals are off, so this should never arrive. |
| `item/fileChange/requestApproval` | `create_files`, `modify_files` or `delete_files` over the reported paths, all inside the project. Otherwise declined, as is a request for a standing write root. |
| `mcpServer/elicitation/request` (`codex_approval_kind: "mcp_tool_call"`) | For this session's context server: the shared context decision (`authorizeContextRequest`), allowed once. The server raises a Hubble approval for every write. Any other server: declined. |
| `item/permissions/requestApproval` | Grants nothing (`{permissions: {}, scope: "turn"}`). |
| Anything else: user input, dynamic tools, token refresh, attestation, v1 approvals | Refused. |

**What the approval card shows** (`control/command-preview.ts`,
`components/command-centre/approval-prompt.tsx`):

- `commandLine`: exactly as Codex will run it, for example
  `"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content notes.txt'`.
- `workingDirectory`: project-relative (`.` for the root), or the full path
  with "outside this project" when it is elsewhere.
- `network`: host and protocol, when Codex asked for network access.
- Codex's own `reason`, when it gave one.
- The trust notice above.

**Guards on the card:**

- A command over 8,000 characters is **refused, not truncated**: the broker
  will not record it and the card offers no Allow.
- Control characters, zero-width characters and bidirectional overrides are
  shown as `\u{…}` escapes, so what is displayed is exactly what runs.
- A control event never carries the command. The approval record is the only
  place it lives.

An approval pending when the session ends, the run is cancelled, or Codex
exits is never accepted. The process that asked is gone, and a late "yes"
finds nothing to answer.

## MCP and workspace context

The session's context server is handed to Codex **inside `thread/start`**, in
that thread's own `mcp_servers` configuration:

- **The token** travels in `http_headers`, over stdin. It is never on the
  command line or in the environment.
- **Prompt mode:** `default_tools_approval_mode = "prompt"` makes every call
  ask. Without it, Codex called tools annotated read-only unasked.
- **Thread isolation (verified):** a second thread in the same process does
  not see the first thread's server.

Codex names the server in each request from the configuration Hubble wrote, so
the model cannot choose the name. A context call is answered by the same
decision Gemini's is, `authorizeContextRequest`, bound to the session's own
workspace and capabilities. A call to another session's server is declined.
`read_mcp_resource` reaches the server without an elicitation, so the session
context server refuses every resource operation by allowlist, before the MCP
SDK sees it: only `initialize`, `ping`, `tools/list` and `tools/call` are
answered (`CONTEXT_SERVER_METHODS`, `session-context/http.ts`). A resource
registered on it later is refused, never served unasked. A *successful*
unapproved MCP call would stop the session.

## Sign-in

- **State:** asked of Codex itself through `account/read` on a probe process
  that starts no thread. Only the account *type* is kept, never the email or
  the plan.
  - `chatgpt` → signed in, usable.
  - Anything else → signed in, not usable.
  - `null` → sign-in required.
- **Signing in:** `codex login`, Codex's own ChatGPT sign-in. It opens the
  browser itself and stores the login in Hubble's Codex folder. Hubble runs
  that literal argument list and waits (10-minute limit), then asks Codex
  again. Hubble never collects a password, never scrapes cookies, and never
  reads, copies or stores a token.
- **Before any thread:** a session starts only after `account/read` says
  ChatGPT.
- **Mid-session:** a 401 during a turn marks the sign-in required.

## Lifecycle

| | |
| --- | --- |
| Launch | Allowlisted executable (`codex`, or its npm shim followed into `@openai/codex`), literal arguments, allowlisted environment plus Hubble's `CODEX_HOME`, `shell: false`. One process per session, in the project folder. |
| Handshake | `initialize` on the stable protocol (`experimentalApi: false`). A version below 0.159.0, or one that cannot be read, is refused. |
| Session | `account/read` → `thread/start` → the settings check. |
| Turn | `turn/start` with the settings re-sent, streamed through `item/*` notifications, ended by `turn/completed`. |
| Cancel | Pending approvals are declined, then `turn/interrupt`. |
| End / disconnect | The process is closed: stdin ends first, which stops the npm-wrapped `codex.exe` too. Verified: no `codex.exe` is left running. |
| Process death | "Agent disconnected unexpectedly." The session ends. |
| Timeouts | 30 s handshake; 60 s `thread/start`. A turn is ended by the user, not a clock. |

## Platforms

Sessions are declared **on Windows only**, the only platform where Hubble
verified that every command asks. On macOS and Linux, Codex's own sandbox runs
"known safe" read commands without asking under `untrusted`. There, Codex is
reached and signed in to, and the runtime declares no session capability.

## Tests

- `control/providers/codex-app-server/adapter.test.ts`, `protocol.test.ts`:
  the adapter against a scripted app-server.
- `control/command-preview.test.ts`: the preview, and the broker's refusals.
- `launch/codex-home.test.ts`: the folder.
- `launch/security.test.ts`: the pinned launch.
- `runtime/desktop.test.ts`: a Codex session through the real host, service
  and broker.
- `components/command-centre/approval-prompt.test.tsx`: the card.
- **Real Codex:** `launch/codex-app-server.local.test.ts`.

To run the real-Codex tests:

```
HUBBLE_CODEX_PREFIX=<npm global prefix holding @openai/codex> npx vitest run src/lib/agents/launch/codex-app-server.local.test.ts
```

They use the production launcher and adapter against the real app-server.
The model is a scripted Responses API on loopback; to Codex, the only other
difference is one rewritten `account/read` reply.

## Real-agent QA (2026-09-30, Codex 0.159.0, a real ChatGPT sign-in)

Run through the real Hubble UI on a local runtime. All commands were harmless
and ran in a scratch project.

| Step | Result |
| --- | --- |
| Sign-in | `codex login` into Hubble's Codex folder. Codex's `account/read` answered `chatgpt`. Connect showed "Already authenticated · ChatGPT account". |
| Session | Started in the project, with Hubble tools. Codex ran with tty off, web search off and code mode on. |
| Command approval | The card showed `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -LiteralPath 'notes.txt'"` and "Runs in .", with the trust notice. The path's doubled backslashes are Codex's own quoting, shown unchanged. |
| Deny | Codex: "The read command was rejected". The file's contents never appeared. The session returned to `ready`. |
| Allow | `approval_granted → command_started → command_finished`. The file's real contents were returned. |
| MCP read | Two context-server calls, each answered by Hubble's context decision. Codex named the workspace and its tabs correctly. |
| MCP write | Hubble's "Change your Hubble workspace" approval. Deny: no collection. Approve, in a fresh session: the collection was created and verified. |
| End / new session | Ending a session left no `codex.exe`, code-mode host or wrapper running. A new session started cleanly. |

**Found and fixed during QA:**

- **Code mode must stay on.** With `--disable code_mode_host`, the default
  model could run nothing ("execution host is disabled"). Nothing ran, but
  nothing could.
- **The session stuck at `waiting_for_approval`.** After an answered approval
  the session never left that status. The adapter now emits
  `approval_granted` or `approval_denied`.

**Fixed in the hardening pass that followed:**

- **Run commands from New session.** A folder authorized from New session
  now carries exactly the scopes the agent was approved for in Connect Agent
  (`projectScopesForAgent`, `platform/roster.ts`), including Run commands when
  the person turned it on there (it is off by default). The Authorize form
  lists what the folder grants, with "asks every time" beside each scope that
  does, and says when Run commands is off. The grant names its folder and its
  agent. Every command still raises its own approval, and a denial blocks it.
  A folder authorized before this change keeps its old grant: authorize it
  again to add Run commands.
- **Approval lifecycle, for every provider.** The control service now owns
  the move out of `waiting_for_approval`. Claude, Gemini and Grok had the same
  stuck-waiting bug as Codex; see `docs/agent-control-architecture.md`.
- **MCP resources fail closed,** as above.
