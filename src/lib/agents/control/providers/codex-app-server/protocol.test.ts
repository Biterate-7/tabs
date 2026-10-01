import { describe, expect, it } from "vitest";
import {
  isAskingSettings,
  isVersionAtLeast,
  readAccount,
  readCommandApproval,
  readInitializeVersion,
  readItemNotification,
  readToolCallElicitation,
  readTurnCompleted,
  threadStartParams,
} from "./protocol";

describe("Codex app-server protocol readers (verified against 0.159.0)", () => {
  it("reads the version from initialize's userAgent", () => {
    expect(readInitializeVersion({ userAgent: "hubble/0.159.0 (Windows 10.0.26200; x86_64) xterm (hubble; 1)" })).toEqual([0, 159, 0]);
    expect(readInitializeVersion({ userAgent: "hubble/0.160.0-alpha.6 (x)" })).toBeUndefined();
    expect(readInitializeVersion({})).toBeUndefined();
    expect(isVersionAtLeast([0, 159, 0], [0, 159, 0])).toBe(true);
    expect(isVersionAtLeast([0, 160, 0], [0, 159, 0])).toBe(true);
    expect(isVersionAtLeast([1, 0, 0], [0, 159, 0])).toBe(true);
    expect(isVersionAtLeast([0, 158, 99], [0, 159, 0])).toBe(false);
  });

  it("reads sign-in state from account/read, keeping only the kind", () => {
    expect(readAccount({ account: null, requiresOpenaiAuth: true })).toEqual({ state: "required", permitted: false });
    expect(readAccount({ account: { type: "chatgpt", email: "a@b.c", planType: "pro" }, requiresOpenaiAuth: true })).toEqual({
      state: "authenticated",
      kind: "subscription",
      permitted: true,
    });
    expect(readAccount({ account: { type: "apiKey" } })).toEqual({ state: "authenticated", permitted: false });
    // A sign-in Hubble does not recognise is signed in — and not used.
    expect(readAccount({ account: { type: "something-new" } })).toEqual({ state: "authenticated", permitted: false });
    expect(readAccount({ account: { type: 7 } })).toEqual({ state: "unknown", permitted: false });
    expect(readAccount(undefined)).toEqual({ state: "unknown", permitted: false });
    // No auth needed at all (a custom provider) is not "signed in".
    expect(readAccount({ account: null, requiresOpenaiAuth: false })).toEqual({ state: "unknown", permitted: false });
  });

  it("accepts only the exact asking settings", () => {
    const asking = { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } };
    expect(isAskingSettings(asking)).toBe(true);
    for (const patch of [
      { approvalPolicy: "on-request" },
      { approvalPolicy: { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } } },
      { approvalPolicy: "never" },
      { approvalsReviewer: "auto_review" },
      { approvalsReviewer: "guardian_subagent" },
      { sandbox: { type: "workspaceWrite" } },
      { sandbox: { type: "dangerFullAccess" } },
      { sandbox: undefined },
    ]) {
      expect(isAskingSettings({ ...asking, ...patch })).toBe(false);
    }
  });

  it("builds thread/start with the asking settings, and the context server only when there is one", () => {
    const plain = threadStartParams({ cwd: "C:/p" });
    expect(plain).toEqual({ cwd: "C:/p", approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only", ephemeral: true });
    const withContext = threadStartParams({ cwd: "C:/p", sessionServer: { name: "tabdump_abcdefghijklmnop", url: "http://127.0.0.1:1/mcp", token: "t" } });
    expect(JSON.stringify(withContext)).toContain('"default_tools_approval_mode":"prompt"');
  });

  it("reads a command approval with its complete command, or refuses it", () => {
    const params = {
      kind: "command", threadId: "t", turnId: "u", itemId: "i", startedAtMs: 1, environmentId: "local",
      command: "powershell.exe -Command 'ls'", cwd: "C:/p",
    };
    expect(readCommandApproval(params)).toEqual({ threadId: "t", itemId: "i", kind: "command", command: "powershell.exe -Command 'ls'", cwd: "C:/p" });
    expect(readCommandApproval({ ...params, kind: "writeStdin" })?.kind).toBe("writeStdin");
    expect(readCommandApproval({ ...params, kind: "other" })).toBeUndefined();
    expect(readCommandApproval({ ...params, command: undefined })).toBeUndefined();
    expect(readCommandApproval({ ...params, networkApprovalContext: { host: "x" } })).toBeUndefined();
  });

  it("recognises an MCP tool-call elicitation only by Codex's own marker", () => {
    const params = { threadId: "t", turnId: null, serverName: "s", mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" }, message: "", requestedSchema: {} };
    expect(readToolCallElicitation(params)).toEqual({ threadId: "t", serverName: "s" });
    expect(readToolCallElicitation({ ...params, _meta: null })).toBeUndefined();
    expect(readToolCallElicitation({ ...params, mode: "url" })).toBeUndefined();
  });

  it("reads items and a turn's end, including an unauthorized failure", () => {
    expect(readItemNotification({ threadId: "t", turnId: "u", item: { type: "commandExecution", id: "c", status: "declined" } })?.item).toEqual({
      type: "commandExecution", id: "c", status: "declined",
    });
    expect(readItemNotification({ threadId: "t", item: { type: "fileChange", id: "f", changes: "bad" } })).toBeUndefined();
    expect(readTurnCompleted({ threadId: "t", turn: { id: "u", status: "failed", error: { codexErrorInfo: "unauthorized" } } })?.unauthorized).toBe(true);
    expect(
      readTurnCompleted({ threadId: "t", turn: { id: "u", status: "failed", error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } } } })?.unauthorized
    ).toBe(true);
    expect(readTurnCompleted({ threadId: "t", turn: { id: "u", status: "inProgress" } })).toBeUndefined();
  });
});
