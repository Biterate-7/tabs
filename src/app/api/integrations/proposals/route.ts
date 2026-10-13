import "server-only";
import { integrationContext, okJson, readJson, refuse } from "@/lib/integrations/routes";
import { decideProposalAsUser } from "@/lib/integrations/service";
import { proposalView } from "@/lib/integrations/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The person's answer to a proposal from an AI client: approve, decline, or
 * apply an approved one now. This route — Hubble's own origin, the person's
 * session — is the only way a proposal is approved. No MCP tool reaches it.
 */
export async function POST(request: Request): Promise<Response> {
  const context = await integrationContext(request, { mutating: true });
  if (context instanceof Response) return context;
  const body = await readJson(request);
  const action = body?.action;
  if (!body || typeof body.proposalId !== "string" || (action !== "approve" && action !== "decline" && action !== "apply")) {
    return refuse("invalid_request", "Hubble could not read that request.", 400);
  }

  const outcome = await decideProposalAsUser(
    { store: context.store, data: context.data, sync: context.sync, now: () => Date.now() },
    context.userId,
    body.proposalId,
    action
  );
  if (outcome.ok) return okJson({ proposal: proposalView(outcome.proposal) });

  const messages: Record<string, string> = {
    not_found: "That proposal no longer exists.",
    not_pending: "That proposal was already decided.",
    expired: "That proposal expired. Ask the AI to propose it again.",
    awaiting_approval: "Approve the proposal before applying it.",
    declined: "That proposal was declined.",
    in_progress: "That proposal is being applied right now.",
    changed: "The workspace changed since this was proposed, so it was not applied. Nothing changed.",
    failed: "Hubble could not apply this proposal. Nothing changed.",
  };
  return refuse(outcome.reason, messages[outcome.reason] ?? "Hubble could not do that.", outcome.reason === "not_found" ? 404 : 409);
}
