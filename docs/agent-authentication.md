# Agent Authentication & Runtime

How a person connects an AI agent to Hubble with the sign-in its provider
**officially supports** — and why some sign-ins are not offered.

Hubble is the orchestration and UI layer. Wherever a provider permits it, the
agent's own runtime (Claude Code, Codex, Gemini CLI, Grok Build) performs the
sign-in and keeps the credential; Hubble only asks whether it is signed in.
Hubble does not become a credential broker, and never claims that a
subscription can be used where the provider does not permit it.

```
Settings → Agents / Command Centre ── Connect Agent (one dialog, every provider)
        │   AgentAuthPanel: offered methods · the one in use · not available, and why
        ▼
lib/agents/platform/catalog.ts         the capability model: providers, runtimes, auth methods
lib/agents/platform/authentication.ts  derived: offered/unavailable methods, capabilities, validation
lib/agents/platform/lifecycle.ts       derived: phase, sentence, recovery, readiness, session prerequisites
        │   typed runtime protocol (no field can carry a credential)
        ▼
RuntimeHost ── get_status waits (bounded) for in-flight connects
   ├── Claude adapter ── credential source: user's API key (web) | Claude Code's own login (desktop)
   │                      desktop: `claude auth status` → loggedIn + authKind; subscription refused
   └── ACP adapter ────── the agent's own sign-in via ACP `authenticate`; probe via `session/new`
```

## 1. Four ideas kept apart

| Concept | What it is | Examples | Where it lives |
| --- | --- | --- | --- |
| **Provider** | The company whose model runs | Anthropic, OpenAI, Google, xAI | `PlatformProvider.vendor` |
| **Runtime** | The program Hubble starts or asks; it owns the sign-in | Claude Code, Codex (via `codex-acp`), Gemini CLI, Grok Build | `PlatformProvider.runtimeName`, `launch/allowlist.ts` |
| **Authentication method** | How the runtime proves it may use the provider | Anthropic API key, Anthropic Console account, Google account, … | `PlatformProvider.auth` |
| **Availability** | Where it stands right now | Not installed, Sign-in required, Connected, Didn't respond | `ConnectionPhase`, derived |

## 2. The capability model

Every provider's entry in `platform/catalog.ts` lists **every authentication
method its provider documents**, each with:

| Field | Meaning |
| --- | --- |
| `kind` | `account` (the provider's own sign-in, run by its runtime), `api_key`, `environment` (a cloud credential in the agent's own config) or `hubble_token` (the custom agent) |
| `subscription` | Whether this sign-in can carry a paid plan — claimed only where the provider documents it |
| `owner` | Who holds the credential: `runtime` (the agent's own store — preferred), `hubble` (Hubble's encrypted per-user store) or `agent_config` |
| `support` | `offered` on some surfaces · `external` (set up in the agent itself; Hubble uses it when reported) · `unsupported` **with the reason shown to the user** |
| `runtimeMethodIds` | The ids the agent itself advertises for it; a runtime sign-in is offered only when the agent advertises one of them |
| `reportedAs` | The `authKind` the runtime reports when this method is the one in use |

Everything the UI shows is derived from it (`platform/authentication.ts`):
`offeredAuthMethods`, `unavailableAuthMethods`, `externalAuthMethods`,
`activeAuthMethod`, `authIntro`, `signInShape`, and `agentCapabilities` —
`supportsSubscriptionAuth`, `supportsAccountAuth`, `supportsApiKey`,
`supportsLocalRuntime`, `supportsWorkspaceContext`, `supportsSessionControl`,
`supportsMcp`, how installation and sign-in are detected, the install command
and docs URL. No component branches on a provider id.

`validateAgentDefinition` holds every definition to the security rules, and
the test suite runs every shipped entry through it:

- a runtime sign-in that is offered must name the ids the agent advertises;
- Hubble never collects a plan's login (`hubble` + `subscription`);
- a key Hubble stores is offered only to an SDK runtime (agents launched as
  processes get an allowlisted environment with no key);
- an environment credential is never offered as a Hubble flow;
- an unsupported method must say why;
- a client agent (`transport: mcp`) cannot declare a runtime sign-in, a
  session or a chat — i.e. cannot declare a program for Hubble to launch.

## 3. What each provider supports — verified, 2026-09-28

| Provider · runtime | Offered by Hubble | Not offered, and why | Subscription/account through its runtime? |
| --- | --- | --- | --- |
| **Anthropic · Claude Code** (web) | **Anthropic API key** — the user's own, stored encrypted server-side, validated with `GET /v1/models` | Console sign-in (runs through Claude Code in the desktop app); **Claude subscription** (see below); cloud providers | **No** |
| **Anthropic · Claude Code** (desktop) | **Anthropic Console account** — `claude auth login --console`, run by the user's installed Claude Code; Claude Code keeps the login | API key (the desktop app stores no credentials); **Claude subscription**. Cloud providers (Bedrock/Vertex/Foundry) configured *in Claude Code's own settings* are recognised, not collected | **No** — Console is API-usage billing, not a subscription |
| **OpenAI · Codex** (`codex-acp`) | **ChatGPT account** — Codex's own sign-in (`chat-gpt`) | OpenAI API key (Hubble passes no keys to agents it launches) | Yes, by its runtime — **but Hubble starts no Codex sessions** (Codex runs commands and reads files unasked even in codex-acp 2.0.0's `read-only` mode; see `agent-connector-platform.md` §5), so it is shown and never offered. Signed in → `sessions_unavailable`, never "Connected" |
| **Google · Gemini CLI** | **Google account** — Gemini CLI's own Login with Google (`oauth-personal`) | Gemini API key; Vertex AI (environment credentials Hubble does not pass) | **Yes** — Gemini Code Assist, including Google AI Pro/Ultra, per Gemini CLI's terms |
| **xAI · Grok Build** | **xAI account** — Grok Build's own browser sign-in (`grok.com`) | xAI API key (`XAI_API_KEY`; Hubble passes no keys) | Account sign-in yes; **which plans it covers is not documented, so none is claimed** |
| **Custom MCP agent** | **Hubble access token** (web only) | — (Hubble never launches it; the desktop app runs no MCP server) | n/a |

### Why Claude subscription sign-in is not offered

Anthropic's current terms for software like Hubble, checked 2026-09-28
(paraphrased; see the linked pages for the exact wording):

- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview):
  unless previously approved, third-party products — including agents built
  on the Agent SDK — may not offer claude.ai login or its rate limits, and
  should use API-key authentication instead.
- [Claude Code legal & compliance](https://code.claude.com/docs/en/legal-and-compliance):
  developers building products with the Agent SDK should authenticate with an
  API key through the Claude Console or a supported cloud provider; third
  parties may not offer Claude.ai login in their own apps, nor route requests
  through Free/Pro/Max plan credentials on users' behalf.

Hubble drives Claude Code through the Agent SDK, so:

1. The launch allowlist no longer contains `claude auth login --claudeai`
   (`launch/security.test.ts` pins its absence). No request can start it.
2. The desktop runtime reads **which** login Claude Code is using from
   `claude auth status` (verified against Claude Code 2.1.229: `loggedIn`,
   `authMethod` — `"claude.ai"` for a subscription — `apiProvider`, and whether
   `subscriptionType` is present). Either subscription signal is enough.
   Nothing else is read, kept or forwarded — no email, organisation or plan.
3. A subscription login is reported as **signed in, not permitted**
   (`authKind: "subscription"`, `authIssue: "method_not_permitted"`). The
   credential source refuses it, so no session starts on it; the UI says
   "Claude Code is signed in with a Claude subscription, which Hubble can't
   use" and offers the Console sign-in. Hubble never signs the user out and
   never switches methods for them.

This is a behaviour change for the desktop app: before, "Sign in with Claude"
was offered and a subscription login ran sessions. If Anthropic approves
Hubble for subscription sign-in, enabling it is the catalogue entry's
`support` plus the allowlist's `loginArgs` — nothing else changes.

### What was verified live (2026-09-29)

- **Claude Code 2.1.229, signed in with a Pro subscription**, through the
  desktop runtime's production path (`claude-auth.local.test.ts`, opt-in):
  reported `authentication: authenticated`, `authKind: subscription`,
  `authIssue: method_not_permitted`; only the Console sign-in offered;
  `create_session` refused; no account detail in any reply.
- **Gemini CLI, Grok Build and codex-acp** (real installs, all signed out),
  through the local web runtime and the production launcher: each detected,
  each answered "sign-in required", each advertised only its own sign-in —
  `oauth-personal`, `grok.com`, `chat-gpt` — exactly the catalogue's
  `runtimeMethodIds`; no API-key method reached the UI.
- **Claude on the web runtime without a stored key:** the very first
  `get_status` of a cold process reported `configuration_required` /
  `required` (settled), never `connecting`.

### What was not verified

- **Claude Console `authMethod` value.** No Console account was available, so
  the exact string Claude Code reports for a Console login was not observed.
  The rule does not depend on it: any first-party sign-in that is *not* the
  verified subscription marker and carries no plan is treated as a Console/API
  sign-in. Cloud providers are recognised from a non-`firstParty`
  `apiProvider`; that value was not observed live either.
- **Live sign-ins** for Gemini, Grok and Codex accounts (no accounts were
  used; each real agent reported itself signed out — `agent-connector-platform.md`
  §10). The method ids are from the agents' own advertisements.

## 4. Runtime availability — the state machine

`platform/lifecycle.ts` derives one phase per provider from independent facts:
detection, the runtime's report (including `authKind`/`authIssue`), the last
connect/sign-in outcome **for that provider**, the watchdog, and the roster.

```
DISCOVERING (unknown) → NOT_INSTALLED | INSTALLED (detected)
  → AUTHENTICATION_REQUIRED (sign_in_required) → AUTHENTICATING
  → AUTHENTICATED (awaiting_approval) → READY (connected)
                  ↘ AUTHENTICATED, NOT SESSION_READY (sessions_unavailable)

terminal:  timeout · auth_failed · auth_expired · auth_unsupported
           connection_lost · error (unreachable) · runtime_unavailable
```

| Phase | Sentence (example) | Recovery |
| --- | --- | --- |
| `sign_in_required` | "Claude Code needs you to sign in." | Sign in |
| `sessions_unavailable` | "Codex is signed in, but Hubble can't start sessions with it." | none in Hubble — the exact reason is shown, and New session disables the agent |
| `auth_expired` | "Gemini CLI is no longer signed in. Sign in again to keep using it." | Sign in |
| `auth_failed` | "Claude Code couldn't authenticate." | Try again · Setup |
| `auth_unsupported` | "Claude Code is signed in with a method Hubble can't use." | Use a supported sign-in · Setup |
| `timeout` | "Gemini CLI didn't respond in time." | Retry · Setup |
| `error` | "Claude Code isn't reachable." | Retry · Setup |
| `connection_lost` | "Hubble lost its connection to the agent runtime." | Retry (re-handshakes first) · Setup |

### Nothing stays "Connecting…"

The production bug: a hosted runtime builds its host — and a new Claude
adapter — per request and fires `connect()` without waiting; `connect()` sets
`connecting` before its credential lookup resolves, so **every** `get_status`
said `connecting`, forever, to a signed-out user. Four bounds now apply:

1. **Host:** `get_status` waits up to 5 s (`STATUS_SETTLE_MS`) for any adapter
   still connecting (`control/connect-settle.ts`), so it reports the settled
   state (`configuration_required` → "Sign-in required").
2. **Adapter:** Claude's `connect()` is bounded (15 s) and settles into
   `error` with a timeout; concurrent connects share one.
3. **Client:** every runtime command has a deadline (`COMMAND_TIMEOUT_MS`);
   a command with no reply answers `timeout`, and a late reply is dropped.
4. **Browser watchdog:** a provider the runtime keeps reporting as
   `connecting` for 30 s is shown as `timeout` with Retry.

`connecting` and `authenticating` are the only transient phases, and each
exists only while a bounded request is in flight.

### Authenticated is not session-ready

A provider appears ready for the Command Centre only when it is signed in
**and** a session can be started: the catalogue's `sessions` allows it and
the runtime's adapter declares `create_session` (`sessionAvailability`). An
agent that is reached and signed in but fails either is
`sessions_unavailable` — label "Signed in · sessions unavailable", a warning
dot, the catalogue's reason on its Settings row and under its (disabled) New
session row, and `describeReadiness` reports `authenticated: true`,
`canCreateSession: false` and `sessionsUnavailableReason`. This holds even
for an old roster approval. Verified per provider (2026-09-29):

| Provider | Session-ready when signed in? |
| --- | --- |
| Claude Code | Yes — with an API key (web) or Console sign-in (desktop); a subscription sign-in is `auth_unsupported` |
| Gemini CLI | Yes (asking mode `default`, with workspace context) |
| Grok Build | Yes (asking modes `ask`/`default`), **without** workspace context; no live turn has ever been run |
| Codex | **No** — `sessions_unavailable` |
| Custom MCP agent | n/a — reads Hubble over MCP; no sessions |

## 5. Observable status (no secrets)

`describeReadiness(facts)` answers, per agent: installed? reachable?
authenticated? which method is in use (only when the runtime said)? does it
support subscription/account sign-in here? does it need setup? has its sign-in
expired? can Hubble start a session? does the runtime declare what Hubble
needs? Every field is a boolean, a phase or a catalogue entry.

The runtime protocol gained two closed fields on `RuntimeProviderStatus`:
`authKind` (`subscription | account | api_key | cloud_provider`) and
`authIssue` (`method_not_permitted`). Neither can carry an account, token or
key; tests assert that an account the CLI printed never appears in a reply.

## 6. Starting a session

`sessionPrerequisite` refuses only what is **proven** missing — not installed,
runtime unavailable, signed out, sign-in failed/expired/not permitted, not
answering, or still being asked — and returns the one action that fixes it.
"Not checked yet", "not reached since a restart" and "could not say" are not
refusals; the runtime re-checks every `create_session`.

- New session says it for the chosen agent — "Claude Code needs you to sign
  in. [Sign in]" — and Sign in opens Connect Agent **in place**.
- The agent, workspace, title and first message are kept and handed back when
  Connect Agent closes; closing New session lets them go.
- Hubble never picks another sign-in for the person, and never uses an API key
  when an account sign-in was chosen: on the desktop no key exists; on the web
  the key is the only method.
- One create at a time (a synchronous in-flight guard), and an approved
  workspace change is applied once even if completing it times out and the
  runtime lists it again.

## 7. Security

| Rule | How |
| --- | --- |
| No scraping, cookies, token extraction or impersonation | Only each vendor's own runtime and documented sign-in; `claude auth status` is the one status read and only closed fields are kept |
| Credentials never reach React | The protocol has no field for one; the API-key form is uncontrolled and posts once to the credential route |
| No credential in URLs, logs, events, MCP or errors | Unchanged guards (`credentials/security.test.ts`, `session-context/secrecy.test.ts`, runtime `security.test.ts`) plus the new isolation tests |
| No provider secret in localStorage | The roster holds identity and consent only (guarded) |
| Credential isolation across providers | ACP agents get an allowlisted environment (no provider's key); the one resolved credential is Claude's, for Claude's process (`launch/credential-isolation.test.ts`) |
| Custom agents cannot bypass the model | `validateAgentDefinition`; no launch entry can exist for `custom` |

## 8. Adding an agent

Conceptually, `registerAgentRuntime({ id, provider, capabilities, detect,
authenticate, getStatus, launch, createSession })` — in this codebase that is:

1. **Verify** the agent's real invocation, its documented sign-in methods, and
   whether its provider permits each in a third-party app. Unverified → leave
   it `unsupported` with the reason.
2. **Catalogue** (`platform/catalog.ts`): a `PlatformProvider` with
   `runtimeName`, `transport`, `auth` (every documented method, with
   `support`), `sessions`, `surfaces`, `features`, `installCommand`.
   `validateAgentDefinition` must return `[]`.
3. **Runtime adapter:** an ACP agent is one `PROVIDER_LAUNCH_TABLE` entry
   (detect, launch, the asking-mode policy); its sign-in and status come
   through the shared ACP adapter (`authenticate`, the `session/new` probe).
   A non-ACP agent implements `AgentControlAdapter` plus the
   `authentication` extension (`describeAuthentication` with `kind`/`issue`,
   `authenticate`) and, if its connect is asynchronous, `connectSettled`.
4. **Icon / identity:** `AgentProviderId` and the agent icon.

Nothing in Settings, the Command Centre, the connect dialog, the session
model or the approval system changes.

## 9. Limitations

- Claude subscription sign-in is not available in Hubble (Anthropic's terms).
- Codex account sign-in is available through its runtime, but Hubble starts no
  Codex sessions until an adapter offers an asking mode.
- API keys for Gemini, Codex and Grok are not supported: Hubble launches those
  agents with no keys in their environment and has no per-user key injection
  for processes it launches.
- Cloud-provider credentials for Claude are recognised on the desktop only if
  configured in Claude Code itself; on the web they are not available.
- The Console `authMethod` string and non-first-party `apiProvider` values were
  not observed live (§3).
