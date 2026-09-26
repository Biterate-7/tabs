# Phase J.1 — Agents in the packaged desktop app

The packaged Hubble app is a static webview with no server, so until this
phase it had no way to run an agent: every Phase J capability lived behind the
Next route `/api/agents/control`. Phase J.1 gives the desktop app the same
runtime, unchanged, through the smallest bridge that keeps every boundary.

```
 Command Centre (webview)
   RuntimeClient ── post transport (lib/platform/desktop.ts, the only Tauri import)
        │  invoke("agent_runtime", request)        invoke("agent_pick_project_folder")
        ▼                                                    │
 Tauri shell (src-tauri/src/agent_runtime.rs)                ▼
   screen_request: size cap, JSON, and every           native folder dialog →
   authorize_projects path ∈ picked folders            picked-folder registry
        │  one JSON line on stdin / one on stdout — no port
        ▼
 Sidecar: tabdump-agent-node + agent-runtime/runtime.mjs   (Windows job object:
   createDesktopRuntime → the Phase J RuntimeHost            killed with the app)
     ├── Claude Code  — Agent SDK → the user's installed claude.exe, own login
     └── Gemini · Codex · Grok — the one ACP adapter, launch allowlist
```

## Why a sidecar and not a Rust port

The runtime — host, control service, approval broker, Claude SDK adapter, ACP
adapter, launch allowlist, context bridge — is TypeScript and is the product's
security model. Re-implementing it in Rust would create a second, drifting
copy of exactly the code whose correctness matters most. The sidecar runs the
same code the web runs, bundled into one file (`npm run desktop:runtime`,
rolldown) and executed by a Node binary Hubble ships (`externalBin`).

## What each layer enforces

| Requirement | Where |
| --- | --- |
| No shell execution | Rust spawns one fixed binary with one fixed script; the sidecar's launch layer uses `shell: false` with literal argv. Claude's sign-in runs `claude auth login --claudeai` / `--console` from the allowlist table — the caller names an operation, never arguments. |
| Fixed allowlist / argv | `launch/allowlist.ts` (+ `native` entry for Claude's own CLI), pinned by `launch/security.test.ts`. |
| Stripped environment | Rust: `env_clear()` + `SIDECAR_ENV_ALLOWLIST`; sidecar: `agentEnvironment` again per agent. No key, token, `NODE_OPTIONS` or Hubble secret passes. |
| No raw credentials stored | Claude uses its **own** login (`claude auth login` opens Anthropic's page in the browser). Hubble only asks `claude auth status --json` and reads the one `loggedIn` boolean. |
| Per-action approval | Unchanged: `canUseTool` (Claude) / `session/request_permission` (ACP) → broker → Command Centre. |
| Workspace boundaries | Unchanged context bridge; sessions carry `workspaceId`. A new folder grants only the scopes the agent was approved for. |
| No arbitrary UI paths | `authorize_projects` is refused by Rust unless every path was picked in the native dialog (`FolderRegistry`, persisted in the app data dir). The dialog's path field is read-only on desktop. |
| Process cleanup | Stdin close / shutdown line → `runtime.dispose()` ends sessions; `RunEvent::Exit` asks, then kills after 3 s; the job object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) kills the whole tree on any exit, including a crash. |
| Web can't reach it | The desktop gate (`allowDesktopExecution`) is called only by `runtime/desktop.ts`, imported only by `src/desktop-runtime/main.ts`; nothing under `src/app` imports either. |

## MCP context

Hubble's MCP server reads the **synced account store** (Postgres). The desktop
app has neither the server nor the store, so the per-session MCP link is not
offered there. Desktop sessions receive their Hubble context through the
attached-context bridge (the `<tabdump-context>` block, resolved by the Phase E
resolver in the webview and revalidated by the host) — the same context, in the
user turn. This is the "where supported" case in the brief, stated plainly.

## Streaming

The desktop client polls `get_events` exactly as the web does (1 s while a run
is live). ACP agents stream `message_delta` pieces; Claude over the SDK delivers
each reply whole.

## Build

```bash
npm run desktop:build    # = desktop:runtime (sidecar + node) → desktop:export → cargo → NSIS/MSI
```

`src-tauri/agent-runtime/` and `src-tauri/binaries/` are generated and ignored.
The bundle grows by the Node binary (~88 MB uncompressed).
