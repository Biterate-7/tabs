# The Remote Agent Runtime

> **The Vercel Function is the control plane. The Vercel Sandbox is the
> execution plane. They are never the same machine, and neither is yours.**

Phase F built the local runtime: a trusted surface on the user's own machine,
driving Claude Code against a directory they authorized. This document is the
second execution plane — one that a hosted deployment can use, because it
touches nobody's computer.

It does **not** replace or weaken the first. `decideServerRuntime` is byte for
byte the function it always was: a hosted marker still vetoes local execution,
and the opt-in still cannot override that veto.

---

## 1. The shape

```
                          ┌────────────────────────┐
                          │       TABDUMP UI       │
                          └───────────┬────────────┘
                                      │ one of 14 typed commands
                                      │ no paths, no shell, no sandbox ids
   ═══════════════════════════════════╪═══════════════════ TRUST BOUNDARY
                                      │
                          ┌───────────▼────────────┐
                          │   VERCEL FUNCTION      │
                          │   RuntimeHost (remote) │  ← control plane
                          │   ControlService       │
                          │   approval broker      │
                          └───────────┬────────────┘
                                      │
                          ┌───────────▼────────────┐
                          │ ClaudeCodeControlAdapter│ ← unchanged
                          └───────────┬────────────┘
                                      │ ClaudeRuntime seam
                    ┌─────────────────┴─────────────────┐
                    │                                   │
        ┌───────────▼──────────┐          ┌─────────────▼────────────┐
        │  SdkClaudeRuntime    │          │  RemoteClaudeRuntime     │
        │  (local, unchanged)  │          │                          │
        └───────────┬──────────┘          └─────────────┬────────────┘
                    │                                   │
        ┌───────────▼──────────┐          ┌─────────────▼────────────┐
        │ Claude Code process  │          │   VERCEL SANDBOX         │ ← execution plane
        │ user's project       │          │   agent-bridge.mjs       │
        └──────────────────────┘          │   /workspace/project     │
                                          └──────────────────────────┘
```

There is **one** adapter, **one** control service, **one** approval broker and
**one** event model. The only thing that forks is the runtime seam, which is
the narrowest place it could.

---

## 2. What the browser may say

`projectId`. That is the whole vocabulary for naming a project.

It may not say: a filesystem path, a working directory, a sandbox id, a sandbox
name, a shell command, an image, a region, a timeout, an egress host, or a
permission scope at session time. None of these has a field in
`runtime/protocol.ts`, which is a closed union — so this is enforced by the
type, not by a check.

The one exception is the remote-project **creation** flow, which has to accept
file names. It lives on its own route (`/api/agents/remote-projects`) precisely
so the control protocol's vocabulary does not have to grow to include bytes.
Every uploaded path is rebuilt from validated segments by `remote/upload.ts`
before it can reach a filesystem.

---

## 3. Why the sandbox log is the journal

This is the least obvious decision in the phase, and the one most likely to be
"fixed" back into a bug.

A serverless function holds nothing between requests. The runtime host's event
journal — which assigns the sequence numbers the client's `afterSequence`
cursor addresses — is in memory, and is **empty at the start of every
request**.

So a stored byte cursor would be actively wrong: it would hand back "events
since byte N" to a journal holding nothing before N, and the client's cursor
would address sequence numbers this process never assigned. The stream would
have holes.

Instead the bridge's append-only NDJSON log **is** the durable journal. It is
replayed from the beginning on every request; the journal assigns the same
sequences to the same lines in the same order and deduplicates by event id, so
replay has no side effects.

**Cost.** One whole-log read and re-normalisation per request. The log lives
only as long as its sandbox (20 minutes by default), so it is small. If
sessions ever need to run for hours, the fix is a **durable journal**, not a
cursor — a cursor would reintroduce exactly the hole described above.

---

## 4. How an approval survives a process that does not

The agent blocks inside the microVM. The request that saw its permission
request ends. The user answers minutes later, on an instance that has never
heard of it.

Two rules make that work, and both are load-bearing:

1. **The drain stops at an unresolved permission.** The pending request is
   re-read on every drain, so the adapter re-registers a resolver and
   `respondToApproval` finds one. The bridge emits `permission_resolved` when
   it gets an answer, which is the signal that the drain may move past it.
2. **The approval id comes from the bridge, not a counter.**
   `ClaudePermissionRequest.stableId`. Two reads of the same pending request
   produce the same approval id, so the broker sees a duplicate rather than a
   second prompt, and the journal drops the repeated event.

Nothing stores an approval. **The provider's own blocked state is the durable
record** — the only version of this that cannot drift out of sync with the
agent.

The sandbox never grants itself anything: `canUseTool` writes a request and
blocks, and denies on a 10-minute deadline. Fail-closed is the only direction
it can fall.

---

## 5. Claude authentication

The remote sandbox is a fresh microVM with no Claude login and no way to
acquire one, so running an agent there requires a server-side credential.

**What is implemented:** an operator-supplied `ANTHROPIC_API_KEY` on the
deployment. It is read from `process.env` at the moment a bridge starts, handed
to the platform over TLS as one process's environment, and referenced nowhere
else. It is never written to a row (the schema has no column for one), never
put in a prompt, never emitted on an event, never logged, and never sent to the
browser. `security.test.ts` asserts each of those.

Consequence, stated plainly: **the deployment's owner pays for every user's
agent runs.** That is a deliberate choice for a single-tenant or small-team
deployment and is the wrong one for a public multi-tenant product.

**What is NOT implemented, and why.** Delegating a user's own Claude
subscription to a hosted service. There is no supported mechanism for a
third-party service to hold a person's Claude.ai OAuth credential, and
inventing one would mean storing their session token on our server. That is the
"report the exact blocker rather than fake it" case, and this is the report.

**The seam for per-user keys** is `PROVIDER_CREDENTIAL_ENV_VAR` in
`remote-runtime.ts` — one function, `hasProviderCredential`, and one read. A
bring-your-own-key implementation replaces both with a lookup against an
encrypted per-user secret store. What it must not do is put a key anywhere the
current one is forbidden from going.

When no credential is present the provider reports **Authentication required**,
truthfully, and no sandbox is started.

---

## 6. Lifecycle

| State | Meaning |
| --- | --- |
| `creating` | Requested, not usable. Nothing may be dispatched. |
| `ready` | Exists, warm, holds the project's files. No agent running. |
| `running` | An agent process is live inside it. |
| `stopping` | Teardown asked for. Nothing new may start. |
| `stopped` | Deliberately stopped; filesystem snapshotted, so it resumes with files intact. |
| `expired` | Past its deadline, reclaimed by the platform. The user did not ask. |
| `failed` | Creation or execution failed. Not reusable. |

A stopped or expired sandbox is **resumed, not reused**: `ensure()` is the
lifecycle logic, and it is the only path back. Resuming is what makes a remote
project a project rather than a single sitting — the files and the installed
dependencies are still there.

`sweepExpiredSandboxes` exists because the platform reclaims the microVM but
does not update our rows. Without it, a project whose sandbox died an hour ago
still counts against the per-owner limit.

**Ordering on create:** row first, then sandbox. The opposite order loses a
microVM whenever the write fails — running, billing, and nameless. A leaked row
costs nothing; a leaked sandbox costs money and cannot be found. On delete the
order reverses, for the same reason.

---

## 7. Limits

Documented defaults, all in `remote/types.ts`:

| Limit | Value | Why |
| --- | --- | --- |
| Sandbox timeout | 20 min | Platform default of 5 is too short for a conversation; extended while a session is active. |
| Max lifetime | 2 h | A ceiling an extension may not push past. |
| Sandboxes per owner | 3 | Bounds the steady state. Not a lock — two concurrent creates can both pass. |
| Sessions per owner | 5 | Same. |
| Upload total | 4 MB | **The platform's limit, not a product choice.** A serverless request body caps at ~4.5 MB. |
| Upload per file | 4 MB | — |
| Upload file count | 2 000 | A count above this is not a project. |
| Drain per request | 1 MB | Bounds a runaway agent's output. |
| Approval deadline | 10 min | Then denied, inside the sandbox. |
| vCPUs | 2 | Platform default; ample for one agent. |

Larger uploads need staged transfer through a blob store. That is real work and
is a **seam, not a half-build**.

---

## 8. Egress

Deny by default. The allowlist is `api.anthropic.com` and
`registry.npmjs.org` (the bridge's single dependency). The sandbox cannot reach
this deployment's own API, which is why the control channel is files rather
than a callback — there is no credential inside the microVM that could reach
back.

---

## 9. Multi-user isolation

Ownership is a **query predicate**, not a check performed on a fetched row.
There is deliberately no `findProject(id)` on `RemoteStore`; a row that is not
yours does not come back at all.

Above that, a remote `RuntimeHost` is built **per actor**: the adapter it holds
was constructed against a store view scoped to one account, so there is no
argument any request can carry that reaches another's sandbox.
`remote-runtime.test.ts` and `store.test.ts` drive the cross-account cases.

---

## 10. `authorize_projects` on a remote host accepts nothing

The single most important refusal in this design.

Those records describe directories on the machine running the *browser*. A
hosted TabDump cannot see that machine — but a path from one would still
*validate*, because `validateProjectPath` checks the shape of a path, not the
existence of a filesystem. Accepting one would create an authorized project
whose path resolved, if at all, to a directory **on the server**. That is the
hosted-execution hole the Phase B boundary exists to prevent, arriving through
the one command that carries a path.

They are refused by name (`reason: "remote-runtime"`) rather than silently, so
the user is not left believing a project was authorized.

---

## 11. Deployment

```bash
npm run migrate:remote
```

Required environment:

- `POSTGRES_URL` or `DATABASE_URL` — without it, `no-durable-store`, refused.
- Sandbox credentials — `VERCEL_OIDC_TOKEN` (automatic on Vercel) or the
  `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` / `VERCEL_TOKEN` trio.
- `ANTHROPIC_API_KEY` — without it the runtime is available and the provider
  reports **Authentication required**.

The desktop build is untouched: `next.config.ts` still drops every `route.ts`
from the Tauri static export, so the packaged app gains no server assumptions
and no remote runtime.

---

## 12. What was deliberately not built

- **`remote_git`.** The source type is declared and nothing creates one. Doing
  it safely needs a credential path that does not exist yet, and inventing one
  would be the insecure shortcut the brief rules out.
- **Per-user provider credentials.** §5.
- **Staged large uploads.** §7.
- **Streaming push.** The client polls `get_events` with its existing cursor.
  That satisfies "do not hold a request open indefinitely" honestly; SSE would
  be an optimisation, not a correctness fix.
- **Codex, Gemini, Grok.** The seam is provider-neutral — `RemoteSandboxService`
  names no provider and the bridge is chosen by the runtime that starts it —
  but a provider joins the capability list when it has a runtime, not when it
  has a name.
