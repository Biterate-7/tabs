# Hubble 1.5 — Context Intelligence

Hubble's loop is **Workspace → Context → Agent → Action → Workspace**. 1.5 makes
the *Context* step explicit, visible, selectable, reusable and inspectable,
without changing how agents run, ask, or are undone.

## 1. Audit (before any code)

| Area | What existed | Source of truth |
| --- | --- | --- |
| Workspace, tabs | `Workspace { id, name, tabs, groups, sections, logo }` | `lib/workspace/types.ts`, local store, sync |
| Collections | `Collection { id, workspaceId, name, tabIds }` | `lib/collections`, collection store |
| Workspace metadata | name + logo only — **no description or focus** | — |
| Project files | only as *agent activity*: `file_created` / `file_modified` events with project-relative paths; Hubble cannot list or open project files | `control/events.ts`, `activity/timeline.ts` |
| Recent activity | `AppliedWorkspaceChange` records (memory, per page) + durable history | `command-centre/workspace-activity.ts`, `activity/history*` |
| Session context (J.3) | a bounded `SessionContextSnapshot` of the session's one workspace, queried by the agent through Hubble's MCP server | `session-context/*` |
| Context picker | `WorkingContext` (workspace id + tab ids + collection ids) → scope *Whole workspace / One tab / Selected tabs / Collection / Custom* | `command-centre/working-context.ts`, `context-picker.tsx` |
| Runtime envelope | `attach_context` → Phase E resolver (`resolveContext`: sanitize, redact URLs, limits, owner/scope checks) → flat attachments → rendered into the user turn by the adapter; host records the focus and delivers it with the next message | `context/*`, `control/context.ts`, `runtime/host.ts` |
| Handoff envelope | counts + previous-result lines + scrubbed instruction, fingerprinted preview | `handoff/*` |
| Activity / Inspector / History | pure builders over journal + approvals + changes; history is a Postgres copy of those records | `activity/*` |
| Landing demo | the app's own components and hooks on a deterministic reducer | `marketing/demo/*` |

**Already sent to agents:** the whole workspace on request through MCP; for a
narrower context, the selected tabs/collections/relationships as attachments;
on handoff, counts, result lines and the instruction.

**Persisted:** workspaces/collections (local + sync), the journal, approvals,
applied changes and handoffs (agent history, when Postgres is configured).

**UI state only:** the selection before it is attached, the draft context of
a new session, applied-change records on this page.

**Missing for a Context Pack:** a workspace description/focus; one object
that says *exactly* what an agent receives; a way to tell that the context
changed after it was sent; a record of which context an action ran under;
names (not just counts) in a handoff.

## 2. Workspace Brief

`Workspace.brief?: { description?, focus?, updatedAt }` — two optional,
user-written lines (`lib/workspace/brief.ts`). Never generated.

- One line each, bounded (280 / 160), control characters stripped, and
  credential shapes redacted **before it is stored** (`lib/secret-shapes.ts`,
  shared with the handoff instruction).
- Stored on the workspace in the local store; the persistence repair pass
  re-reads it. Sync carries workspaces field-by-field and preserves unknown
  fields on pull and conflict, so the brief survives a sync on this device but
  **does not travel to another device yet** (no schema change in 1.5).
- `describeWorkspaceBrief` adds what Hubble can count: tabs, collections,
  recent agent changes, and the three largest collections — deterministically.
- It reaches agents two ways: the session's MCP snapshot (`get_workspace_summary`
  now returns `workspace.description` / `workspace.focus`), and the Context Pack.

## 3. Context Pack

`lib/agents/context-pack/pack.ts` — **the only constructor** is
`buildContextPack`.

```ts
type ContextPack = {
  version: 1
  workspace: { id, name, description?, focus?, tabs, collections }
  scope: "workspace" | "resource" | "selection" | "collection" | "custom"
  collections: { id, name, tabs }[]
  tabs: { id, title, domain?, url? }[]          // url redacted
  relationships: { id, label }[]                 // between selected tabs
  files: { path, change: "created" | "updated" }[] // project-relative
  recentChanges: { id, text, at }[]              // newest first, ≤ 5
  previousResult?: HandoffPreviousResult
  instruction?: string                           // scrubbed, bounded
  omitted: { missing, duplicates, truncated }
  fingerprint: string                            // 16 hex, excludes instruction
}
```

Built from what exists, not beside it: the selection is `WorkingContext`,
stale ids are dropped by `withinWorkspace`, tabs/collections/relationships are
resolved by the **Phase E resolver** (same sanitizing, URL redaction, limits
and scope checks), the previous result and instruction reader are the
handoff's. Every string then passes the shared credential scrubber.

- **Deterministic:** no clock or randomness; locale-independent sort; same
  input → same pack and fingerprint (tested with shuffled worlds).
- **Duplicates:** one tab per redacted address, counted in `omitted`.
- **Safe:** no field for credentials, headers, cookies, tokens, runtime
  addresses, protocol payloads, transcripts or reasoning; notes are never
  requested; `security.test.ts` feeds a hostile workspace and checks the pack,
  its attachments, the handoff envelope and provenance.
- **Id:** `pack-<fingerprint>` — used as the attached context's snapshot id,
  so the runtime reports back which pack a session holds.

## 4. Context Inspector

`components/agents/context-pack-inspector.tsx` renders `contextPackRows` —
Workspace, Focus, Context, Collections, Tabs, Files, Recent changes, Previous
result, Instruction — as label/value rows in the context panel's vocabulary,
plus where it stands: *reads on request*, *sent with your next message*,
*has this*, *changed since it received it* (with **Send update**), or *as it
was when the session ran*. Empty sections say "None"; omissions are said in a
sentence. It appears in the context panel and the context-chip popover (the
narrow-width path), and its line format in the handoff dialog.

## 5. Context selection

Reuses the existing selection model and picker unchanged: **whole workspace**,
**collection**, **selected tabs**, or a mix. **Files** come from the existing
project-file integration — the files a previous result created or edited, as
the activity timeline recorded them; there is deliberately no file browser.
**Previous result** is the handoff's structured result, where a session was
started by one.

## 6. Runtime integration

No new execution path. `applyContext` and session start now build the pack
(`sessionContextPack`) and send its projection (`contextPackAttachedContext`)
through the unchanged `attach_context` / `create_session` gates — the host
still checks every reference against the session's workspace. When a pack has
nothing to attach (whole workspace, no brief, no changes) the session is
detached exactly as before.

The host records what each message delivered: a Hubble-only `delivery` slice
(counts + collection ids, never content) on the `message_sent` that carried
attached context — including context a session was started with, which is now
reported as owed (`contextDelivered: false`) until its first message. Adapters
cannot raise it. History keeps it. Approvals, ownership checks, undo and
history persistence are unchanged.

## 7. Handoff integration

The preview now carries whether the brief is passed and the source focus's
collection ids. The host builds the **same canonical pack**
(`handoffContextPack`, from its workspace copy + the source focus + the modes
kept) and sends its resources as the envelope message's attachments; the
envelope names the purpose, current focus, selected collections and the
previous result's files. The target session records the pack as its attached
context. The dialog builds the same pack from the live world to show it. No
transcript or reasoning is passed; the instruction scrubber is unchanged
except that it shares the extended shape list.

## 8. Provenance

`contextProvenanceOf` answers "why did the agent know this?" from the
runtime's own records — the latest `delivery` before the action, the handoff
that started the session, and Hubble-measured workspace reads:

```
Context used
Research workspace · Workspace brief
Pricing Research collection · 5 tabs
Previous result from Gemini CLI · 2 files
Read the workspace 3 times
```

Shown in the Action Inspector for every action, and for a past session in
the history pane. Collection names are looked up live; a deleted one is
counted, not named.

## 9. Landing parity

The demo uses the same hook (`useSessionContextPack`), recipe
(`sessionContextPack`), projection, handoff pack, provenance and components.
Its fixture sessions are seeded by running the product's recipe over the demo
workspaces (a deterministic adapter); Research has a brief the visitor can
edit. `demo-parity.test.tsx` fails if marketing code builds or words a pack
itself.

## Limitations

- The brief is local to the device (sync carries name and logo only).
- "Files" are those agent activity recorded; Hubble still cannot list or open
  a project's files.
- Recent changes are this page's applied-change records (not history from
  other devices).
- A handoff to an agent without Hubble's workspace tools receives the pack's
  resources but cannot read the rest of the workspace.
