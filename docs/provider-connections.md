# Provider connections — bring your own credentials

Hubble is the command centre. The AI provider is the model. This document
describes the layer that keeps those two things separate: **each user connects
their own provider credentials, and Hubble never runs anybody's agent on a
credential that is not theirs.**

The invariant, in one picture:

```
USER
  ↓
THEIR PROVIDER CONNECTION
  ↓
HUBBLE COMMAND CENTRE
  ↓
AUTHORIZED PROJECT + HUBBLE CONTEXT
  ↓
THEIR AI AGENT
  ↓
AUTHORIZED WORK
```

And the shape that must never exist:

```
ALL USERS  →  HUBBLE'S SHARED AI CREDENTIAL  →  AGENTS
```

That second shape is what the codebase had before this phase, honestly labelled
as such in the remote-runtime document. It is gone. `docs/provider-credential-audit.md`
records what was audited and reclassified.

---

## 1. The three things this layer keeps apart

```
Provider connection    this user has credentials for this provider
        ↓
Agent session          this agent is working on this project
        ↓
Agent run              this turn
```

They were one thing before, in the sense that there was nothing to separate: a
deployment had one key and every session used it. A connection is now a
first-class record with an owner — which is the whole reason the rest of this
works.

---

## 2. Authentication model

**Claude, with the user's own Anthropic API key.** That is the one method
implemented, and the naming in the product matches it exactly: the button says
**Connect Anthropic API**, never "Connect Claude account".

The distinction is a correctness question, not a style one. Hubble holds an
API credential the user issued to themselves. It does not hold a delegated
grant, cannot act as them, and cannot see their Claude.ai subscription — and
"Connect your Claude account" would claim all three.

### Why an API key and not OAuth

Anthropic documents two mechanisms for software that is not the user sitting at
their own terminal:

| Mechanism | What it is | Status here |
| --- | --- | --- |
| API key on `x-api-key` | The developer-product route | **Implemented** |
| Workload Identity Federation | Service-to-service | Declared, not implemented |
| `ant auth login` OAuth | Writes a profile on a *developer's own machine* for that developer's own tools | Not a third-party delegated grant — not implemented, and not faked |

`ProviderAuthMethod` is a union — `api_key | workload_identity | official_oauth`
— so that publishing a delegated flow for third-party applications becomes one
adapter and one registry entry rather than a rewrite of this layer. Nothing
assumes `official_oauth` exists for any given provider.

**What this layer will never do**: scrape Claude.ai cookies, read a user's
local Claude Code OAuth state, harvest `~/.claude`, or ask anybody to paste a
browser session token. None is a supported third-party mechanism, and storing
one would mean holding a person's login session under a name implying otherwise.

### Validation

`GET /v1/models?limit=1` with the credential on `x-api-key`. The cheapest
authenticated endpoint Anthropic exposes: it proves the provider accepts the
credential, spends no tokens, and costs nothing. A one-token `POST /v1/messages`
would bill the user to check a key, and a validation that costs money is a
validation people avoid running.

The response **body is never read** — only the status — and statuses are mapped
onto a closed set before anything downstream sees them:

| Status | Outcome | Means |
| --- | --- | --- |
| 2xx | `connection_valid` | Usable |
| 401 / 403 | `invalid_credentials` | Replace the key |
| 429 | `rate_limited` | Says nothing about the key |
| 5xx | `provider_unavailable` | Says nothing about the key |
| other | `validation_failed` | We do not know |

The last three matter: a provider that could not be reached must never mark a
working credential invalid.

---

## 3. Storage

```
AgentProviderConnection  →  credential reference  →  encrypted secret
   (read constantly)                                  (read once, per run)
```

Two tables, and the split is the security design. The connection row is read to
render settings, to decide whether a session may start, and to list what a user
has; if the secret were a column on it, one `SELECT *` in a support session
would be the whole breach.

**Cipher.** AES-256-GCM. One random 96-bit IV per record. The connection id is
bound in as additional authenticated data, so a ciphertext lifted out of one
row and dropped into another **fails to open** rather than handing the second
connection the first one's credential — an attack a plain encrypted column does
not stop.

**Key.** `TABDUMP_CREDENTIAL_KEY`, 32 bytes base64, never in the database.

```bash
node scripts/migrate-credentials.mjs --key
```

**What this is honestly worth.** It protects a leaked database dump, a backup
on a laptop, a readable replica, a `SELECT` in a support session. It does *not*
protect against an attacker who already holds the application's environment,
because they hold the key. That is the boundary of envelope encryption with a
deployment-held key. A KMS-held key is the upgrade, and it is one
implementation of `CredentialCipher` rather than a rewrite.

**Fail closed.** No key means no cipher means the whole feature reports itself
unavailable — no connecting, no sessions. It does not degrade to plaintext and
does not derive a key from something lying around. Rotating or losing the key
makes existing credentials unreadable and every user reconnects; back it up
where you back up your database password, and not beside the database.

**No orphans.** `tabdump_provider_secrets.connection_id` is a foreign key with
`ON DELETE CASCADE`, so even a delete that bypasses the service takes the
secret with it. The service also removes the secret *before* the row, so the
worse of the two partial-failure outcomes is a connection that cannot start a
session rather than a live secret nothing points at.

---

## 4. Where a credential is allowed to be

| Place | Allowed |
| --- | --- |
| The environment of one provider process | **Yes — the only one** |
| Encrypted at rest, in `tabdump_provider_secrets` | Yes |
| Browser state, `localStorage`, IndexedDB, React state | No |
| URL, query string, log, analytics | No |
| A prompt, a message, an event, a journal entry | No |
| A context attachment | No |
| A session row, a project row, sandbox metadata | No |
| An error message, an API response | No |
| Command-line or shell arguments | No |

`resolveCredential` in `credentials/service.ts` is the **only caller of
`reveal`** in the application. That is what makes "where could this have leaked
from?" a question with one answer, and the guard suite asserts it.

### Local runtime

The agent process's environment is rebuilt per run: a copy of the base
environment with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_BASE_URL` **deleted**, then the user's own credential written in.

Stripping rather than merely overwriting is deliberate. Overwriting alone would
mean a future edit that forgot to set the variable falls through to an operator
key that happened to be present, and silently works — invisible until a billing
statement arrives.

Nothing mutates `process.env`, so two concurrent sessions belonging to two
users cannot see each other's key.

### Remote runtime

```
Browser → Hubble server → resolve this actor's connection → reveal server-side
        → start sandbox → inject into the bridge process's environment only
```

The credential is not a command-line argument, not a project file, not part of
the sandbox's tags or metadata, and not on the session row. It is resolved
*before* a sandbox is touched, so a user with no usable connection cannot cause
a microVM to be created.

### Credentials are not context

`AgentContextKind` is a closed union with no credential-shaped member, the
context layer imports nothing from this one, and prompt assembly names neither.
An agent cannot ask for its own credential through the thing that assembles
what it is told.

### A credential is not a permission

It proves authentication and grants no additional Hubble capability. A Claude
credential plus project A does not reach project B: project scope is resolved
against what the actor authorized, owner-scoped in the store, and checked
before any credential is used.

---

## 5. Multi-user isolation

Every method on the connection store, the secret store and the service takes an
`ownerId` **in its signature**, and every implementation folds it into the
predicate rather than fetching and comparing afterwards. `find(id)` — the shape
that invites a forgotten check at a new call site — does not exist.

Ownership always comes from the authenticated session. No request shape has an
`ownerId` field, so there is nothing to forge and nothing to forget.

`security.test.ts` and `session-isolation.test.ts` assert that user A cannot
list, read, resolve, rotate, disconnect or revalidate user B's connection, and
that two concurrent sessions get two different credentials.

---

## 6. Command Centre

Starting a session resolves:

```
actor → provider connection → credential → runtime → Claude
```

There is **no fallback**. A user with no usable connection gets a refusal with
a reason, not somebody else's credential and not a deployment key. The edge

```
user credential unavailable  →  global Anthropic key
```

does not exist in the code, and the guard suite asserts that no module under
`src/lib` reads a provider key from `process.env`.

What the user sees when they have not connected:

> This agent isn't connected yet — add your own provider credentials to run it.
> **[Connect]**

The button goes to Settings → AI Connectors. Start stays disabled. A surface
with nowhere to send them shows the sentence without the button rather than an
action that goes nowhere.

Runtime infrastructure is not mentioned anywhere in that flow. Vercel Sandbox,
`RuntimeHost`, `ControlService` and credential injection are implementation
details.

---

## 7. Settings → AI Connectors

Each provider card carries three independent facts:

| Block | Question |
| --- | --- |
| Observation | Can Hubble see what this agent does? |
| Control | Can Hubble drive it? |
| **Connection** | Has *this user* authorized Hubble to use it? |

A provider can be in any combination, and none implies another. All three are
derived from actual registration — the observation connector, the runtime's own
`get_status`, and the credential registry — rather than from hardcoded text.

Connected shows the auth method, the name, and when it was last validated, with
**Rotate** and **Disconnect**. There is no "show key", no masked prefix and no
length: Hubble cannot revoke a key from that screen, so displaying part of one
would buy recognition at the cost of leaking it into every screenshot.

**Rotation** validates the new credential first and replaces the old one only
on success. A rejected replacement leaves the old credential active and usable;
an unreachable provider leaves the connection completely untouched, because
nothing was learned about either key.

**Disconnect** deletes the secret, removes the connection, and prevents new
sessions. It does not reach inside a session already running inside a microVM —
that agent is a live, already-authenticated process, and claiming otherwise
would be a promise this architecture cannot keep. Stopping a run is a separate,
explicit act.

---

## 8. Other providers

The registry is the source of truth.

| Provider | Connection |
| --- | --- |
| Claude | API key — implemented |
| Codex | Architecture ready, no adapter |
| Gemini | Architecture ready, no adapter |
| Grok | Architecture ready, no adapter |
| Custom | Extension point |

The three unimplemented providers have **no registration**, and
`credentialSupportFor` answers `unsupported` for each. A registration whose
`validate` always succeeded would hand a user a "Connected" badge for a
credential nothing ever checked — a fake with worse consequences than an
obviously missing feature.

---

## 9. Deployment

```bash
node scripts/migrate-credentials.mjs --key   # generate TABDUMP_CREDENTIAL_KEY
npm run migrate:credentials                  # create the tables
```

- `TABDUMP_CREDENTIAL_KEY` — **required.** Without it no credential can be
  stored or read.
- `POSTGRES_URL` / `DATABASE_URL` — optional. Without one, connections are held
  in process memory: still encrypted, still per-user, but lost on restart. The
  settings page says so rather than letting anybody discover it later.
- `ANTHROPIC_API_KEY` — **no longer read.** A key left in the environment is
  inert.

The desktop build is untouched: `next.config.ts` still drops every `route.ts`
from the Tauri static export, so the packaged app has no provider-connections
endpoint and gains no server assumptions.

---

## 10. What is verified, and what is not

**Verified against real Anthropic infrastructure.** The validation request's
shape: `GET /v1/models?limit=1` with `x-api-key` and `anthropic-version`
returns **401** for an invalid key — not 404, not 400 — which confirms the URL,
the version header and the auth header name are all correct, and that a
rejected credential maps to `invalid_credentials`.

**Not verified.** The success path. No valid Anthropic credential was available
in this environment, so **no real key has been validated and no real agent run
has been performed through this layer.** Everything about the 2xx branch —
`connection_valid`, storing a working credential, and a real Claude session
running on a user's own key — is exercised only through the adapter's injected
`fetch` seam and through the fake sandbox.

**Also not verified.** The real Vercel Sandbox integration, unchanged from the
previous phase: `RemoteSandboxService` is tested against a fake implementation.
Credential injection into a *real* microVM has not been exercised.

To verify the success path with a real key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...            # a real key
export TABDUMP_CLAUDE_INTEGRATION=1
export TABDUMP_LOCAL_AGENT_RUNTIME=i-am-running-tabdump-on-my-own-machine
npx vitest run src/lib/agents/control/providers/claude-code/integration.local.test.ts
```

That suite reads the key through the integration fixture — a developer's own
credential for a developer's own opt-in test, and the only place in the
repository permitted to read one from the environment.
