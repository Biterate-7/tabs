# Credential audit — before Phase I.2

Every path in the repository that handles something secret, classified as the
brief asks: **A** operator/infrastructure credential, **B** user-owned provider
credential, **C** test fixture, **D** unsafe or obsolete.

Produced by sweeping `ANTHROPIC_API_KEY`, `anthropic`, `credential`, `apiKey`,
`api_key`, `secret`, `token` across `src/`, `scripts/` and `docs/`.

## A — operator / infrastructure

| Path | What it is |
| --- | --- |
| `src/lib/auth/store/postgres.ts` | `POSTGRES_URL` / `DATABASE_URL`. Never leaves the server; `describeConnectionEnv` names the variables, never the values. |
| `src/lib/auth/config.ts`, `google.ts` | Google OAuth client id/secret for sign-in. Server-side only; `public-config.ts` exposes the client id alone. |
| `src/lib/auth/tokens.ts` | Session tokens. Raw token to an `HttpOnly` cookie, SHA-256 to the row. |
| `src/lib/agents/remote/sandbox-vercel.ts` | `VERCEL_OIDC_TOKEN` / `VERCEL_TOKEN` trio. Platform credential, correctly an operator concern. |
| `src/lib/ai/config.ts` | `GEMINI_API_KEY` for the pre-existing public AI routes. Unrelated to the agent control plane. |

These stay. None of them is a per-user provider credential and none is touched
by this phase.

## B — user-owned provider credential

**Before this phase: none.** That is the finding.

`src/lib/agents/control/providers/claude-code/remote-runtime.ts` reads
`ANTHROPIC_API_KEY` from `process.env` for *every* user's remote session:

```ts
export const PROVIDER_CREDENTIAL_ENV_VAR = "ANTHROPIC_API_KEY";
env: { [PROVIDER_CREDENTIAL_ENV_VAR]: env[PROVIDER_CREDENTIAL_ENV_VAR] ?? "" }
```

`docs/agent-remote-runtime.md` §5 states the consequence plainly — "the
deployment's owner pays for every user's agent runs" — and names itself as the
wrong model for a multi-tenant product. This is the exact shape the phase
forbids:

```
ALL USERS → TABDUMP'S SHARED AI CREDENTIAL → AGENTS
```

The local plane (`sdk-runtime.ts`) has no credential read at all: it inherits
whatever Claude Code login exists on the machine, ambiently and invisibly.

**Reclassified to D and replaced.**

## C — test fixtures

| Path | What it is |
| --- | --- |
| `src/components/command-centre/remote-end-to-end.test.tsx` | `SANDBOX_ENV = { ANTHROPIC_API_KEY: "sk-ant-e2e" }` |
| `.../claude-code/security.test.ts`, `runtime/security.test.ts` | Assert the variable name never reaches an event, a log or a row. |
| `.../claude-code/__fixtures__/scripted-runtime.ts` | `apiKeySource: "none"` in a canned provider message. |

Kept. The leakage assertions get stronger, not weaker.

## D — unsafe or obsolete

### D1. The operator key on the user session path

`PROVIDER_CREDENTIAL_ENV_VAR` as described above. **Removed from every user
execution path** by this phase. The constant survives only as the name of the
environment variable the *user's own* key is injected under inside a sandbox —
it is no longer read from `process.env` by anything that starts a session.

### D2. `src/lib/agents/connectors/session-credentials.ts`

A browser-side, module-scoped, per-tab secret map for **observation**
connectors. Honest about what it is (its own header says TabDump "does not
persist secrets" and labels a connector *configured for this session*), but it
is a browser store and therefore can never hold a control-plane credential.

**Left exactly as it is, and firewalled.** It is observation-only, no control
path reads it, and this phase adds a test asserting the provider-connection
service never touches it. A credential that can drive an agent does not live in
a browser.

## The gap this phase closes

```
actor → provider connection → encrypted secret → runtime → provider
```

Nothing in the repository implemented any link of that chain. Everything below
`runtime` existed; everything above it did not.
