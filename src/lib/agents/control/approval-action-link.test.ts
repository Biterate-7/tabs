import { describe, expect, it } from "vitest";
import { createApprovalBroker } from "./approvals";
import type { ApprovalRequestInput } from "./approvals";

/**
 * An approval for a workspace change names the change it authorizes — the
 * session context registry's action id — so the change the Command Centre
 * later applies is traced back to it by id, never by timing or wording.
 */

const T0 = 1_700_000_000_000;

const workspaceChange: ApprovalRequestInput = {
  id: "wa-1",
  sessionId: "s1",
  provider: "claude-code",
  action: "change_workspace",
  scope: "write_workspace",
  workspaceId: "w1",
  targets: [`New collection "Pricing"`],
  contextActionId: "ctxa-1",
};

describe("the approval ↔ action link", () => {
  it("keeps the action a workspace approval authorizes", () => {
    const made = createApprovalBroker().request(workspaceChange, T0);
    expect(made.ok && made.approval.contextActionId).toBe("ctxa-1");
  });

  it("is never kept on a project approval, which authorizes no workspace change", () => {
    const made = createApprovalBroker().request(
      {
        ...workspaceChange,
        id: "a-1",
        action: "create_files",
        scope: "write_project",
        workspaceId: undefined,
        projectId: "p1",
        targets: ["notes.md"],
      },
      T0
    );
    expect(made.ok).toBe(true);
    expect(made.ok && made.approval.contextActionId).toBeUndefined();
  });
});
