# The developer loop (Stage 3)

Hubble is the persistent workspace and control layer for agentic work. This
stage does not add capability. It makes one loop coherent for one user:

> **AI-heavy developers who already use several coding agents** and need to
> keep project context, agent actions, approvals and results in one place.

## The loop

```
Create project → establish context → delegate → supervise → review → return
```

| Step | The question it answers | Where it is answered |
|---|---|---|
| Project | What code does the agent work on? | Workspace header (project line), Command Centre header and start screen |
| Context | What does the agent know before it acts? | Context chip + Context panel (the Context Pack, in words) |
| Agent | Who is working, and can it work? | Agents list (one state vocabulary), session header |
| Action | What is it about to do? | Approval card |
| Supervise | Is it working, waiting on me, done, failed? | Task status above the composer |
| Review | What changed? Did checks pass? | Task status: changes, line counts, checks, *Review changes*, *Run tests* |
| Return | Where did I leave off? | Workspace header + Command Centre start screen: the last task, its agent, its result |

**North star.** Hubble's success is measured by *work completed through this
loop* — a task given, supervised, reviewed and returned to — not by tab count,
agent count or sessions started. The local loop log (below) records exactly
those milestones so the first users' sessions can answer "did they finish real
work through Hubble?".

## Audit (before any code)

A live walk of the loop on a local dev server with a scripted ACP agent
standing in for the model (a Next.js project with a real sign-in bug, a
Development workspace with a brief and an *Auth bug* collection). Findings, in
loop order; **bold** = blocks or misleads.

**Entry.** The workspace the developer lands in is tabs and collections only:
no project, no brief, no sign of agent work. "What am I working on?" is
answered nowhere on that screen. The Command Centre's start screen says
"Connect an agent and start working with the tabs and collections in this
workspace" — to a developer whose two agents *are* connected and whose project
*is* attached.

**Project.** **On a fresh open, the project stayed "Checking the project…"
indefinitely and *Start session* stayed disabled.** `inspect_project` raced
`authorize_projects`; the runtime answered "not known yet", which reads as
"checking", and nothing asked again until the window regained focus. Beyond
that bug, the project lives in the fifth section of a right-hand panel that is
hidden below 1280px, under the verb "Attach", and is described twice there.

**Context.** The Context Pack inspector itself is clear (names and counts,
"read on request", delivered / sent with your next message). Around it, the
panel ends in two debugging sections — *Session: Runs / Events / Resumable*
and *Agents: Disconnected …* (the runtime's provider processes).

**Agent.** **One screen gave three answers about the same agent:** the
Agents list said *Not checked yet* in the warning colour, the start screen
offered *Start*, the panel said *Disconnected* — while that agent was running.
Clicking the agent in the list opened *Connect* rather than a new session. The
selected session's row could say *Running* while its header said *Waiting for
approval*.

**Action / Approval.** The card is trustworthy: agent, verb, file count,
project, every path, secret-like files flagged, Deny focused. Missing: which
task the request serves, and what approving does (Hubble snapshots the files
first; it can be undone) unless *Review* is opened.

**Execution.** The stream is close to a log: *Tool · Editing files · Edit*,
*Asked for approval · Editing files · Edit*, and every edited path printed
twice. The header said *Ready* the moment the task finished.

**Result / Review.** **There is no closure.** After the agent finished, the
outcome is spread across a stream row (*Project changed · Changed 2 files ·
+17 −6*), an activity row in the side panel and check buttons in the project
section. Review and tests are one click deep in the Action Inspector, which is
reached only through a chevron in the activity list.

**Recovery.** Undo works and refuses honestly. Failures name the agent.

**Return.** **After a reload, nothing says work happened.** The workspace is
unchanged; the Command Centre opens on the same "Connect an agent" start
screen, with the session one click away in a list and agent history saying
"No agent activity yet" (live sessions are hidden from it by design).

**Handoff.** *Continue with…* and its preview are good: from/to, what is
passed, the instruction, and that the target gets a new session, never the
transcript.

**Terminology.** Mostly product language already. Leaks: *Attach / Detach
project*, the panel's *Runs / Events / Resumable*, the runtime's provider
states. *Handoff* is kept: developers know the word.

**Hosted (signed out).** Honest: agents read *Unavailable here* with a reason
and the project section says project work needs the desktop app.

## What changed (product layer only)

| Loop step | Change |
|---|---|
| Project | Fixed the "Checking" stall (re-inspect once the project sync settles). Start screen leads with "Work on *project*" (kind, branch, workspace) and offers *Connect project* when there is none. The header names the project. The panel's Project section sits right under *Working in*. *Attach/Detach* → *Connect/Disconnect*. |
| Context | Panel ends at *Changes*: the *Session* and *Agents* debugging sections are gone. The pack's "Context" row is "Scope", so the panel no longer reads "Context / Context". |
| Agent | One state per agent: the list uses the same gate as *Start* (a phase that proves nothing no longer reads "Not checked yet" in the warning colour, and clicking the agent opens a session, not Connect). The selected session's list row uses its fresh state. |
| Action / Approval | The card names the task it serves and what each answer does — "Hubble keeps a copy … so you can undo. Deny: nothing changes." — and never promises undo for secret-like files. |
| Supervise / Result / Review | **Task status** above the composer, at every width: *Working · Editing files…*, *Needs you · Approve: …* (with *Show approval*), *Done · Changed 2 files in hubble-app · +17 −6 · Tests passed*, *Failed · Gemini CLI stopped unexpectedly*. *Review changes* shows the measured diff in place; *Run tests* runs the project's own check; *Continue with…* hands off. Composer placeholders are project-first. Edited paths are no longer printed twice in the stream. |
| Return | Each workspace remembers its last task locally. The workspace shows its project, focus and where the work was left, with *Open*; the Command Centre's start screen shows *Where you left off*. A task last seen in progress says "Last seen working", never "Working". |
| Demo | `/welcome`'s "Command your agents" window now opens on the project session (Codex fixing sign-in): approval → measured change → checks → review → undo, with the same task status. |

## Architecture

No new runtime verbs, event kinds, stores on the server, or changes to the
Context Pack, session context, Context Bridge, MCP, history or isolation.

- `lib/agents/activity/outcome.ts` — `taskOutcome`, a pure reduction over the
  session's existing records (status, events, the activity timeline, pending
  approvals, handoffs). The same derivation feeds the app and the demo.
- `lib/agents/command-centre/last-task.ts` — one local record per workspace
  (`tabdump:agent-last-task:v1`, account-scoped, never synced): state,
  headline, the one-line instruction, facts. Forgotten with its workspace.
- `lib/product/loop-log.ts` — the loop log (`tabdump:loop-log:v1`,
  account-scoped, never sent).
- Components: `command-centre/task-status.tsx`,
  `workspace/workspace-work-strip.tsx`; `ProjectChangeDiff` extracted from
  the Action Inspector's review so both render a change the same way.

## Product validation: the local loop log

`src/lib/product/loop-log.ts`. A milestone counter that never leaves the
browser: no network, no content — no prompts, paths, URLs, names or ids. Each
record is a milestone kind, a timestamp and, where it matters, a provider id
(`gemini`, `claude-code` …), which is not private. Bounded to the last 500.

Milestones: `workspace_created`, `project_connected`, `context_changed`,
`session_started`, `task_submitted`, `approval_requested`,
`approval_answered` (approved / rejected), `task_completed`, `task_failed`,
`handoff_started`, `result_reviewed`, `check_run`, `workspace_revisited`.

`loopSummary()` reduces them to the questions that matter: tasks given,
tasks completed, approvals answered, results reviewed, returns — and how many
tasks went all the way from *submitted* to *reviewed*. A first user can read it
from the console (`hubbleLoopSummary()`) and paste it into a conversation; it
is never sent anywhere by Hubble.

## Hubble 2.0: the project loop

The loop above, with the project as the durable object and Chrome as the way
context gets in:

```
Chrome → Project → Sources → Context → Agent → Task → Approval → Work → Result
       → project history → another agent / another task
```

| Step | Where it lives |
|---|---|
| Create a project | *New project* (name, what it is about, goal) — lands inside it |
| Collect context | Drop links / the address bar onto the project, *Add source*, the extension's *Add to project*, *Add to project* on any saved tab |
| Context | Project home: sources with honest statuses, search, filters; the Context Pack lists sources; agents read them over MCP |
| Agent | Command Centre scoped to the project; "Claude Code will use: 4 sources · project brief" before a task; *Use in task* on a source |
| Switch agent | Session header → *Switch agent* → the handoff preview aimed at that agent, optionally with the previous agent's answer |
| Result → history | Each task is recorded in the project's history with what it was given |
| Return | Project home: *Where you left off*, a *Next* step derived from state, *Recent work* by day |

Loop log milestones added: `project_created`, `resource_added`,
`resource_ready`, `resource_failed`, `context_selected`, `agent_selected`,
`agent_switched`, `handoff_completed`, `project_returned`.

Architecture, the resource model, ingestion, extraction, context budgeting,
the extension, browser limitations and testing: [project-context.md](project-context.md).
