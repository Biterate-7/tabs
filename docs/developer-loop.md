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
