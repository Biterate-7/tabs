# Phase 17 — Multi-Agent Connector Framework

Hubble observes AI coding agents. Phases 11–16 built the domain that
*represents* their work and one integration that fills it. Phase 17 adds the
layer above: a provider-neutral way to say **who** can be observed, **whether
they currently can be**, and **what they are able to tell us** — so that
adding the next provider is an adapter problem rather than a change to the
application.

Nothing here reverses the direction of data. It remains:

```
external agent → connector → normalized observation → agent domain → workspace
```

There is no path in the other direction, and the contract has no member that
could create one.

---

## 1. Where the pieces live

```
src/lib/agents/
├── types.ts              Agent, AgentRun, AgentEvent, WorkArtifact, AgentWorkItem
├── adapter.ts            the observation seam + ingestObservation   (phase 11)
├── registry.ts runs.ts events.ts links.ts artifacts.ts work-items.ts
├── persistence.ts        tabdump:agents:v1
├── spatial/ intelligence/
│
├── claude-code/          ONE Claude Code integration                (phase 12)
│   └── reader, parser, normalizer, cursor, adapter, mapping
│
└── connectors/           ← phase 17
    ├── types.ts              provider ids, capabilities, status, health,
    │                         the AgentConnector contract
    ├── base.ts               status/listener/disposal bookkeeping
    ├── registry.ts           descriptors + lazy factories
    ├── manager.ts            lifecycle, fan-out, bounded reconnect, teardown
    ├── app-manager.ts        the application's single manager
    ├── catalog.ts            THE one provider-aware module
    ├── health.ts             derived health, from real state only
    ├── persistence.ts        tabdump:connectors:v1 (intent; never secrets)
    ├── session-credentials.ts in-memory only, for the life of one tab
    ├── ingest.ts             provider-neutral observation → domain
    ├── usage.ts              per-provider counts, from recorded state
    ├── observability.ts      structured logging with nowhere to put content
    └── providers/
        ├── claude-code.ts    wraps the existing adapter
        └── declared.ts       registered, described, honestly unable
```

The split between `agents/` and `agents/connectors/` matters. The generic
domain still may not know a provider exists — `src/lib/agents/security.test.ts`
enforces that mechanically, and Phase 17 did not weaken it. The connector layer
is where providers become visible, and it has its own guards in
`connectors/security.test.ts`.

---

## 2. The contract

```ts
interface AgentConnector {
  readonly provider: AgentProviderId
  readonly descriptor: ProviderDescriptor

  getStatus(): ConnectorStatus
  connect(): Promise<ConnectorStatus>
  disconnect(): void
  subscribe(observer: ConnectorObserver): ConnectorUnsubscribe
  watchStatus(listener: ConnectorStatusListener): ConnectorUnsubscribe
  dispose(): void
}
```

`connect` and `disconnect` are about **Hubble's own observation**. They start
and stop this app watching; they do not reach the external agent. There is no
`start`, `stop`, `kill`, `cancel`, `exec`, `prompt`, `sendMessage` or `write`,
and a test fails the build if one appears.

`dispose` is separate from `disconnect` on purpose: disconnecting is a
reversible user action, disposing is teardown.

### Status

Seven states, and the ones that look alike are kept apart because they ask
different things of the user:

| status | meaning | can the user act? |
|---|---|---|
| `disconnected` | observable; not asked for | yes — connect it |
| `configuration_required` | asked for; something they must supply is missing | yes — supply it |
| `unavailable` | asked for; this environment cannot do it | **no** |
| `connecting` / `reconnecting` | in progress | wait |
| `connected` | observing | — |
| `error` | could observe, tried, failed | maybe |

Showing all three of the first group as "Not connected" would send someone
hunting for a setting that does not exist.

### Capabilities

```ts
type ConnectorCapabilities = {
  runs: boolean; events: boolean; files: boolean
  artifacts: boolean; workItems: boolean; liveUpdates: boolean
}
```

Everything defaults to **false** (`NO_CAPABILITIES`). A provider declares what
it can do; anything unclaimed is assumed absent. The opposite default would
make every new provider look fully-featured until someone remembered to switch
things off, and the UI would promise data that never arrives.

Capabilities describe *ability*, not the current moment: a connector that can
observe work items still declares `workItems: true` during a poll that found
none.

### Health

Derived (`health.ts`), never simulated. A connector that is `connected` and has
observed nothing reports **idle**, not healthy — "connected and has told us
nothing" is a real state, and rendering it as healthy is how a UI starts
implying activity that has not happened. Silence is judged against the
connector's own expected interval, not a constant.

---

## 3. Lifecycle

```
disconnected
     │ connect()                          ┌──────────────┐
     ▼                                    │  bounded     │
connecting ──────► connected ──► error ──►│  backoff     │
     │                  ▲                 │  ×4, then    │
     │                  └── reconnecting ◄┘  give up     │
     │                                    └──────────────┘
     ├──► unavailable              (environment cannot)
     └──► configuration_required   (user must supply something)
```

Reconnection lives in the manager, is scheduled only on a transition into
`error`, doubles from 2s to a 30s ceiling, is capped at four attempts, and is
cancelled the instant the user disconnects — intent always beats a timer that
was already in flight. A successful connection resets the budget.

**Resource rules, all covered by tests:**

- one connector per provider (the registry memoises; the manager is a singleton)
- the manager attaches to a connector exactly once, however often it connects
- every fan-out iterates a snapshot, so a listener may unsubscribe while being
  notified
- a disposed core emits nothing — an in-flight request that resolves after
  teardown cannot push into a torn-down app
- `dispose` clears timers, listeners and constructed connectors, and is
  idempotent

---

## 4. How Claude Code fits

`connectors/providers/claude-code.ts` is a **wrapper, not a second
integration**. Discovery, transcript parsing, normalisation, path handling, the
cursor and the poll loop all stay in `src/lib/agents/claude-code/`. The wrapper
adds identity, capabilities, status and lifecycle.

Its capability declaration is verified against what the pipeline actually
produces — runs, events, files, artifacts, work items, live updates. It is
`liveUpdates: true` for a *polling* connector because the capability asks
whether a consumer learns about a run while it is still going, and it does. The
only push channel Claude Code exposes is its messaging socket, which is a
control channel and is dropped at the reader precisely so nothing downstream
can reach it.

The poll result doubles as the health signal: the same request that looks for
sessions proves the local installation is readable. `available: false` becomes
`unavailable` with an explanation, **not** an error — a hosted deployment or a
machine that has never run Claude Code is a correct, stable answer.

### Platform reach

Observing Claude Code means reading files under `~/.claude` on the machine the
user is sitting at, which is done server-side by `/api/agents/claude-code`
(Node runtime). That gives three honest outcomes, and the connector reports the
same `unavailable` state with the same explanation for all of them:

| build | outcome |
|---|---|
| `next dev` / `next start` on the user's own machine | **works** |
| hosted deployment (Vercel, etc.) | `unavailable` — `~/.claude` there is not the user's |
| Tauri desktop (`desktop:export`, static) | `unavailable` — no API route in a static export |

The desktop gap is real and is left open deliberately. Closing it would mean
granting the Tauri shell filesystem access to the user's home directory, and
Phase 17 is not a good enough reason to widen native permissions past the
least-privilege model the desktop build already follows. The connector
boundary is where that would be fixed if it ever is: a Tauri-backed source
behind the same contract, changing nothing above it.

### Behaviour change worth knowing

Before Phase 17 the observer polled unconditionally. Now nothing is observed
until the user connects Claude Code in **Settings → Agents**, and that
choice is remembered per account. This is deliberate: the phase introduces an
explicit consent flow that states the security boundary, and polling someone's
machine because the app started is the thing that flow exists to replace.

---

## 5. The ingestion path is provider-neutral

`connectors/ingest.ts` holds the rules every provider binding shares:

- **agent identity** — one `Agent` per provider, resolved through live state so
  a batch can attribute to an agent it created moments earlier
- **batch folding** — workspace attachment, then `store.ingest`, then URL
  linking, in that order because a run must exist before anything links to it
- **URL linking** — exact normalized match only, within the run's own
  workspace; a near-miss link is worse than no link

The only genuinely per-provider piece is *policy*: which workspace a session
belongs to. Claude Code supplies that from its explicit project mapping; a
future provider supplies its own. Everything downstream is identical, which is
what "the core application must not understand provider-specific event formats"
means in practice.

---

## 6. Security

### No execution

`connectors/security.test.ts` fails the build if anything in the layer imports
`child_process`, `node:fs`, `node:net`, a worker or a VM, or contains an
execution call shape, or shells out to git.

### Credentials

Claude Code needs none — it is observed by reading files that already belong to
the user on the machine they are sitting at. Every network-reached provider
would need one, and the honest position is this:

> **Hubble does not persist secrets, because this platform cannot keep them.**

In the browser build, `localStorage`, `sessionStorage`, IndexedDB and non-
`HttpOnly` cookies are all readable by any script on the origin, survive across
sessions, and sit in a profile directory other software can read. There is no
browser API that gives a web app an encrypted store. The desktop build has an
OS keychain available in principle, but Hubble's Tauri capabilities do not
grant access to one, and widening native permissions to make a connector feel
finished would trade a real boundary for a cosmetic one.

So `session-credentials.ts` holds secrets in a module-scoped `Map` that dies
with the tab. It imports nothing but types, so it has no way to write a value
anywhere. It offers no `list`, `entries` or `toJSON`, so no export or debug
dump can sweep secrets up. The UI is told only presence and length — not even a
masked prefix, since that habit is borrowed from services that can revoke keys
and Hubble cannot. A provider configured this way is labelled *configured for
this session*, never *persistently connected*.

### Persistence

`tabdump:connectors:v1` holds `{ provider, enabled, enabledAt }` and nothing
else. `saveConnectorConfig` serialises field by field rather than stringifying
what it was handed, so a token attached by a later change cannot reach storage
even by accident. Corrupt state fails **closed** — observation off, not on.
The key is registered in `SCOPED_STORAGE_KEYS`, so one account's connector
setup is invisible to another.

Status is never persisted. Restoring a saved "connected" would show a
connection that has not been established.

### Export

Workspace export does not include connector state or agent state, and the
export modules do not import the connector layer at all — so there is no route
by which a future change could start including it without that import
appearing in a test.

### Logging

`ConnectorLogRecord` has fields for an event name, a provider, a status, an
error **code**, a count and an attempt number. There is no message, detail,
payload or raw field, so there is nowhere for provider content to go. Off by
default: a local-first app must not leave a trail of what someone was working
on in a console they did not ask for.

Errors are minted by `connectorError(code)`, which takes a code and nothing
else — the structural reason a provider cannot get a string of its choosing
onto the user's screen by throwing one.

---

## 7. Adding a provider

Four things, none of them outside the provider's own files and the catalog:

1. **A descriptor** — id, display name, one-line summary, honest capabilities,
   and a `requirement` sentence if it needs something.
2. **A connector** — `src/lib/agents/connectors/providers/<name>.ts`,
   implementing `AgentConnector`. Build on `createConnectorCore` so status,
   listeners and disposal behave like every other connector.
3. **Normalisation** — provider-specific parsing lives beside the connector and
   produces `ConnectorObservation`s. Nothing above the connector may learn the
   provider's own formats.
4. **A registration** in `catalog.ts`, and tests.

Nothing in the manager, the registry, the hooks, the domain, the graph or the
settings UI changes. That is the property the layer exists to have.

A provider that cannot yet be observed uses `createDeclaredConnector`: fully
registered, fully described, and structurally unable to emit an observation. It
is not a placeholder — it is the honest implementation of "we cannot watch this
here", and it is what Codex, Gemini, Grok and Custom use today.

---

## 8. What is real, and what is not

| provider | status | why |
|---|---|---|
| **Claude Code** | real, complete | reads the session files it writes locally |
| OpenAI / Codex | registered, `unavailable` | no verified local format to read |
| Gemini | registered, `unavailable` | same |
| Grok | registered, `unavailable` | same |
| Custom | registered, seam only | implemented in code by whoever brings the agent |

The three unimplemented providers declare `NO_CAPABILITIES` rather than an
aspirational list, and each carries its own explanation rather than a shared
"not supported". Building a reader against an unverified format would produce a
connector that reports confident nonsense whenever the guess was wrong, which
is worse than saying nothing.

---

## 9. UI

**Settings → Agents** lists every provider with its state, opens a
detail view with status, health, capabilities, activity and real usage counts,
and gates connection behind a screen that states what Hubble will and will not
do. Those two lists are the literal security boundary, and a user agreeing to
be observed deserves to see it in the product.

**The workspace sidebar** shows a compact strip of connected agents with their
states, and gains a provider filter — but only once two or more providers have
actually worked in that workspace, because a control offering one choice is
noise. The filter is a second dimension alongside the existing status filter,
not another value inside it, so "active Codex work" is expressible.

Four empty states are kept distinct, because they ask for four different
things: connect something, wait, fix a connection, change the filter.

No count is rendered that was not recorded. A provider that has done nothing
shows no numbers rather than a row of zeroes that reads like a measurement.
