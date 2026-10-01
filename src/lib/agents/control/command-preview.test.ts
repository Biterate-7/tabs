import { describe, expect, it } from "vitest";
import { createApprovalBroker } from "./approvals";
import { MAX_COMMAND_LINE_LENGTH, readCommandPreview, visibleCommandText } from "./command-preview";

const T0 = 1_700_000_000_000;

const COMMAND = {
  commandLine: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'Get-Content notes.txt'",
  workingDirectory: ".",
  insideProject: true,
};

describe("a command preview", () => {
  it("reads a well-formed preview exactly — program, arguments, paths and working directory", () => {
    expect(readCommandPreview(COMMAND)).toEqual(COMMAND);
    expect(readCommandPreview({ ...COMMAND, network: { host: "example.com", protocol: "https" } })?.network).toEqual({
      host: "example.com",
      protocol: "https",
    });
  });

  it("refuses rather than truncates a command too long to show whole", () => {
    expect(readCommandPreview({ ...COMMAND, commandLine: "x".repeat(MAX_COMMAND_LINE_LENGTH) })).toBeDefined();
    expect(readCommandPreview({ ...COMMAND, commandLine: "x".repeat(MAX_COMMAND_LINE_LENGTH + 1) })).toBeUndefined();
  });

  it("refuses anything malformed", () => {
    for (const bad of [
      null,
      "cmd",
      [],
      { ...COMMAND, commandLine: "" },
      { ...COMMAND, commandLine: 42 },
      { ...COMMAND, workingDirectory: "" },
      { ...COMMAND, insideProject: "yes" },
      { ...COMMAND, network: { host: "example.com" } },
      { ...COMMAND, network: "example.com" },
    ]) {
      expect(readCommandPreview(bad)).toBeUndefined();
    }
  });

  it("makes every hidden character visible, so the text shown is the text that runs", () => {
    // A right-to-left override would display `rm -rf` reversed; a NUL or a
    // zero-width space would hide between visible characters.
    const shown = visibleCommandText("echo safe\u202Efdp.exe\u0000\u200B done");
    expect(shown).toBe("echo safe\\u{202e}fdp.exe\\u{0}\\u{200b} done");
    // Line breaks and tabs are the script's own structure, and stay.
    expect(visibleCommandText("a\r\n\tb")).toBe("a\n\tb");
  });
});

describe("the broker and a command", () => {
  const base = {
    id: "a1",
    sessionId: "s1",
    provider: "openai-codex" as const,
    action: "run_command" as const,
    scope: "run_commands" as const,
    projectId: "p1",
    targets: ["Command"],
  };

  it("records the complete command on a run_command approval", () => {
    const made = createApprovalBroker().request({ ...base, command: COMMAND }, T0);
    expect(made.ok).toBe(true);
    if (made.ok) expect(made.approval.command).toEqual(COMMAND);
  });

  it("refuses the approval — not just the preview — when the command cannot be shown whole", () => {
    const made = createApprovalBroker().request(
      { ...base, command: { ...COMMAND, commandLine: "y".repeat(MAX_COMMAND_LINE_LENGTH + 1) } },
      T0
    );
    expect(made).toEqual({ ok: false, reason: "invalid-command" });
  });

  it("refuses a command on an action that runs no command", () => {
    const made = createApprovalBroker().request(
      { ...base, action: "modify_files", scope: "write_project", targets: ["a.txt"], command: COMMAND },
      T0
    );
    expect(made).toEqual({ ok: false, reason: "invalid-command" });
  });
});
