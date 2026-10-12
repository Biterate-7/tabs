import { applyCollectionBatch } from "@/lib/collections/batch";
import { planEffect, planStepLine, PLAN_LIMITS, validateWorkspacePlan, verifyWorkspacePlan } from "@/lib/agents/session-context/plan";
import { analyzeTopics } from "@/lib/agents/session-context/topics";
import { recommendPlacement } from "@/lib/agents/session-context/relevance";
import { mintRecordId } from "./credentials";
import { loadBasis, writeCollections } from "./writer";
import type { PlanProblem, ValidatedWorkspacePlan, WorkspaceOperation } from "@/lib/agents/session-context/plan";
import type { HubbleMcpData } from "@/lib/mcp/data";
import type { IntegrationGrant } from "./grants";
import type { ProposalOperation, ProposalRecord, ProposalResult, ProposalStep } from "./records";
import type { IntegrationStore } from "./store";
import type { SyncWriterBackend, WriteBasis } from "./writer";

/**
 * Reorganization proposals: the one write an AI client cannot make alone.
 *
 * ## The lifecycle
 *
 *     propose_organization ─▶ pending ──(person, in Hubble)──▶ approved ─▶ applying ─▶ applied
 *                                 │                                │                └─▶ failed
 *                                 └──▶ declined / expired           └──▶ expired
 *
 * A proposal is a plan in J.5's vocabulary — create, rename, add tabs —
 * validated by the same `validateWorkspacePlan` an agent session's plan goes
 * through, with the same problem codes, against the workspace as the server
 * holds it. When the client gives no operations, Hubble drafts them from its
 * own topic analysis (`analyzeTopics` + `recommendPlacement`), which only
 * ever files tabs that are in no collection yet.
 *
 * ## Who approves
 *
 * The person, in Hubble, and nobody else. Approval is a cookie-authenticated
 * action on Hubble's own origin (src/app/api/integrations/proposals); no MCP
 * tool can approve, and nothing an AI client says, nor anything written in a
 * saved page, is an approval. A platform's own "allow this tool?" dialog is
 * welcome as a second check and is never treated as this one.
 *
 * ## Revalidated before it changes anything
 *
 * Applying re-reads the workspace and validates the stored operations again
 * against what is there now. The proposal applies only if it would still do
 * *exactly* what the person approved (`planEffect` equal) — otherwise it is
 * marked failed and the client is told to propose again. Applying is one
 * sync push: all of it, or none of it. Afterwards the workspace is read once
 * more and every step is verified.
 */

export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** At most this many proposals waiting for one person at once. */
export const MAX_PENDING_PROPOSALS = 20;

export type ProposalDeps = { store: IntegrationStore; data: HubbleMcpData; sync: SyncWriterBackend; now: () => number };

function toProposalOperation(operation: WorkspaceOperation): ProposalOperation {
  return JSON.parse(JSON.stringify(operation)) as ProposalOperation;
}

function toSteps(plan: ValidatedWorkspacePlan): ProposalStep[] {
  return plan.steps.map((step) => ({
    kind: step.kind,
    line: planStepLine(step),
    subject: step.subject,
    ...(step.to ? { to: step.to } : {}),
    ...(step.tabCount !== undefined ? { tabCount: step.tabCount } : {}),
    tabs: [...step.tabs],
    ...(step.moreTabs ? { moreTabs: step.moreTabs } : {}),
    movesFrom: [...step.movesFrom],
    ...(step.reason ? { reason: step.reason } : {}),
    ...(step.confidence ? { confidence: step.confidence } : {}),
  }));
}

/**
 * Operations Hubble would suggest for the tabs in no collection, from its
 * own topic analysis. High- and medium-confidence groups only; a tab is
 * never placed twice.
 */
export function draftOrganization(basis: WriteBasis, options: { includeFiled?: boolean } = {}): WorkspaceOperation[] {
  const snapshot = basis.loaded;
  const analysis = analyzeTopics(snapshot, { uncategorizedOnly: options.includeFiled !== true });
  const operations: WorkspaceOperation[] = [];
  const placed = new Set<string>();
  for (const group of analysis.groups) {
    if (operations.length >= PLAN_LIMITS.operations) break;
    if (group.confidence === "low") continue;
    const placement = recommendPlacement(snapshot, { tabIds: group.tabIds, name: group.label, terms: group.terms, confidence: group.confidence });
    if (!("operation" in placement)) continue;
    const tabIds = placement.operation.tabIds.filter((tabId) => !placed.has(tabId));
    if (tabIds.length === 0) continue;
    for (const tabId of tabIds) placed.add(tabId);
    operations.push({
      ...placement.operation,
      tabIds,
      reason: placement.reason.slice(0, PLAN_LIMITS.reason),
      confidence: group.confidence === "high" ? "high" : "medium",
    } as WorkspaceOperation);
  }
  return operations;
}

export type ProposeOutcome =
  | { ok: true; proposal: ProposalRecord }
  | { ok: false; reason: "not_found" | "too_large" | "nothing_to_propose" | "too_many_pending" }
  | { ok: false; reason: "invalid"; problems: readonly PlanProblem[]; currentVersion: number };

export async function proposeOrganization(
  deps: ProposalDeps,
  grant: IntegrationGrant & { connectionId: string },
  input: { workspaceId: string; operations?: unknown; basedOnVersion?: number; summary?: string; includeFiled?: boolean }
): Promise<ProposeOutcome> {
  const basis = await loadBasis(deps, grant.userId, input.workspaceId);
  if (basis === "not_found" || basis === "too_large") return { ok: false, reason: basis };

  const pending = await deps.store.listProposals(grant.userId, { statuses: ["pending", "approved"], limit: MAX_PENDING_PROPOSALS + 1 });
  if (pending.length >= MAX_PENDING_PROPOSALS) return { ok: false, reason: "too_many_pending" };

  const drafted = input.operations === undefined;
  const operations = drafted ? draftOrganization(basis, { includeFiled: input.includeFiled }) : input.operations;
  if (drafted && (operations as WorkspaceOperation[]).length === 0) return { ok: false, reason: "nothing_to_propose" };

  const validation = validateWorkspacePlan(
    basis.loaded,
    // A drafted plan is by construction against this version. A client's plan
    // must say which version it read, exactly as an agent session's must.
    { basedOnVersion: drafted ? basis.version : (input.basedOnVersion ?? basis.version), workspaceId: input.workspaceId, operations },
    { workspaceId: input.workspaceId, version: basis.version }
  );
  if (!validation.ok) return { ok: false, reason: "invalid", problems: validation.problems, currentVersion: validation.currentVersion };

  const now = deps.now();
  const proposal: ProposalRecord = {
    id: mintRecordId("prop"),
    userId: grant.userId,
    connectionId: grant.connectionId,
    client: grant.client,
    workspaceId: input.workspaceId,
    baseVersion: basis.version,
    operations: validation.plan.operations.map(toProposalOperation),
    steps: toSteps(validation.plan),
    tabCount: validation.plan.tabCount,
    effect: planEffect(validation.plan),
    ...(input.summary ? { summary: input.summary } : {}),
    status: "pending",
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
  };
  await deps.store.createProposal(proposal);
  return { ok: true, proposal };
}

/** A pending or approved proposal past its time is expired, whoever looks first. */
export async function expireIfDue(store: IntegrationStore, proposal: ProposalRecord, now: number): Promise<ProposalRecord> {
  if ((proposal.status === "pending" || proposal.status === "approved") && proposal.expiresAt <= now) {
    return (await store.transitionProposal(proposal.userId, proposal.id, ["pending", "approved"], "expired", { failure: "expired" })) ?? proposal;
  }
  return proposal;
}

export type DecisionOutcome =
  | { ok: true; proposal: ProposalRecord }
  | { ok: false; reason: "not_found" | "not_pending" | "expired" };

/** The person's answer, from Hubble's own UI. */
export async function decideProposal(
  store: IntegrationStore,
  userId: string,
  proposalId: string,
  decision: "approve" | "decline",
  now: number
): Promise<DecisionOutcome> {
  const found = await store.getProposal(userId, proposalId);
  if (!found) return { ok: false, reason: "not_found" };
  const current = await expireIfDue(store, found, now);
  if (current.status === "expired") return { ok: false, reason: "expired" };
  const moved = await store.transitionProposal(userId, proposalId, ["pending"], decision === "approve" ? "approved" : "declined", {
    decidedAt: now,
  });
  return moved ? { ok: true, proposal: moved } : { ok: false, reason: "not_pending" };
}

export type ApplyOutcome =
  | { ok: true; proposal: ProposalRecord; alreadyApplied: boolean }
  | { ok: false; reason: "not_found" | "awaiting_approval" | "declined" | "expired" | "in_progress"; proposal?: ProposalRecord }
  | { ok: false; reason: "changed" | "failed"; proposal: ProposalRecord };

/**
 * Applies an approved proposal. Safe to call twice and from two places at
 * once (the client's apply_organization and the person's "Apply now"): the
 * approved → applying move succeeds for one caller, and a call after it
 * finished returns the stored result.
 */
export async function applyProposal(
  deps: ProposalDeps,
  userId: string,
  proposalId: string,
  options: { connectionId?: string } = {}
): Promise<ApplyOutcome> {
  const found = await deps.store.getProposal(userId, proposalId);
  // A connection applies only its own proposals; the person may apply any of theirs.
  if (!found || (options.connectionId !== undefined && found.connectionId !== options.connectionId)) return { ok: false, reason: "not_found" };
  const current = await expireIfDue(deps.store, found, deps.now());
  switch (current.status) {
    case "applied":
      return { ok: true, proposal: current, alreadyApplied: true };
    case "pending":
      return { ok: false, reason: "awaiting_approval", proposal: current };
    case "declined":
      return { ok: false, reason: "declined", proposal: current };
    case "expired":
      return { ok: false, reason: "expired", proposal: current };
    case "applying":
      return { ok: false, reason: "in_progress", proposal: current };
    case "failed":
      return { ok: false, reason: current.failure === "changed" ? "changed" : "failed", proposal: current };
    case "approved":
      break;
  }

  const claimed = await deps.store.transitionProposal(userId, proposalId, ["approved"], "applying", {});
  if (!claimed) return { ok: false, reason: "in_progress" };

  const operations = claimed.operations as unknown as WorkspaceOperation[];
  let changed = false;
  const outcome = await writeCollections<{ created: string[] }>(
    deps,
    userId,
    claimed.workspaceId,
    (basis) => {
      const revalidated = validateWorkspacePlan(
        basis.loaded,
        { basedOnVersion: basis.version, workspaceId: claimed.workspaceId, operations },
        { workspaceId: claimed.workspaceId, version: basis.version }
      );
      if (!revalidated.ok || planEffect(revalidated.plan) !== claimed.effect) {
        changed = true;
        return { ok: false, refusal: "changed" };
      }
      const batch = applyCollectionBatch(
        basis.loaded.collections,
        { workspaceId: claimed.workspaceId, tabIds: new Set(basis.loaded.workspace.tabs.map((tab) => tab.id)) },
        operations,
        deps.now()
      );
      if (!batch.ok) {
        changed = true;
        return { ok: false, refusal: "changed" };
      }
      const created = batch.created;
      return { ok: true, collections: batch.collections, touched: batch.touched, report: () => ({ created }) };
    }
  );

  if (!outcome.ok) {
    const failure = changed ? "changed" : outcome.reason;
    const failed = (await deps.store.transitionProposal(userId, proposalId, ["applying"], "failed", { failure })) ?? claimed;
    return { ok: false, reason: changed ? "changed" : "failed", proposal: failed };
  }

  // Verified against the workspace as stored after the push.
  let result: ProposalResult = { verified: false, steps: claimed.steps.map((step, index) => ({ index, line: step.line, verified: false })) };
  const after = await loadBasis(deps, userId, claimed.workspaceId).catch(() => "not_found" as const);
  if (typeof after !== "string") {
    const verification = verifyWorkspacePlan(after.loaded, operations, outcome.value.created);
    result = {
      verified: verification.verified,
      steps: verification.results.map((entry) => ({
        index: entry.index,
        line: claimed.steps[entry.index]?.line ?? "",
        verified: entry.verified,
        ...(entry.collectionId ? { collectionId: entry.collectionId } : {}),
      })),
    };
  }
  const applied =
    (await deps.store.transitionProposal(userId, proposalId, ["applying"], "applied", { appliedAt: deps.now(), result })) ?? claimed;
  return { ok: true, proposal: applied, alreadyApplied: false };
}

/** What a client or the settings pane may see of a proposal. No operation ids beyond what the client sent. */
export function proposalView(proposal: ProposalRecord) {
  return {
    proposalId: proposal.id,
    workspaceId: proposal.workspaceId,
    status: proposal.status,
    basedOnVersion: proposal.baseVersion,
    tabCount: proposal.tabCount,
    changes: proposal.steps.map((step) => step.line),
    steps: proposal.steps,
    ...(proposal.summary ? { summary: proposal.summary } : {}),
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    ...(proposal.decidedAt ? { decidedAt: proposal.decidedAt } : {}),
    ...(proposal.appliedAt ? { appliedAt: proposal.appliedAt } : {}),
    ...(proposal.result ? { result: proposal.result } : {}),
    ...(proposal.failure ? { failure: proposal.failure } : {}),
  };
}
