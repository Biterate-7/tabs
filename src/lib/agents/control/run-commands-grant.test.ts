import { describe, expect, it } from "vitest";
import { createControlService } from "./service";
import { AGENT_PERMISSION_SCOPES, createGrant, isGranted } from "./permissions";
import { createProject } from "./projects";
import { createCodexControlAdapter } from "./providers/codex-app-server/adapter";
import { commandApproval, createFakeCodex } from "./providers/codex-app-server/__fixtures__/fake-codex";
import { approveAgent, grantWithinApproval, identityFor, projectScopesForAgent } from "@/lib/agents/platform/roster";
import { DEFAULT_PROJECT_SCOPES } from "@/hooks/use-agent-projects";
import type { AgentControlEvent } from "./events";
import type { AgentPermissionScope } from "./permissions";
import type { AgentProject } from "./projects";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * Run commands, from the folder a person authorizes to the command it lets run.
 *
 * QA found the gap: approving Codex for "Run commands" in Connect Agent and
 * then authorizing a folder from New session produced a project without
 * `run_commands`, so every command was declined without asking. The folder
 * now carries exactly what the agent was approved for — and a grant is still
 * only permission to *ask*: each command goes to the person, whole, and a
 * denial stops it.
 */

const T0 = 1_700_000_000_000;
const ALLOW = () => ({ allowed: true as const, kind: "local-server" as const });

/** The roster after Connect Agent, with the scopes the person ticked. */
function approved(provider: AgentProviderId, scopes: AgentPermissionScope[]) {
  return identityFor(approveAgent({ version: 1, agents: [] }, { provider, name: provider, scopes, now: T0 }), provider);
}

/** A folder authorized from New session, as the Command Centre builds it. */
function folder(id: string, path: string, provider: AgentProviderId, scopes: readonly AgentPermissionScope[]): AgentProject {
  const grant = createGrant(scopes, T0, id);
  if (!grant) throw new Error("grant fixture failed");
  const made = createProject({ id, name: id, path, providers: [provider], permissions: grant }, T0);
  if (!made.ok) throw new Error(`project fixture failed: ${made.reason}`);
  return made.project;
}

describe("the folder grant follows the Connect Agent approval", () => {
  it("carries Run commands when the person approved it for the agent", () => {
    const codex = approved("openai-codex", ["read_workspace", "read_project", "run_commands"]);
    expect(projectScopesForAgent(codex)).toEqual(["read_workspace", "read_project", "run_commands"]);
  });

  it("does not carry Run commands when the person did not — Connect Agent has it off by default", () => {
    const codex = approved("openai-codex", ["read_workspace", "read_project", "write_project"]);
    expect(projectScopesForAgent(codex)).not.toContain("run_commands");
  });

  it("grants nothing to an agent that was never approved", () => {
    expect(projectScopesForAgent(undefined)).toEqual([]);
  });

  it("never carries an unrelated scope, even one the agent was approved for", () => {
    const everything = approved("openai-codex", [...AGENT_PERMISSION_SCOPES]);
    const scopes = projectScopesForAgent(everything);
    expect(scopes).not.toContain("network_access");
    expect(scopes).not.toContain("mcp_tools");
    // And never more than the approval: the session gate's own check agrees.
    expect(grantWithinApproval(everything!, scopes)).toBe(true);
  });

  it("is a valid grant bound to the one folder, for the one agent", () => {
    const codex = approved("openai-codex", ["read_workspace", "read_project", "run_commands"]);
    const project = folder("p1", "C:/work/research", "openai-codex", projectScopesForAgent(codex));
    expect(project.providers).toEqual(["openai-codex"]);
    expect(project.permissions.projectId).toBe("p1");
    expect(isGranted(project.permissions, "run_commands", "p1")).toBe(true);
  });

  it("keeps Run commands out of the fallback a caller gets without naming scopes", () => {
    expect(DEFAULT_PROJECT_SCOPES).not.toContain("run_commands");
  });
});

describe("a Run commands grant is permission to ask, in one folder only", () => {
  function harness(projects: AgentProject[]) {
    const codex = createFakeCodex({
      "turn/start": (_params, ctx) => {
        void ctx
          .ask("item/commandExecution/requestApproval", commandApproval("call_1"))
          .then((reply) => replies.push((reply.result as { decision?: string }).decision ?? "none"));
        return { turn: { id: "turn-1", items: [], status: "inProgress", error: null } };
      },
    });
    const replies: string[] = [];
    let id = 0;
    const adapter = createCodexControlAdapter({
      provider: "openai-codex",
      launch: codex.launcher,
      login: async () => "completed",
      loginMethods: [{ id: "chatgpt", name: "Sign in with ChatGPT" }],
      platformVerified: true,
      minimumVersion: "0.159.0",
      now: () => T0,
      createId: () => `x-${++id}`,
    });
    let counter = 0;
    const service = createControlService({
      runtime: ALLOW,
      resolveAdapter: (provider) => (provider === "openai-codex" ? adapter : undefined),
      resolveProject: (projectId) => projects.find((project) => project.id === projectId),
      now: () => T0,
      createId: () => `s${++counter}`,
    });
    const events: AgentControlEvent[] = [];
    service.subscribe((event) => events.push(event));

    async function commandIn(projectId: string) {
      const project = projects.find((candidate) => candidate.id === projectId)!;
      const started = await service.startSession({
        provider: "openai-codex",
        projectId,
        // What the runtime host does: the grant is the project's, never the caller's.
        permissions: project.permissions,
      });
      if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
      await service.sendMessage({ sessionId: started.value.id, text: "run it", context: { attachments: [] } });
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      return started.value.id;
    }

    return { codex, service, events, replies, commandIn };
  }

  const codexApproval = approved("openai-codex", ["read_workspace", "read_project", "run_commands"]);
  const granted = () => folder("p1", "C:/work/research", "openai-codex", projectScopesForAgent(codexApproval));
  const readOnly = () => folder("p2", "C:/work/other", "openai-codex", ["read_workspace", "read_project"]);

  it("still asks the person before any command runs — the whole command, on the card", async () => {
    const h = harness([granted()]);
    const sessionId = await h.commandIn("p1");

    const open = h.service.approvals.forSession(sessionId).filter((approval) => approval.status === "requested");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ action: "run_command", scope: "run_commands", projectId: "p1" });
    expect(open[0].command?.commandLine).toContain("Get-Content notes.txt");
    // Codex has been told nothing yet, and nothing has started.
    expect(h.replies).toEqual([]);
    expect(h.events.some((event) => event.kind === "command_started")).toBe(false);
    expect(h.service.session(sessionId)?.status).toBe("waiting_for_approval");
  });

  it("runs only after the person approves", async () => {
    const h = harness([granted()]);
    const sessionId = await h.commandIn("p1");
    const [approval] = h.service.approvals.forSession(sessionId);
    await h.service.respondToApproval(approval.id, "granted");
    expect(h.replies).toEqual(["accept"]);
    expect(h.events.some((event) => event.kind === "command_started")).toBe(true);
  });

  it("a denial still blocks the command", async () => {
    const h = harness([granted()]);
    const sessionId = await h.commandIn("p1");
    const [approval] = h.service.approvals.forSession(sessionId);
    await h.service.respondToApproval(approval.id, "denied");
    expect(h.replies).toEqual(["decline"]);
    expect(h.events.some((event) => event.kind === "command_started")).toBe(false);
    expect(h.service.session(sessionId)?.status).toBe("running");
  });

  it("does not reach another folder: a session there is declined without asking anyone", async () => {
    const h = harness([granted(), readOnly()]);
    const sessionId = await h.commandIn("p2");
    expect(h.replies).toEqual(["decline"]);
    expect(h.service.approvals.forSession(sessionId)).toHaveLength(0);
    // The grant itself names its folder.
    expect(isGranted(granted().permissions, "run_commands", "p2")).toBe(false);
  });

  it("does not reach another agent: the folder was authorized for Codex alone", async () => {
    const h = harness([granted()]);
    const claude = await h.service.startSession({
      provider: "claude-code",
      projectId: "p1",
      permissions: granted().permissions,
    });
    expect(claude.ok).toBe(false);
  });

  it("refuses a project that was never authorized, before Codex is launched", async () => {
    const h = harness([granted()]);
    const started = await h.service.startSession({
      provider: "openai-codex",
      projectId: "p-unknown",
      permissions: granted().permissions,
    });
    expect(started).toMatchObject({ ok: false, error: { code: "project-denied" } });
    expect(h.codex.launches).toHaveLength(0);
  });
});
