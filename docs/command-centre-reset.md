# The Command Centre Reset

TabDump is becoming an **AI agent command centre**: connect your agents, give
them TabDump workspace context and an explicitly authorized local project, ask
them to work, watch what they do, approve what needs approving, and come back
to the session later.

That is a different product from the one phases 11–18 built. This document
records what changed, what was kept, and — most importantly — the one
invariant that is being deliberately reversed, so that nobody later reads the
old rule in a comment and assumes it still holds.

---

## 1. The invariant being reversed

Phases 11–18 were built on a single rule, stated at the top of
`src/lib/agents/adapter.ts`:

> TabDump observes agents, it does not drive them.

It was not a convention. It is enforced by structural tests that read the
source and fail the build:

| Guard | Rule |
| --- | --- |
| `lib/agents/security.test.ts` | `AgentAdapter` declares no `start`/`stop`/`cancel`/`exec`/`prompt`/`sendMessage`/`write` |
| `lib/agents/connectors/security.test.ts` | no connector member acts on an external agent; an observation has no field that could carry a command |
| `lib/agents/claude-code/security.test.ts` | no `child_process`, no exec call-shape, no write operation, no pipe/socket/IPC; `messagingSocketPath` appears only in prose |
| `lib/platform/no-tauri-in-web.test.ts` | exactly one shipped module may reach `@tauri-apps`, via dynamic import |

`claude-code/reader.ts` goes further: it *strips* `messagingSocketPath`, `pid`
and `procStart` off Claude Code's session registry, at a documented choke
point, precisely so no later code can reach the control channel by accident.

The command centre needs that control channel. The reversal is intentional and
it is the single largest risk in this work, so it is being made explicitly
rather than by attrition:

- **The observation path stays read-only.** `reader.ts`, `parser.ts`,
  `normalizer.ts`, the connector layer and the domain do not gain a verb.
  Their guards stay exactly as they are.
- **Control is a new, separate module** with its own guards — an allowlisted
  binary, no shell, no argv assembled from user text, and no path that is not
  an explicitly connected project root.
- **Execution is local-only and fails closed.** An agent process is spawned
  only when the server is provably the user's own machine. A hosted
  deployment must refuse, because spawning an agent there would run it
  against the deployer's filesystem on behalf of any visitor.

The old rule is not wrong, and it is not being softened. It is being replaced
by a narrower one: *nothing on the observation path may act; the one thing
that may act does only what the user explicitly authorized, and can prove it.*

**Phase B built exactly this.** The observation guards were kept byte for
byte; the control plane is a sibling directory with its own contract, its own
capability model, its own permission and approval layers, and its own guard
suite. See [agent-control-architecture.md](agent-control-architecture.md).

---

## 2. What the packaged desktop app can and cannot do

`next.config.ts` sets `pageExtensions: ["tsx"]` for the desktop build, which
drops every `route.ts` from the route tree; Tauri then ships a static export
with no server. `src-tauri/capabilities/default.json` grants only
`core:default` — no shell, fs, process or http plugin.

So the packaged desktop app **cannot run an agent today**, and will not be
able to until Rust commands and a capability are added for it. Real agent
execution currently means `npm run dev` or a self-hosted Node server on the
user's own machine. Anything that claims otherwise in the UI would be a
fake integration.

---

## 3. Phase A — Agent World removal (done)

The world/city/character metaphor is gone. Not flagged off, not hidden by
CSS — removed.

**Deleted** (~12,000 lines):

```
src/lib/agents/world/**              themes, rooms, isometric projection,
                                     camera, layout, scenery, handoffs, roster
src/lib/agents/visual/animation.ts   the per-state motion engine
src/components/agents/agent-world*   the world views, stage, scenery, detail cards
src/components/agents/agent-character.tsx
src/hooks/use-agent-world.ts, use-agent-motion.ts
src/components/settings/sections/agent-world-section.tsx
docs/phase-18-*.md
```

plus the world's storage key, its sidebar row, its Settings section, its
command-palette entry, the panel it rendered over the graph, and ~560 lines of
keyframes and isometric CSS in `globals.css`.

**Kept, because none of it was ever about the world:**

- the whole agent domain — `Agent`, `AgentRun`, `AgentEvent`, `AgentRunLink`,
  `AgentWorkItem`, `WorkArtifact`, persistence, selectors;
- the connector layer — registry, manager, catalog, base, health, usage;
- the Claude Code pipeline — reader → parser → normalizer → cursor → mapping;
- `intelligence/`, `session/`, `history/`;
- `spatial/` and the graph's agent layer. This is the workspace↔agent link
  that makes TabDump different from a chat window, and it lives on the
  relationship graph, which is core product. The world was built *on top of*
  spatial, not the other way round;
- `visual/` minus the sprite layer — `states.ts`, `types.ts`,
  `app-identities.ts`, `registry.ts`, `catalog.ts` and `marks.tsx` are
  provider identity (name, accent, a 24×24 geometric glyph), which the
  command centre needs.

**Consequences worth knowing about:**

- `AgentIcon` no longer animates in any state.
  `agent-icon.test.tsx` asserts this across the whole state union, so a
  keyframe cannot be reintroduced by accident.
- `AgentVisualIdentity` lost its `animations` and `character` fields. An
  identity is now a mark plus an accent, both required.
- The graph sidebar's "now" list is derived from the spatial scene via
  `visualStateForRun` instead of from world characters. It is never given
  `isHandingOff`: handoffs were a world derivation, and inventing one from a
  run pair would be a claim the domain has not made.
- `tabdump:agent-world:v1` is **retired, not merely dropped**. Removing a
  local-first feature's key from `SCOPED_STORAGE_KEYS` would strand it in
  every existing user's localStorage — under the global prefix and under one
  namespaced key per account — with nothing left that could read or clear it.
  `lib/storage/retired.ts` sweeps it on startup, matching only the listed keys
  in their two legal spellings. See its own tests for the blast-radius cases.

---

## 4. Phase sequence

| | | |
| --- | --- | --- |
| A | Agent World removal | done |
| B | Provider-neutral agent control foundation — see [agent-control-architecture.md](agent-control-architecture.md) | done |
| C | Real Claude Code connection | |
| D | Codex connection | |
| E | Local project connection + permission model | |
| F | Workspace → agent context bridge | |
| G | Unified event stream + session persistence | |
| H | Command Centre shell | |
| I | Conversation / activity / approval UI | |
| J | Right-side context panel | |
| K | Command palette + keyboard system | |
| L | Full TabDump visual redesign | |
| M | Cross-provider polish | |
| N | Test / QA pass | |

### Notes for Phase C

Claude Code on the development machine is **2.1.229**. The mechanisms the
command centre needs all exist in that version:

```
-p --output-format stream-json --include-partial-messages
--input-format stream-json          multi-turn over one process
--resume <id> / --session-id <uuid> / --fork-session
--add-dir                           additional authorized directories
--permission-mode <manual|acceptEdits|plan|…>
--allowedTools / --disallowedTools / --tools
--mcp-config / --strict-mcp-config
--max-budget-usd
```

There is **no `--permission-prompt-tool` flag on the CLI in this version**.
Intercepting a tool call in order to show "Claude wants to modify 4 files"
therefore requires `@anthropic-ai/claude-agent-sdk` and its `canUseTool`
callback. Without it, an Approve/Deny control would not be connected to
anything — which is the one thing this product must not ship.

### Notes for Phase D

Codex is not installed on the development machine. Following the standard
`connectors/catalog.ts` already sets: build the adapter against fixtures, and
leave the connector honestly reporting `unavailable` until it can be verified
against a real installation. A provider that reports confident nonsense is
worse than one that says it cannot see anything.
