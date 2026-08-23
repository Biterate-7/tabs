import { ACTIONS, BROWSER_ACTION_NAMES } from "./registry";
import { runAction } from "./run";
import type { ActionRunContext } from "./types";
import type { WorkspaceStore } from "@/lib/workspace/types";

/**
 * One write action Gemini decided to take, captured with its already-
 * validated args (never the model's raw, untrusted call) plus a
 * human-readable description for the preview UI. `args` is `unknown` on the
 * wire — every consumer (applyPlan, in particular) MUST re-run it through
 * the action's own `validate()` rather than trusting this shape, which is
 * what makes it safe to round-trip through the browser and back.
 */
export type PlannedAction = {
  name: string;
  args: unknown;
  label: string;
  affected: number;
};

/**
 * Centralized, named thresholds for "is this small enough to just do it, or
 * does it need the user to look at it first" — the single place that
 * decides this, instead of scattering magic numbers through the action
 * layer or the agent loop. Tune here only.
 */
export const CONFIRMATION_POLICY = {
  /** More write actions than this in one plan always requires confirmation, regardless of size. */
  maxImmediateActions: 1,
  /** More total affected resources (tabs moved, groups created, ...) than this requires confirmation. */
  maxImmediateAffectedResources: 3,
};

/**
 * Opening tabs is a safe, easily-undoable operation (see
 * src/lib/browser/execute.ts's close_tabs revert), so — per AGENTS.md
 * section 7 — it stays immediate no matter how many tabs a single explicit
 * "open X" request opens (e.g. "open my Physics workspace" opening 12
 * tabs). It's still subject to CONFIRMATION_POLICY.maxImmediateActions like
 * everything else: chaining an open onto other writes in the same plan
 * still requires confirmation.
 */
const EXEMPT_FROM_AFFECTED_THRESHOLD = new Set(["open_url", "open_tabs", "open_workspace_in_browser", "import_browser_tabs_to_workspace"]);

/**
 * Closing tabs can't be safely undone (see AGENTS.md section 9), so a bulk
 * close (more than one tab in a single close_tabs call) always requires
 * confirmation regardless of the generic affected-resource threshold —
 * "close this one tab" (close_tab) stays immediate like any other
 * single-resource write, but "close all my tabs except Physics" never is.
 */
const ALWAYS_CONFIRM_IF_BULK = new Set(["close_tabs"]);

/** Read-only actions never appear in a plan — see runAgentLoop, which only records writes. */
export function isWriteAction(name: string): boolean {
  const action = ACTIONS[name];
  return Boolean(action && !action.readOnly);
}

export function planRequiresConfirmation(actions: PlannedAction[]): boolean {
  if (actions.length === 0) return false;
  if (actions.length > CONFIRMATION_POLICY.maxImmediateActions) return true;
  if (actions.some((a) => ALWAYS_CONFIRM_IF_BULK.has(a.name) && a.affected > 1)) return true;

  const countable = actions.filter((a) => !EXEMPT_FROM_AFFECTED_THRESHOLD.has(a.name));
  const totalAffected = countable.reduce((sum, a) => sum + a.affected, 0);
  return totalAffected > CONFIRMATION_POLICY.maxImmediateAffectedResources;
}

/**
 * Turns one write action's validated args + the (possibly staged) result of
 * actually running it into a one-line, human-readable description for the
 * preview — e.g. "Move 7 tabs → Physics IA". Kept as its own switch here
 * rather than a method on each ActionDefinition so the existing action
 * files (validated/committed already) don't need touching for a
 * preview-only concern.
 */
export function describePlannedAction(name: string, data: unknown): { label: string; affected: number } {
  switch (name) {
    case "create_workspace": {
      const d = data as { workspace: { name: string } };
      return { label: `Create workspace → "${d.workspace.name}"`, affected: 1 };
    }
    case "rename_workspace": {
      const d = data as { workspace: { name: string } };
      return { label: `Rename workspace → "${d.workspace.name}"`, affected: 1 };
    }
    case "move_tab":
    case "move_tabs": {
      const d = data as { targetWorkspaceName: string; movedCount: number };
      const count = d.movedCount;
      return { label: `Move ${count} tab${count === 1 ? "" : "s"} → "${d.targetWorkspaceName}"`, affected: count };
    }
    case "create_group": {
      const d = data as { group: { name: string } };
      return { label: `Create group → "${d.group.name}"`, affected: 1 };
    }
    case "rename_group": {
      const d = data as { group: { name: string } };
      return { label: `Rename group → "${d.group.name}"`, affected: 1 };
    }
    case "assign_tabs_to_group": {
      const d = data as { assignedCount: number; groupName: string };
      const count = d.assignedCount;
      return { label: `Assign ${count} tab${count === 1 ? "" : "s"} → group "${d.groupName}"`, affected: count };
    }
    case "remove_tabs_from_group": {
      const d = data as { removedCount: number };
      const count = d.removedCount;
      return { label: `Remove ${count} tab${count === 1 ? "" : "s"} from their group`, affected: count };
    }
    case "open_url": {
      const d = data as { url: string };
      return { label: `Open tab → ${d.url}`, affected: 1 };
    }
    case "open_tabs": {
      const d = data as { urlCount: number };
      return { label: `Open ${d.urlCount} tab${d.urlCount === 1 ? "" : "s"}`, affected: d.urlCount };
    }
    case "open_workspace_in_browser": {
      const d = data as { workspaceName: string; tabCount: number };
      return { label: `Open ${d.tabCount} tab${d.tabCount === 1 ? "" : "s"} from "${d.workspaceName}"`, affected: d.tabCount };
    }
    case "close_tab": {
      const d = data as { tabId: number };
      return { label: `Close 1 browser tab (id ${d.tabId})`, affected: 1 };
    }
    case "close_tabs": {
      const d = data as { count: number };
      return { label: `Close ${d.count} browser tab${d.count === 1 ? "" : "s"}`, affected: d.count };
    }
    case "pin_tab": {
      const d = data as { tabId: number };
      return { label: `Pin browser tab (id ${d.tabId})`, affected: 1 };
    }
    case "unpin_tab": {
      const d = data as { tabId: number };
      return { label: `Unpin browser tab (id ${d.tabId})`, affected: 1 };
    }
    case "move_tabs_to_window": {
      const d = data as { tabIds: number[]; windowId: number };
      return { label: `Move ${d.tabIds.length} browser tab${d.tabIds.length === 1 ? "" : "s"} → window ${d.windowId}`, affected: d.tabIds.length };
    }
    case "create_browser_window": {
      const d = data as { urls: string[] };
      return { label: d.urls.length > 0 ? `Create a new browser window with ${d.urls.length} tab${d.urls.length === 1 ? "" : "s"}` : "Create a new blank browser window", affected: 1 };
    }
    case "import_browser_tabs_to_workspace": {
      const d = data as { workspaceName: string; importedCount: number };
      return { label: `Save ${d.importedCount} browser tab${d.importedCount === 1 ? "" : "s"} → "${d.workspaceName}"`, affected: d.importedCount };
    }
    default:
      return { label: name, affected: 1 };
  }
}

function joinWithAnd(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** Deterministic (not model-generated) one-line summary — the trailing "This will ..." line under the proposed-change list. */
export function summarizePlan(actions: PlannedAction[]): string {
  if (actions.length === 0) return "This makes no changes.";

  const workspacesCreated = actions.filter((a) => a.name === "create_workspace").length;
  const groupsCreated = actions.filter((a) => a.name === "create_group").length;
  const tabsMoved = actions
    .filter((a) => a.name === "move_tab" || a.name === "move_tabs")
    .reduce((sum, a) => sum + a.affected, 0);
  const renames = actions.filter((a) => a.name === "rename_workspace" || a.name === "rename_group").length;
  const tabsGrouped = actions.filter((a) => a.name === "assign_tabs_to_group").reduce((sum, a) => sum + a.affected, 0);
  const tabsUngrouped = actions.filter((a) => a.name === "remove_tabs_from_group").reduce((sum, a) => sum + a.affected, 0);
  const tabsOpened = actions
    .filter((a) => a.name === "open_url" || a.name === "open_tabs" || a.name === "open_workspace_in_browser")
    .reduce((sum, a) => sum + a.affected, 0);
  const tabsClosed = actions.filter((a) => a.name === "close_tab" || a.name === "close_tabs").reduce((sum, a) => sum + a.affected, 0);

  const parts: string[] = [];
  if (workspacesCreated > 0) parts.push(`create ${workspacesCreated} workspace${workspacesCreated === 1 ? "" : "s"}`);
  if (groupsCreated > 0) parts.push(`create ${groupsCreated} group${groupsCreated === 1 ? "" : "s"}`);
  if (tabsMoved > 0) parts.push(`move ${tabsMoved} tab${tabsMoved === 1 ? "" : "s"}`);
  if (tabsGrouped > 0) parts.push(`group ${tabsGrouped} tab${tabsGrouped === 1 ? "" : "s"}`);
  if (tabsUngrouped > 0) parts.push(`ungroup ${tabsUngrouped} tab${tabsUngrouped === 1 ? "" : "s"}`);
  if (renames > 0) parts.push(`rename ${renames} item${renames === 1 ? "" : "s"}`);
  if (tabsOpened > 0) parts.push(`open ${tabsOpened} browser tab${tabsOpened === 1 ? "" : "s"}`);
  if (tabsClosed > 0) parts.push(`close ${tabsClosed} browser tab${tabsClosed === 1 ? "" : "s"}`);

  if (parts.length === 0) return `This will make ${actions.length} change${actions.length === 1 ? "" : "s"}.`;
  return `This will ${joinWithAnd(parts)}.`;
}

export function isPlannedActionInput(value: unknown): value is { name: string; args: unknown } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).name === "string" &&
    "args" in (value as Record<string, unknown>)
  );
}

const MAX_PLAN_LENGTH = 50;

export function isValidPlanInput(value: unknown): value is { name: string; args: unknown }[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_PLAN_LENGTH && value.every(isPlannedActionInput);
}

/**
 * `args`/`data` are only ever present for browser actions (see
 * BROWSER_ACTION_NAMES) — every other action's wire shape is exactly
 * `{name, ok, message}`, unchanged, so this stays a purely additive change
 * that doesn't disturb the exact-equality assertions in plan.test.ts/
 * agent.test.ts for existing TabDump actions. The client (useAskTabDump)
 * needs these two fields to actually execute a browser action for real
 * afterward — see src/lib/browser/execute.ts.
 */
export type AppliedAction = { name: string; ok: boolean; message: string; args?: unknown; data?: unknown };

export type ApplyPlanResult = {
  text: string;
  actions: AppliedAction[];
  store: WorkspaceStore;
  storeChanged: boolean;
};

function summarizeApplyText(actions: AppliedAction[]): string {
  const succeeded = actions.filter((a) => a.ok);
  const failed = actions.filter((a) => !a.ok);

  if (succeeded.length === 0) {
    return failed.length === 1
      ? `Nothing was changed — that failed: ${failed[0].message}`
      : "Nothing was changed — every planned action failed.";
  }

  const byName = new Map<string, number>();
  for (const a of succeeded) byName.set(a.name, (byName.get(a.name) ?? 0) + 1);

  const parts: string[] = [];
  const workspacesCreated = byName.get("create_workspace") ?? 0;
  const groupsCreated = byName.get("create_group") ?? 0;
  const moves = (byName.get("move_tab") ?? 0) + (byName.get("move_tabs") ?? 0);
  const renames = (byName.get("rename_workspace") ?? 0) + (byName.get("rename_group") ?? 0);
  const groupAssigns = byName.get("assign_tabs_to_group") ?? 0;
  const groupRemovals = byName.get("remove_tabs_from_group") ?? 0;

  if (workspacesCreated > 0) parts.push(`created ${workspacesCreated} workspace${workspacesCreated === 1 ? "" : "s"}`);
  if (groupsCreated > 0) parts.push(`created ${groupsCreated} group${groupsCreated === 1 ? "" : "s"}`);
  if (moves > 0) parts.push(`moved tabs (${moves} move${moves === 1 ? "" : "s"})`);
  if (groupAssigns > 0) parts.push(`assigned tabs to groups (${groupAssigns} call${groupAssigns === 1 ? "" : "s"})`);
  if (groupRemovals > 0) parts.push(`removed tabs from groups (${groupRemovals} call${groupRemovals === 1 ? "" : "s"})`);
  if (renames > 0) parts.push(`renamed ${renames} item${renames === 1 ? "" : "s"}`);

  const done = parts.length > 0 ? joinWithAnd(parts) : `completed ${succeeded.length} change${succeeded.length === 1 ? "" : "s"}`;

  if (failed.length === 0) return `Done — ${done}.`;
  return `Done — ${done}. ${failed.length} action${failed.length === 1 ? "" : "s"} failed: ${failed.map((f) => f.message).join("; ")}`;
}

/**
 * Executes an approved plan for real. This is the ONLY place a plan's
 * mutations actually land in a store — planning (see agent.ts) only ever
 * simulates against a scratch copy that's discarded. Every step is
 * revalidated from scratch here via runAction (fresh existence/scope
 * checks against `store`, exactly as if Gemini had just called it) — the
 * plan the client sends back is treated as untrusted input, not as a
 * pre-approved certificate. A failed step doesn't stop the rest, and is
 * never folded into "success" in the summary text.
 *
 * `ctx` is threaded through to every step exactly like runAgentLoop does —
 * a browser write action's own run() re-checks `ctx.browserContext` at
 * apply time too (the extension could have disconnected, or a tab could
 * have closed, between preview and Apply), never trusting that planning
 * having succeeded once still holds true now.
 */
export function applyPlan(plan: { name: string; args: unknown }[], store: WorkspaceStore, ctx?: ActionRunContext): ApplyPlanResult {
  let current = store;
  const actions: AppliedAction[] = [];

  for (const step of plan) {
    const outcome = runAction(step.name, step.args, current, ctx);
    const isBrowserAction = BROWSER_ACTION_NAMES.has(step.name);
    if (outcome.ok) {
      current = outcome.store;
      actions.push({
        name: step.name,
        ok: true,
        message: JSON.stringify(outcome.data),
        ...(isBrowserAction ? { args: outcome.args, data: outcome.data } : {}),
      });
    } else {
      actions.push({ name: step.name, ok: false, message: outcome.message });
    }
  }

  return { text: summarizeApplyText(actions), actions, store: current, storeChanged: current !== store };
}
