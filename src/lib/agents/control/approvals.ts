import { requiresApproval } from "./permissions";
import { readWorkspaceChangeSummary } from "@/lib/agents/session-context/changes";
import { readWorkspacePlanPreview } from "@/lib/agents/session-context/plan";
import type { AgentPermissionScope } from "./permissions";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { WorkspaceChangeSummary } from "@/lib/agents/session-context/changes";
import type { WorkspacePlanPreview } from "@/lib/agents/session-context/plan";

/**
 * The approval broker.
 *
 * ## What an approval is
 *
 * A permission grant says "this agent may write in this project **at all**".
 * An approval says "this agent may write **these four files, right now**".
 * Both are required for an action that modifies the user's machine, and the
 * gap between them is the entire difference between authorizing a tool and
 * authorizing an act.
 *
 * ## Phase B scope
 *
 * The broker is real: it mints requests, holds them, resolves them, expires
 * them, and refuses everything that should be refused. What it does **not**
 * do yet is receive a request from an actual provider — no adapter implements
 * `approvals` in this phase, so in practice nothing calls `request` outside
 * its own tests. That is the honest state, and it is why
 * `providers/claude-code.ts` declares no `approvals` capability.
 *
 * ## Fail-closed, twice
 *
 * A pending approval is **not** an implicit deny and **not** an implicit
 * allow: the caller awaits a decision, and a decision that never arrives
 * expires — to denied. `resolve` refuses to act on an approval that is
 * already resolved, so a late "granted" cannot overturn a deny the user
 * already gave.
 */

export type ApprovalStatus = "requested" | "granted" | "denied" | "expired" | "cancelled";

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "requested",
  "granted",
  "denied",
  "expired",
  "cancelled",
] as const;

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

/** Statuses an approval never leaves. Only `requested` is live. */
export const TERMINAL_APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "granted",
  "denied",
  "expired",
  "cancelled",
] as const;

export function isTerminalApprovalStatus(status: ApprovalStatus): boolean {
  return (TERMINAL_APPROVAL_STATUSES as readonly string[]).includes(status);
}

/**
 * What the agent wants to do.
 *
 * A closed set, because this is what the future dialog's headline is built
 * from and a free string would put provider prose into the one sentence the
 * user has to evaluate.
 */
export type ApprovalAction =
  | "modify_files"
  | "create_files"
  | "delete_files"
  | "run_command"
  | "network_request"
  | "use_mcp_tool"
  /** Change the Hubble workspace the session was started from (Phase J.3). */
  | "change_workspace";

export const APPROVAL_ACTIONS: readonly ApprovalAction[] = [
  "modify_files",
  "create_files",
  "delete_files",
  "run_command",
  "network_request",
  "use_mcp_tool",
  "change_workspace",
] as const;

export function isApprovalAction(value: unknown): value is ApprovalAction {
  return typeof value === "string" && (APPROVAL_ACTIONS as readonly string[]).includes(value);
}

/** The verb phrase the UI puts after the agent's name. Provider-neutral by construction. */
export const APPROVAL_ACTION_LABELS: Record<ApprovalAction, string> = {
  modify_files: "modify files",
  create_files: "create files",
  delete_files: "delete files",
  run_command: "run a command",
  network_request: "access the network",
  use_mcp_tool: "use an MCP tool",
  change_workspace: "change your Hubble workspace",
};

/** Cap on the provider-supplied reason. Bounded for the same reasons an event summary is. */
export const MAX_APPROVAL_REASON_LENGTH = 300;

/** Cap on how many targets one approval may name, so a dialog stays evaluable. */
export const MAX_APPROVAL_TARGETS = 50;

/**
 * One request, with everything the future UI needs to explain it.
 *
 * The shape answers: **who** wants to do **what**, to **which targets**, in
 * **which project**, under **which scope**, and **why**.
 */
export type AgentApproval = {
  id: string;
  sessionId: string;
  provider: AgentProviderId;
  /** The domain run this concerns, when the session has one. */
  runId?: string;
  action: ApprovalAction;
  /** The permission scope this action falls under. Checked against the grant before it is ever shown. */
  scope: AgentPermissionScope;
  /**
   * Where the action would happen: exactly one of a project (files, commands)
   * or — for `write_workspace` only — the Hubble workspace the session was
   * started from (Phase J.3). An approval naming neither, or both, is refused.
   */
  projectId?: string;
  workspaceId?: string;
  /**
   * What would be affected, as project-relative paths or command labels.
   *
   * Never absolute paths and never raw command strings — the same rule the
   * event model follows. For `run_command` this is the command's *name*, not
   * its argv.
   */
  targets: readonly string[];
  /** The provider's own explanation, when it supplies one. Already bounded and safe. */
  reason?: string;
  /**
   * For `write_workspace` only (Phase J.4): the change itself, structured,
   * so the card can say "Gemini CLI wants to create a collection: Launch
   * reading" instead of a list of lines. Bounded and read strictly here; a
   * malformed one is dropped, and the targets still describe the change.
   */
  change?: WorkspaceChangeSummary;
  /**
   * For `write_workspace` only (Phase J.5): a plan of several changes, every
   * step as the user reads it. Approving it approves exactly these steps,
   * once — never the agent, never a later plan. Read strictly here; a
   * malformed one is dropped, and the targets still list every step.
   */
  plan?: WorkspacePlanPreview;
  status: ApprovalStatus;
  requestedAt: number;
  /** After this instant the request is no longer answerable. */
  expiresAt: number;
  /** When it reached a terminal status. */
  resolvedAt?: number;
};

export type ApprovalRequestInput = {
  id: string;
  sessionId: string;
  provider: AgentProviderId;
  action: ApprovalAction;
  scope: AgentPermissionScope;
  projectId?: string;
  workspaceId?: string;
  targets: readonly string[];
  runId?: string;
  reason?: string;
  change?: WorkspaceChangeSummary;
  plan?: WorkspacePlanPreview;
  /** How long the user has to answer. */
  ttlMs?: number;
};

/** Default window. Long enough to walk away from and come back; short enough not to linger for a day. */
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

export type ApprovalRejection =
  | "invalid-action"
  | "invalid-scope"
  | "missing-project"
  | "missing-workspace"
  | "no-targets"
  | "too-many-targets"
  | "scope-needs-no-approval"
  | "duplicate-id";

export type RequestApprovalResult =
  | { ok: true; approval: AgentApproval }
  | { ok: false; reason: ApprovalRejection };

function boundReason(reason: string): string {
  const collapsed = reason.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_APPROVAL_REASON_LENGTH
    ? collapsed.slice(0, MAX_APPROVAL_REASON_LENGTH)
    : collapsed;
}

/**
 * Whether a target is expressible in an approval.
 *
 * Absolute paths and traversal are refused here as well as at the event
 * boundary, because this is the string a user reads before saying yes and it
 * must describe something inside the project they think they are authorizing.
 */
function isValidTarget(target: string): boolean {
  if (!target || target.length > 512) return false;
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) return false;
  if (target.split("/").includes("..")) return false;
  return true;
}

export type ApprovalBroker = {
  /**
   * Mints a pending request, or refuses.
   *
   * Refuses a scope that needs no approval: minting one would train a user to
   * click through dialogs that never mattered, which is how a real one gets
   * clicked through too.
   */
  request(input: ApprovalRequestInput, now: number): RequestApprovalResult;
  /** Answers a pending request. Refuses if it is unknown, already resolved, or expired. */
  resolve(id: string, decision: "granted" | "denied", now: number): ResolveApprovalResult;
  /** Withdraws a request the agent no longer needs — a cancelled run, a disconnected session. */
  cancel(id: string, now: number): ResolveApprovalResult;
  /** Expires everything past its deadline. Returns what it expired. */
  sweep(now: number): AgentApproval[];
  get(id: string): AgentApproval | undefined;
  /** Live requests only, oldest first, so a UI shows the one that has waited longest. */
  pending(now: number): AgentApproval[];
  /** Every request for a session, live or not. */
  forSession(sessionId: string): AgentApproval[];
  /** Notified on every status change. Returns the detach function. */
  watch(listener: ApprovalListener): () => void;
};

export type ApprovalListener = (approval: AgentApproval) => void;

export type ResolveApprovalResult =
  | { ok: true; approval: AgentApproval }
  | { ok: false; reason: "unknown" | "already-resolved" | "expired" };

export function createApprovalBroker(): ApprovalBroker {
  const approvals = new Map<string, AgentApproval>();
  const listeners = new Set<ApprovalListener>();

  function emit(approval: AgentApproval): void {
    // Snapshot: a listener detaching mid-notification would otherwise mutate
    // the set while it is being iterated.
    for (const listener of [...listeners]) listener(approval);
  }

  /**
   * Expires one approval if its deadline has passed.
   *
   * Called from every read path rather than from a timer. A broker that owned
   * a timer would keep the process awake and would still be wrong the moment
   * the machine slept; deriving expiry from the clock at the moment somebody
   * asks is correct under both.
   */
  function expireIfDue(approval: AgentApproval, now: number): AgentApproval {
    if (approval.status !== "requested" || now < approval.expiresAt) return approval;

    const expired: AgentApproval = { ...approval, status: "expired", resolvedAt: now };
    approvals.set(expired.id, expired);
    emit(expired);
    return expired;
  }

  function settle(
    id: string,
    status: "granted" | "denied" | "cancelled",
    now: number
  ): ResolveApprovalResult {
    const existing = approvals.get(id);
    if (!existing) return { ok: false, reason: "unknown" };

    const current = expireIfDue(existing, now);
    if (current.status === "expired") return { ok: false, reason: "expired" };
    if (isTerminalApprovalStatus(current.status)) return { ok: false, reason: "already-resolved" };

    const resolved: AgentApproval = { ...current, status, resolvedAt: now };
    approvals.set(id, resolved);
    emit(resolved);
    return { ok: true, approval: resolved };
  }

  return {
    request(input, now) {
      if (!isApprovalAction(input.action)) return { ok: false, reason: "invalid-action" };
      // A workspace change happens in one workspace and nowhere else; every
      // other action happens in one project and nowhere else. Never both, and
      // never neither — an approval with no place is not one a person can
      // evaluate.
      if (input.scope === "write_workspace") {
        if (!input.workspaceId || input.projectId) return { ok: false, reason: "missing-workspace" };
        if (input.action !== "change_workspace") return { ok: false, reason: "invalid-action" };
      } else {
        if (!input.projectId || input.workspaceId) return { ok: false, reason: "missing-project" };
        if (input.action === "change_workspace") return { ok: false, reason: "invalid-action" };
      }
      if (approvals.has(input.id)) return { ok: false, reason: "duplicate-id" };

      // An approval for a scope that is already sufficient on its grant alone
      // is noise, and noise is what makes a real prompt get waved through.
      if (!requiresApproval(input.scope)) {
        return { ok: false, reason: "scope-needs-no-approval" };
      }

      const targets = input.targets.filter(isValidTarget);
      if (targets.length === 0) return { ok: false, reason: "no-targets" };
      if (targets.length > MAX_APPROVAL_TARGETS) return { ok: false, reason: "too-many-targets" };

      const approval: AgentApproval = {
        id: input.id,
        sessionId: input.sessionId,
        provider: input.provider,
        action: input.action,
        scope: input.scope,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        targets,
        status: "requested",
        requestedAt: now,
        expiresAt: now + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
      };

      if (input.runId) approval.runId = input.runId;
      if (input.change && input.scope === "write_workspace") {
        const change = readWorkspaceChangeSummary(input.change);
        if (change) approval.change = change;
      }
      if (input.plan && input.scope === "write_workspace") {
        const plan = readWorkspacePlanPreview(input.plan);
        if (plan) approval.plan = plan;
      }
      if (input.reason) {
        const bounded = boundReason(input.reason);
        if (bounded) approval.reason = bounded;
      }

      approvals.set(approval.id, approval);
      emit(approval);
      return { ok: true, approval };
    },

    resolve: (id, decision, now) => settle(id, decision, now),

    cancel: (id, now) => settle(id, "cancelled", now),

    sweep(now) {
      const expired: AgentApproval[] = [];
      for (const approval of [...approvals.values()]) {
        const after = expireIfDue(approval, now);
        if (after.status === "expired" && approval.status === "requested") expired.push(after);
      }
      return expired;
    },

    get: (id) => approvals.get(id),

    pending(now) {
      return [...approvals.values()]
        .map((approval) => expireIfDue(approval, now))
        .filter((approval) => approval.status === "requested")
        .sort((a, b) => a.requestedAt - b.requestedAt);
    },

    forSession(sessionId) {
      return [...approvals.values()].filter((approval) => approval.sessionId === sessionId);
    },

    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The sentence a UI puts at the top of an approval.
 *
 * Built here rather than in a component so that every surface says the same
 * thing, and so the phrasing is covered by this module's tests rather than by
 * a snapshot of some future dialog.
 */
export function describeApproval(approval: AgentApproval, providerName: string): string {
  const count = approval.targets.length;
  const noun = count === 1 ? "1 item" : `${count} items`;
  return `${providerName} wants to ${APPROVAL_ACTION_LABELS[approval.action]} (${noun})`;
}
