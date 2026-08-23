import { analyzeForOrganization } from "@/lib/organize/analyze";
import { validateOrganizationPlan } from "@/lib/organize/validate";
import type { OrganizationPlan } from "@/lib/organize/types";
import { getCurrentWorkspace } from "@/lib/workspace/store";
import { asRecord } from "./validate";
import type { ActionDefinition } from "./types";

export type ProposeAutoOrganizeArgs = { scope: "current" | "all" };
export type ProposeAutoOrganizeData = { plan: OrganizationPlan };

/**
 * The single entry point Gemini calls when a user asks to organize, clean
 * up, sort, or tidy their tabs (AGENTS.md section 1) — read-only, so it
 * never mutates the store while deciding how to organize (section 3). The
 * actual clustering/naming/reuse-decision logic is entirely deterministic
 * (src/lib/organize/analyze.ts) — this action's only job is scoping
 * (current workspace vs. every workspace) and validating the result before
 * it's ever shown to the user (section 16). runAgentLoop (src/lib/actions/
 * agent.ts) special-cases this action's success to short-circuit straight
 * to an "organize" result instead of letting Gemini keep calling
 * create_workspace/move_tabs itself (section 15).
 */
export const proposeAutoOrganizeAction: ActionDefinition<ProposeAutoOrganizeArgs, ProposeAutoOrganizeData> = {
  name: "propose_auto_organize",
  description:
    "Analyze the user's saved tabs and propose an organization into workspaces (and, where clearly warranted, groups) — used for requests like \"organize my tabs\", \"clean up this workspace\", \"organize everything by subject\", \"sort my tabs into useful workspaces\". Read-only: it never moves or creates anything itself, only proposes a plan for the user to review and apply. Use scope \"current\" when the user is clearly talking about just the workspace they're in (e.g. \"clean up this workspace\"), and \"all\" for anything broader (e.g. \"organize my TabDump\", \"organize everything\").",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: {
      scope: {
        type: "STRING",
        description: "\"current\" to only reorganize the current workspace, or \"all\" to consider every workspace. Defaults to \"all\".",
      },
    },
    required: [],
  },
  validate(raw) {
    const record = asRecord(raw) ?? {};
    const scopeValue = record.scope;
    const scope = scopeValue === "current" ? "current" : "all";
    return { ok: true, args: { scope } };
  },
  run(store, args, ctx) {
    const scopeWorkspaces = args.scope === "current" ? [getCurrentWorkspace(store)] : store.workspaces;
    const plan = analyzeForOrganization(scopeWorkspaces, store.workspaces, ctx?.semanticClusters);

    const validation = validateOrganizationPlan(plan, store);
    if (!validation.ok) {
      return { ok: false, message: `Couldn't build a valid organization plan: ${validation.errors[0]}` };
    }

    return { ok: true, data: { plan } };
  },
};
