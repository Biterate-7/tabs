import { describe, expect, it } from "vitest";
import {
  MAX_AUTHORIZED_PROJECTS,
  MAX_COMMAND_TEXT_LENGTH,
  parseRuntimeCommand,
  parseRuntimeRequest,
  RUNTIME_COMMAND_NAMES,
  RUNTIME_ERROR_CODES,
  runtimeError,
} from "./protocol";

const T0 = 1_700_000_000_000;

/**
 * The wire contract.
 *
 * Everything reaching the parser is untrusted: it arrives on an HTTP body
 * that anything on the machine can post to. The property under test is that a
 * body can only ever become one of a fixed list of verbs with checked fields,
 * and never an extra option on a provider.
 */

describe("what the parser accepts", () => {
  it("reads every command it declares", () => {
    // A command name in the union with no parser case would be a verb that
    // exists in the types and cannot be sent. Every one is exercised.
    const bodies: Record<string, unknown> = {
      get_status: { name: "get_status" },
      list_sessions: { name: "list_sessions" },
      get_session: { name: "get_session", sessionId: "s1" },
      get_events: { name: "get_events", sessionId: "s1", afterSequence: 4 },
      authorize_projects: { name: "authorize_projects", projects: [] },
      create_session: { name: "create_session", provider: "claude-code" },
      resume_session: {
        name: "resume_session",
        provider: "claude-code",
        providerSessionId: "p1",
      },
      send_message: { name: "send_message", sessionId: "s1", text: "hello" },
      cancel_run: { name: "cancel_run", sessionId: "s1" },
      attach_context: {
        name: "attach_context",
        sessionId: "s1",
        context: { snapshotId: "snap", capturedAt: T0, attachments: [] },
      },
      detach_context: { name: "detach_context", sessionId: "s1" },
      respond_to_approval: {
        name: "respond_to_approval",
        approvalId: "a1",
        decision: "granted",
      },
      dispose_session: { name: "dispose_session", sessionId: "s1" },
      link_observation: {
        name: "link_observation",
        sessionId: "s1",
        observationAgentId: "agent",
        observationRunId: "run",
      },
      detect_providers: { name: "detect_providers" },
      connect_provider: { name: "connect_provider", provider: "gemini" },
      authenticate_provider: {
        name: "authenticate_provider",
        provider: "gemini",
        methodId: "oauth-personal",
      },
      disconnect_provider: { name: "disconnect_provider", provider: "gemini" },
    };

    for (const name of RUNTIME_COMMAND_NAMES) {
      expect(parseRuntimeCommand(bodies[name])).toMatchObject({ name });
    }
  });

  it("drops fields the union does not name", () => {
    // The whole reason there is a parser rather than a cast. An extra key must
    // not survive to become an extra option somewhere downstream.
    const parsed = parseRuntimeCommand({
      name: "create_session",
      provider: "claude-code",
      cwd: "C:/",
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash"],
      env: { SECRET: "x" },
    });

    expect(parsed).toEqual({ name: "create_session", provider: "claude-code" });
  });

  it("reads an envelope with and without a runtime id", () => {
    expect(parseRuntimeRequest({ command: { name: "get_status" } })).toEqual({
      command: { name: "get_status" },
    });
    expect(
      parseRuntimeRequest({ runtimeId: "r1", command: { name: "list_sessions" } })
    ).toEqual({ runtimeId: "r1", command: { name: "list_sessions" } });
  });
});

describe("what the parser refuses", () => {
  it("refuses a body that is not an object", () => {
    for (const body of [null, undefined, 4, "x", [], true]) {
      expect(parseRuntimeRequest(body)).toBeNull();
    }
  });

  it("refuses a verb it does not have", () => {
    for (const name of ["exec", "spawn", "shell", "readFile", "writeFile", "run", ""]) {
      expect(parseRuntimeCommand({ name })).toBeNull();
    }
  });

  it("refuses a missing or empty identifier", () => {
    expect(parseRuntimeCommand({ name: "get_session" })).toBeNull();
    expect(parseRuntimeCommand({ name: "get_session", sessionId: "   " })).toBeNull();
    expect(parseRuntimeCommand({ name: "get_session", sessionId: 7 })).toBeNull();
  });

  it("refuses an oversized identifier or message", () => {
    expect(parseRuntimeCommand({ name: "cancel_run", sessionId: "x".repeat(201) })).toBeNull();
    expect(
      parseRuntimeCommand({
        name: "send_message",
        sessionId: "s1",
        text: "x".repeat(MAX_COMMAND_TEXT_LENGTH + 1),
      })
    ).toBeNull();
  });

  it("refuses an empty message rather than sending a blank turn", () => {
    expect(parseRuntimeCommand({ name: "send_message", sessionId: "s1", text: "   " })).toBeNull();
  });

  it("refuses a provider that is not one TabDump knows", () => {
    expect(parseRuntimeCommand({ name: "create_session", provider: "anything" })).toBeNull();
    expect(parseRuntimeCommand({ name: "create_session" })).toBeNull();
  });

  it("refuses a decision that is neither yes nor no", () => {
    for (const decision of ["maybe", "", true, null, "allow"]) {
      expect(
        parseRuntimeCommand({ name: "respond_to_approval", approvalId: "a1", decision })
      ).toBeNull();
    }
  });

  it("refuses a cursor that is not a whole non-negative number", () => {
    for (const afterSequence of [-1, 1.5, "3", Number.NaN, Infinity]) {
      expect(parseRuntimeCommand({ name: "get_events", sessionId: "s1", afterSequence })).toBeNull();
    }
  });

  it("refuses a context that is not shaped like one", () => {
    for (const context of [
      null,
      {},
      { snapshotId: "s" },
      { snapshotId: "s", capturedAt: "now", attachments: [] },
      { snapshotId: "s", capturedAt: T0, attachments: "none" },
    ]) {
      expect(parseRuntimeCommand({ name: "attach_context", sessionId: "s1", context })).toBeNull();
    }
  });
});

describe("project records on the wire", () => {
  const good = {
    id: "p1",
    name: "Research",
    path: "C:/work/research",
    providers: ["claude-code"],
    permissions: { scopes: ["read_project"], projectId: "p1", grantedAt: T0 },
  };

  it("reads a well-formed record", () => {
    const parsed = parseRuntimeCommand({ name: "authorize_projects", projects: [good] });
    expect(parsed).toMatchObject({ name: "authorize_projects" });
  });

  it("refuses the whole command when one record is malformed", () => {
    // Half-applying would leave the runtime's idea of what is authorized
    // quietly different from the browser's.
    for (const bad of [
      { ...good, id: "" },
      { ...good, name: "  " },
      { ...good, path: 7 },
      { ...good, providers: ["not-a-provider"] },
      { ...good, permissions: undefined },
      { ...good, permissions: { scopes: "all", grantedAt: T0 } },
      { ...good, permissions: { scopes: [], grantedAt: "yesterday" } },
    ]) {
      expect(parseRuntimeCommand({ name: "authorize_projects", projects: [good, bad] })).toBeNull();
    }
  });

  it("refuses more projects than the store could hold", () => {
    const many = Array.from({ length: MAX_AUTHORIZED_PROJECTS + 1 }, (_, index) => ({
      ...good,
      id: `p${index}`,
      permissions: { scopes: ["read_project"], projectId: `p${index}`, grantedAt: T0 },
    }));

    expect(parseRuntimeCommand({ name: "authorize_projects", projects: many })).toBeNull();
  });

  it("does not judge the path itself", () => {
    // Deliberately: `validateProjectPath` owns that judgement, and duplicating
    // it here would give it two homes. The parser's job is shape.
    expect(
      parseRuntimeCommand({
        name: "authorize_projects",
        projects: [{ ...good, path: "C:/" }],
      })
    ).not.toBeNull();
  });
});

describe("errors", () => {
  it("has a message for every code", () => {
    for (const code of RUNTIME_ERROR_CODES) {
      const error = runtimeError(code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.code).toBe(code);
    }
  });

  it("takes a code and nothing else, so nothing can be interpolated in", () => {
    // The structural reason a provider cannot choose the sentence a user
    // reads: there is no argument into which its text could be put.
    expect(runtimeError.length).toBe(1);
  });

  it("names no machine detail in any message", () => {
    for (const code of RUNTIME_ERROR_CODES) {
      const message = runtimeError(code).message;
      for (const forbidden of [
        "TABDUMP_",
        "process.env",
        "localhost",
        "127.0.0.1",
        "C:/",
        "/home/",
        "node_modules",
        "claude ",
        "--",
      ]) {
        expect(message).not.toContain(forbidden);
      }
    }
  });
});
