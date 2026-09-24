import { capabilitiesFor } from "./capabilities";
import { readSessionContextSnapshot } from "./snapshot";
import type { SessionContextAccess, SessionContextCapability } from "./capabilities";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * Which session may see which workspace, through which credential (Phase J.3).
 *
 * ## One binding per session, fixed at birth
 *
 * A binding ties exactly one agent session to exactly one TabDump workspace,
 * with a capability set chosen when the session starts. None of the three can
 * change afterwards: `update` accepts a fresher snapshot of the *same*
 * workspace and refuses any other, and there is no call that widens
 * capabilities. Switching workspaces in the UI therefore never moves an agent
 * — a new session is the only way to point one somewhere else.
 *
 * ## The credential
 *
 * `bind` mints a 256-bit random token and returns it exactly once, to the
 * runtime code that hands it to the agent. Only its SHA-256 hash is kept, in
 * this process's memory. It is never persisted, never sent to the webview,
 * never written to an event. It stops working the moment the binding is
 * released — on dispose, disconnect, a session ending, or runtime shutdown —
 * and a restarted runtime starts with an empty registry, so no credential
 * minted before the restart can ever authenticate again. Even a session that
 * never ends cannot keep one forever: after `CREDENTIAL_MAX_AGE_MS` it is
 * refused and forgotten, and the agent simply loses its workspace context.
 *
 * ## Actions
 *
 * The one write, `create_collection`, never touches data here. It becomes an
 * action that waits for a TabDump approval (`approve`, supplied by the host,
 * backed by the control service's broker). An approved action waits again,
 * for the Command Centre — which owns the workspace — to apply it and report
 * back. Only then does the agent's tool call return. A denied, expired or
 * abandoned action changes nothing.
 */

export const CONTEXT_TOKEN_PREFIX = "tdctx_";

/**
 * The longest a context credential works, whatever the session does. Long
 * enough for a working day, short enough that one left behind by a session
 * that never ended cleanly does not outlive it by much.
 */
export const CREDENTIAL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** How long an approved action may wait for the Command Centre to apply it. */
export const APPLY_TIMEOUT_MS = 60_000;

export type ApprovalOutcome = "granted" | "denied" | "expired" | "cancelled";

export type ContextApprovalRequest = {
  sessionId: string;
  workspaceId: string;
  actionId: string;
  /** Plain descriptions of the change, for the approval card. */
  targets: readonly string[];
  reason: string;
};

export type ContextApprover = (request: ContextApprovalRequest) => Promise<ApprovalOutcome>;

export type ContextActionStatus =
  | "awaiting_approval"
  | "approved"
  | "applied"
  | "denied"
  | "expired"
  | "failed"
  | "cancelled";

export type CreateCollectionAction = {
  id: string;
  sessionId: string;
  workspaceId: string;
  kind: "create_collection";
  name: string;
  tabIds: readonly string[];
  status: ContextActionStatus;
  requestedAt: number;
  collectionId?: string;
};

export type ContextAction = CreateCollectionAction;

export type CreateCollectionResult =
  | { ok: true; collectionId: string; name: string; tabCount: number }
  | { ok: false; reason: "denied" | "expired" | "invalid" | "ended" | "not_applied" | "not_permitted" };

export type SessionContextBinding = {
  sessionId: string;
  ownerId: string;
  workspaceId: string;
  access: SessionContextAccess;
  capabilities: readonly SessionContextCapability[];
  snapshot: SessionContextSnapshot;
  boundAt: number;
};

export type SessionContextRegistry = {
  /**
   * Binds a session to a workspace and mints its credential. The token is
   * returned here and nowhere else. `undefined` when the snapshot is not of
   * `workspaceId`, or the session is already bound.
   */
  bind(input: {
    sessionId: string;
    ownerId: string;
    workspaceId: string;
    access: SessionContextAccess;
    snapshot: unknown;
  }): Promise<{ token: string } | undefined>;
  /** The binding a credential belongs to, or `undefined` for any token that does not work. */
  authenticate(token: string | undefined): Promise<SessionContextBinding | undefined>;
  binding(sessionId: string): SessionContextBinding | undefined;
  /** A fresher snapshot of the same workspace. Refused for any other workspace. */
  update(sessionId: string, snapshot: unknown): boolean;
  requestCreateCollection(
    sessionId: string,
    input: { name: string; tabIds: readonly string[] }
  ): Promise<CreateCollectionResult>;
  /** Approved actions the Command Centre has yet to apply, oldest first. */
  pendingApplications(sessionId: string): ContextAction[];
  /** The Command Centre applied (or failed to apply) an approved action. */
  complete(sessionId: string, actionId: string, outcome: { ok: true; collectionId: string } | { ok: false }): boolean;
  /** Revokes the credential and abandons the session's actions. Idempotent. */
  release(sessionId: string): void;
  releaseAll(): void;
  /** How many credentials currently work. */
  activeCount(): number;
  /** Connects the registry to the control service that owns approvals. */
  setApprover(approve: ContextApprover): void;
};

export type SessionContextRegistryOptions = {
  /** Who puts a change to the user. Set later with `setApprover` when the host is built after the registry. */
  approve?: ContextApprover;
  now?: () => number;
  /** Seams for tests. Production uses Web Crypto. */
  randomBytes?: (length: number) => Uint8Array;
  createId?: () => string;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}

const MAX_COLLECTION_NAME = 80;
const MAX_COLLECTION_TABS = 200;

export function createSessionContextRegistry(options: SessionContextRegistryOptions): SessionContextRegistry {
  const now = options.now ?? (() => Date.now());
  // No approver means no one can say yes: every change is cancelled.
  let approve: ContextApprover = options.approve ?? (async () => "cancelled");
  const randomBytes =
    options.randomBytes ??
    ((length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
  let counter = 0;
  const createId = options.createId ?? (() => `ctxa-${now().toString(36)}-${(counter++).toString(36)}`);
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const bindings = new Map<string, SessionContextBinding>();
  /** credential hash → session id. The raw token is never kept. */
  const credentials = new Map<string, string>();
  const credentialOf = new Map<string, string>();
  const actions = new Map<string, ContextAction>();
  /** Actions whose tool call is still waiting, with how to answer it. */
  const waiting = new Map<string, { resolve: (result: CreateCollectionResult) => void; timer?: unknown }>();

  function settle(actionId: string, result: CreateCollectionResult, status: ContextActionStatus): void {
    const action = actions.get(actionId);
    if (action) actions.set(actionId, { ...action, status });
    const waiter = waiting.get(actionId);
    if (!waiter) return;
    waiting.delete(actionId);
    if (waiter.timer !== undefined) clearTimer(waiter.timer);
    waiter.resolve(result);
  }

  const api: SessionContextRegistry = {
    async bind(input) {
      if (bindings.has(input.sessionId)) return undefined;
      const snapshot = readSessionContextSnapshot(input.snapshot, input.workspaceId);
      if (!snapshot) return undefined;

      const token = `${CONTEXT_TOKEN_PREFIX}${toBase64Url(randomBytes(32))}`;
      const hash = await sha256(token);
      bindings.set(input.sessionId, {
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        access: input.access,
        capabilities: capabilitiesFor(input.access),
        snapshot,
        boundAt: now(),
      });
      credentials.set(hash, input.sessionId);
      credentialOf.set(input.sessionId, hash);
      return { token };
    },

    async authenticate(token) {
      if (typeof token !== "string" || !token.startsWith(CONTEXT_TOKEN_PREFIX) || token.length > 200) {
        return undefined;
      }
      const hash = await sha256(token);
      const sessionId = credentials.get(hash);
      const binding = sessionId ? bindings.get(sessionId) : undefined;
      if (!binding) return undefined;
      if (now() - binding.boundAt >= CREDENTIAL_MAX_AGE_MS) {
        // Expired: forgotten for good. The binding stays, so the session's
        // view and any pending approval are unaffected; only the agent's
        // access ends.
        credentials.delete(hash);
        return undefined;
      }
      return binding;
    },

    binding: (sessionId) => bindings.get(sessionId),

    update(sessionId, raw) {
      const binding = bindings.get(sessionId);
      if (!binding) return false;
      // The workspace is fixed at bind time. A snapshot of anything else is refused.
      const snapshot = readSessionContextSnapshot(raw, binding.workspaceId);
      if (!snapshot) return false;
      bindings.set(sessionId, { ...binding, snapshot });
      return true;
    },

    async requestCreateCollection(sessionId, input) {
      const binding = bindings.get(sessionId);
      if (!binding) return { ok: false, reason: "ended" };
      if (!binding.capabilities.includes("collections.write")) return { ok: false, reason: "not_permitted" };

      const name = input.name.replace(/\s+/g, " ").trim().slice(0, MAX_COLLECTION_NAME);
      const known = new Set(binding.snapshot.workspace.tabs.map((tab) => tab.id));
      const tabIds = [...new Set(input.tabIds)].filter((tabId) => known.has(tabId)).slice(0, MAX_COLLECTION_TABS);
      // Every id must be a tab of this workspace: a request naming anything
      // else is refused outright rather than quietly trimmed.
      if (!name || tabIds.length === 0 || tabIds.length !== new Set(input.tabIds).size) {
        return { ok: false, reason: "invalid" };
      }

      const action: CreateCollectionAction = {
        id: createId(),
        sessionId,
        workspaceId: binding.workspaceId,
        kind: "create_collection",
        name,
        tabIds,
        status: "awaiting_approval",
        requestedAt: now(),
      };
      actions.set(action.id, action);

      const result = new Promise<CreateCollectionResult>((resolve) => {
        waiting.set(action.id, { resolve });
      });

      const titles = new Map(binding.snapshot.workspace.tabs.map((tab) => [tab.id, tab.title ?? tab.domain]));
      const sample = tabIds.slice(0, 3).map((tabId) => titles.get(tabId) ?? "tab");
      // A tab belongs to at most one collection, so creating this one moves
      // any of these tabs out of the collection holding them. Said up front.
      const chosen = new Set(tabIds);
      const moved = binding.snapshot.collections.filter((collection) =>
        collection.tabIds.some((tabId) => chosen.has(tabId))
      );
      void approve({
          sessionId,
          workspaceId: binding.workspaceId,
          actionId: action.id,
          targets: [
            `New collection "${name}" with ${tabIds.length} ${tabIds.length === 1 ? "tab" : "tabs"}`,
            ...(moved.length > 0
              ? [`Moves tabs out of: ${moved.slice(0, 3).map((collection) => collection.name.slice(0, 60)).join(", ")}${moved.length > 3 ? ", …" : ""}`]
              : []),
            ...sample.map((title) => `Tab: ${title.slice(0, 120)}`),
          ],
          reason: "Create a collection in this workspace.",
        })
        .then((outcome) => {
          const current = actions.get(action.id);
          if (!current || current.status !== "awaiting_approval") return;
          if (outcome === "denied") return settle(action.id, { ok: false, reason: "denied" }, "denied");
          if (outcome === "expired") return settle(action.id, { ok: false, reason: "expired" }, "expired");
          if (outcome === "cancelled") return settle(action.id, { ok: false, reason: "ended" }, "cancelled");
          actions.set(action.id, { ...current, status: "approved" });
          // Approved: now the Command Centre applies it. If nothing does, the
          // agent is told so rather than left waiting forever.
          const waiter = waiting.get(action.id);
          if (waiter) {
            waiter.timer = setTimer(() => settle(action.id, { ok: false, reason: "not_applied" }, "failed"), APPLY_TIMEOUT_MS);
          }
        });

      return result;
    },

    pendingApplications(sessionId) {
      return [...actions.values()]
        .filter((action) => action.sessionId === sessionId && action.status === "approved")
        .sort((a, b) => a.requestedAt - b.requestedAt);
    },

    complete(sessionId, actionId, outcome) {
      const action = actions.get(actionId);
      // Only an action the user approved, of this session, may be completed:
      // the Command Centre cannot make one up, or finish one that was denied.
      if (!action || action.sessionId !== sessionId || action.status !== "approved") return false;
      if (outcome.ok) {
        actions.set(actionId, { ...action, status: "applied", collectionId: outcome.collectionId });
        settle(
          actionId,
          { ok: true, collectionId: outcome.collectionId, name: action.name, tabCount: action.tabIds.length },
          "applied"
        );
      } else {
        settle(actionId, { ok: false, reason: "not_applied" }, "failed");
      }
      return true;
    },

    release(sessionId) {
      const hash = credentialOf.get(sessionId);
      if (hash) credentials.delete(hash);
      credentialOf.delete(sessionId);
      bindings.delete(sessionId);
      for (const action of [...actions.values()]) {
        if (action.sessionId !== sessionId) continue;
        if (action.status === "awaiting_approval" || action.status === "approved") {
          settle(action.id, { ok: false, reason: "ended" }, "cancelled");
        }
        actions.delete(action.id);
      }
    },

    releaseAll() {
      for (const sessionId of [...bindings.keys()]) api.release(sessionId);
    },

    activeCount: () => credentials.size,

    setApprover(next) {
      approve = next;
    },
  };
  return api;
}
