/**
 * The Claude runtime seam.
 *
 * ## Why this interface exists at all
 *
 * The adapter needs to be testable without Claude Code installed, without a
 * developer's personal authentication, and without spending money on every
 * CI run. It also needs to be real in production. Those two requirements are
 * met by putting a narrow interface between them: the adapter drives *this*,
 * and exactly one module implements it against `@anthropic-ai/claude-agent-sdk`.
 *
 * This is deliberately **not** a mock of the SDK. It is the smallest surface
 * the adapter actually needs, defined in TabDump's own vocabulary, so that:
 *
 *   - the SDK's types do not leak through the codebase — only
 *     `sdk-runtime.ts` imports them;
 *   - a deterministic test runtime is a real implementation of a real
 *     contract, not a `vi.mock` of somebody else's module, so the lifecycle
 *     behaviour it exercises is behaviour the production path also has;
 *   - replacing the SDK later is one file.
 *
 * ## What it deliberately does not expose
 *
 * No `spawn`, no `exec`, no argv, no shell, no command string, no arbitrary
 * option bag. A caller names an operation and supplies already-validated
 * scope. There is no field here into which a caller could put a flag of its
 * own choosing, which is what stops the control plane from becoming a
 * general-purpose process launcher with extra steps.
 */

/**
 * The Claude permission modes TabDump is willing to send.
 *
 * Claude Code has five. This union has two, and the three omissions are the
 * design:
 *
 *   - **`bypassPermissions`** skips Claude's checks entirely. Obviously not.
 *   - **`acceptEdits`** auto-accepts file edit operations — which means the
 *     host's `canUseTool` is *never called* for them. Sending it would
 *     silently suppress the approvals this whole integration exists to
 *     produce: TabDump would show no prompt and Claude would write the file.
 *     It is the most dangerous of the three precisely because it looks
 *     harmless.
 *   - **`plan`** stops tool execution and makes Claude produce a plan instead.
 *     A real mode, but a different *product* — someone who granted read
 *     access expects answers about their project, not a plan document.
 *
 * What remains keeps the approval surface live:
 *
 *   - `default` — prompts for dangerous operations, so `canUseTool` fires and
 *     TabDump decides.
 *   - `dontAsk` — denies anything not pre-approved, without prompting. Right
 *     for a grant that permits nothing.
 *
 * A value the union does not contain cannot be sent by accident, which is why
 * this is a type rather than a comment.
 */
export type ClaudePermissionMode = "default" | "dontAsk";

export const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  "default",
  "dontAsk",
] as const;

/**
 * One permission request, as it leaves the provider.
 *
 * Every field is populated from what the runtime actually supplied. Nothing
 * here is synthesised: a provider that gives no `title` leaves it absent, and
 * the approval that results says nothing rather than inventing a sentence.
 */
export type ClaudePermissionRequest = {
  /** The tool the agent wants to use, e.g. "Edit", "Bash". */
  toolName: string;
  /** The provider's unique id for this specific tool call. */
  toolUseId: string;
  /** The control-request envelope id, echoed on the response. */
  requestId: string;
  /**
   * An identity for this request that outlives the process observing it.
   *
   * ## Why a runtime would supply one
   *
   * A local runtime need not: the adapter that mints an approval id is the
   * same object, in the same process, that will later be asked to resolve it,
   * so a random id held in a map is enough.
   *
   * A *remote* runtime has no such luxury. The agent blocks inside a microVM
   * while the request that observed it ends; the user answers minutes later,
   * on a different serverless instance, whose adapter has never heard of the
   * approval. Reconstructing it means re-reading the provider's own pending
   * request and arriving at the *same* approval id both times — which is only
   * possible if the id comes from the provider rather than from a counter.
   *
   * Absent means "mint one", which is what the local path does and what every
   * caller written before this field did.
   */
  stableId?: string;
  /**
   * The provider's own rendered prompt sentence, when it gives one.
   *
   * Preferred over anything TabDump could reconstruct from the tool name and
   * input, because the provider knows what its own tool is about to do.
   */
  title?: string;
  /** Short noun phrase for the action, for a compact label. */
  displayName?: string;
  /** The provider's subtitle, elaborating what access is being asked for. */
  description?: string;
  /** Why the request was triggered. */
  decisionReason?: string;
  /** The path that triggered the request, when one did. Absolute as the provider gives it. */
  blockedPath?: string;
  /**
   * Structured input to the tool.
   *
   * Carried *only* so the adapter can extract file paths for the approval's
   * targets. It is never stored, never forwarded to an event, and never
   * rendered — see the note on `ControlToolInfo` in ../../events.ts about why
   * a command string has nowhere to live in this system.
   */
  input: Readonly<Record<string, unknown>>;
  /** Fires if the run is interrupted while the decision is outstanding. */
  signal: AbortSignal;
};

/** The only two answers. A runtime that gets neither keeps waiting. */
export type ClaudePermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export type ClaudePermissionHandler = (
  request: ClaudePermissionRequest
) => Promise<ClaudePermissionDecision>;

/**
 * A provider message, structurally.
 *
 * Typed as `unknown` payload on purpose: the adapter's normalizer inspects it
 * defensively (see ./normalize.ts) rather than trusting a shape. The SDK's
 * message union has ~40 members and grows; a normalizer that destructured it
 * confidently would break on a version bump, and a normalizer that ignores
 * what it does not recognise will not.
 */
export type ClaudeRuntimeMessage = Readonly<Record<string, unknown>>;

export type ClaudeRuntimeStartOptions = {
  /** TabDump's session id. Used for correlation only; never sent to the provider as its own id. */
  sessionId: string;
  /**
   * The authorized project's id, when the session has one.
   *
   * No more provider-shaped than `cwd` and `additionalDirectories`, which
   * already travel here from the same project record. A local runtime ignores
   * it — it has the directory, which is the only thing it needs. A remote one
   * cannot: its "directory" is a workspace inside a microVM that has to be
   * looked up by id and re-checked against the caller's ownership before
   * anything is dispatched into it.
   */
  projectId?: string;
  /**
   * The working directory, already validated against an authorized project.
   *
   * Absent means no project scope, in which case the runtime is started with
   * no directory access at all rather than inheriting the server's cwd —
   * which would silently authorize wherever TabDump happens to be running.
   */
  cwd?: string;
  /** Further authorized directories, each already validated the same way. */
  additionalDirectories: readonly string[];
  /** Claude's permission mode, derived from the TabDump grant. See ./permissions.ts. */
  permissionMode: ClaudePermissionMode;
  /** Tools the grant allows. An empty list means none. */
  allowedTools: readonly string[];
  /** Tools the grant explicitly forbids, belt-and-braces against a mode that would allow them. */
  disallowedTools: readonly string[];
  /** The provider's session id to reattach to, when resuming. */
  resume?: string;
  /**
   * TabDump's own MCP server for this session (Phase J.3), when it has
   * workspace context. The only MCP server a session can have.
   */
  contextServer?: { name: string; url: string; token: string };
  /** Receives every provider message, in order. */
  onMessage: (message: ClaudeRuntimeMessage) => void;
  /** Called when the provider asks permission. Must resolve, or the run stays blocked. */
  onPermissionRequest: ClaudePermissionHandler;
  /** Called exactly once, when the run ends for any reason. */
  onExit: (error?: ClaudeRuntimeError) => void;
};

export type ClaudeRuntimeErrorCode =
  | "not-installed"
  | "authentication"
  | "unavailable"
  | "process-failed"
  | "timeout"
  | "malformed"
  | "unknown";

/**
 * A runtime failure, already reduced.
 *
 * `detail` is for diagnosis and is never the user-facing string — the adapter
 * maps `code` onto a `ControlError` from the fixed table in ../../types.ts.
 * Keeping the raw text here rather than discarding it is what lets a
 * developer debug without a provider getting to choose what a user reads.
 */
export type ClaudeRuntimeError = {
  code: ClaudeRuntimeErrorCode;
  detail?: string;
};

/** A live run. Returned by `start`, and the only handle on it. */
export type ClaudeRuntimeHandle = {
  /**
   * Sends another user turn into the same conversation.
   *
   * Rejects if the run has ended. This is what makes a session multi-turn:
   * one provider process for the whole conversation, rather than a fresh one
   * per message that would lose all context.
   */
  send(text: string): Promise<void>;
  /**
   * Interrupts the in-flight turn.
   *
   * Reaches the provider. A local flag that merely stopped TabDump listening
   * would leave the agent running and still editing files, which is the
   * failure this method exists to prevent.
   */
  interrupt(): Promise<void>;
  /** Ends the run and releases the process. Idempotent, and safe after an exit. */
  dispose(): Promise<void>;
  /** Whether the run is still live. */
  isActive(): boolean;
  /**
   * Collects whatever the provider has produced, for a runtime that does not
   * push.
   *
   * Optional, and absent on every local runtime: a child process's output
   * arrives through `onMessage` as it is produced, so there is nothing to
   * collect. A *remote* runtime has no socket that survives the request which
   * created it, so it is asked instead — and it replays through the very same
   * `onMessage` and `onPermissionRequest` callbacks, which is what keeps the
   * two paths indistinguishable to everything downstream.
   */
  drain?(): Promise<void>;
};

export type ClaudeRuntimeStartResult =
  | { ok: true; handle: ClaudeRuntimeHandle }
  | { ok: false; error: ClaudeRuntimeError };

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

/**
 * Where a runtime gets the credential it runs under.
 *
 * ## Why this is a function and not a field
 *
 * A credential must not be constructed with the runtime and held for the
 * life of the process. It is fetched at the moment a run starts, used, and
 * dropped — so a runtime that has been sitting idle for an hour is a runtime
 * holding nothing worth stealing, and a connection the user revoked in the
 * meantime stops working on the next start rather than at the next restart.
 *
 * ## Why it is bound to an actor rather than taking one
 *
 * The source handed to a runtime is already closed over one actor: it is
 * built in `runtime/server.ts`, per actor, from the authenticated session.
 * There is no argument a caller could pass that would make it resolve
 * somebody else's, which is what makes §13's "User A must never start a
 * session using User B's credential" structural rather than checked.
 *
 * ## What a runtime may do with the result
 *
 * Put `credential.env` into the environment of the provider process. That is
 * all. Not a command-line argument, not a file, not a prompt, not an event
 * payload, not a log line. `security.test.ts` asserts each of those.
 */
export type ClaudeCredentialSource = () => Promise<ClaudeCredentialResolution>;

/**
 * The resolution, restated in the seam's own vocabulary.
 *
 * Deliberately not an import of the credential layer's `CredentialResolution`:
 * this module is the provider seam and is imported by the browser-testable
 * adapter, and dragging a `server-only` domain's types across it would make
 * the seam depend on the thing it exists to be independent of. The shapes
 * agree structurally, and `runtime/server.ts` is the one place that adapts.
 */
export type ClaudeCredentialResolution =
  | { ok: true; connectionId: string; env: Readonly<Record<string, string>> }
  | { ok: false; reason: "not_connected" | "not_usable" | "unavailable" };

/**
 * Whether a runtime can run, in three separate facts rather than a boolean.
 *
 * `isAvailable()` collapses "the SDK is not installed" and "you have not
 * connected a credential" into one `false`, and those need different
 * sentences: one is a machine problem the user cannot fix and the other is a
 * button they should press. So a runtime that can tell them apart implements
 * `describeAvailability`, and the adapter prefers it when present.
 *
 * Optional rather than required, because `isAvailable` is what every existing
 * implementation and every test fixture already has, and widening a seam that
 * three runtimes implement is how a phase turns into a refactor.
 */
export type ClaudeRuntimeAvailability =
  /** Ready. The SDK or sandbox is reachable and a credential resolved. */
  | { kind: "available" }
  /** Everything works except that this user has no usable provider connection. */
  | { kind: "credential-required"; reason: "not_connected" | "not_usable" | "unavailable" }
  /** The runtime itself cannot run here — no SDK, no sandbox, wrong machine. */
  | { kind: "unavailable" };

export type ClaudeRuntime = {
  /**
   * Whether this environment can run Claude Code at all.
   *
   * Distinct from the control plane's runtime boundary (../../runtime.ts),
   * which asks whether this *deployment* is permitted to execute agents. Both
   * must say yes, and the boundary is checked first — a hosted deployment
   * must never get as far as asking whether a binary exists.
   */
  isAvailable(): Promise<boolean>;
  /**
   * The same question, answered in three states instead of two.
   *
   * See `ClaudeRuntimeAvailability`. A runtime that does not implement it is
   * read through `isAvailable`, which is exactly the behaviour every caller
   * had before this existed.
   */
  describeAvailability?(): Promise<ClaudeRuntimeAvailability>;
  start(options: ClaudeRuntimeStartOptions): Promise<ClaudeRuntimeStartResult>;
  /**
   * Picks up a run this process did not start.
   *
   * ## Why only some runtimes have this
   *
   * A local runtime must not. Its agent is a child process, so a process that
   * is no longer here has no agent still working — and a `reattach` that
   * quietly started a fresh one would be the worst kind of lie this system
   * could tell: the user would believe the conversation continued.
   *
   * A remote runtime can, truthfully. Its agent is inside a microVM that has
   * been running the whole time; what was lost is this deployment's handle on
   * it, and both halves of that handle — which sandbox, which process — are
   * durable. Reattaching rebuilds the handle and starts nothing.
   *
   * Resolves to `null` when the session cannot be reached: not this caller's,
   * sandbox gone, or the agent process exited. Each of those is a session that
   * cannot be driven, and saying so is better than starting a second agent
   * over the top of the first.
   */
  reattach?(options: ClaudeRuntimeStartOptions): Promise<ClaudeRuntimeHandle | null>;
};
