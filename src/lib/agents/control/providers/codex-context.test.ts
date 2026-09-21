import { describe, expect, it } from "vitest";
import { createCodexControlAdapter } from "./codex";
import { createControlService } from "../service";
import { createGrant } from "../permissions";
import type { AgentAttachedContext } from "../context";

/**
 * Codex and context.
 *
 * ## What this suite can and cannot claim
 *
 * The Codex *control* adapter in this repository is the honest
 * unimplemented one: it declares no capability and refuses every
 * operation. So these tests do not prove that context reaches a running
 * Codex — nothing here can, and claiming otherwise would be the fabricated
 * capability the whole control plane is built to make impossible.
 *
 * What they do prove is the property that actually matters for this phase:
 * **attaching context cannot turn a provider that may do nothing into one
 * that may do something.** That is a claim about the seam, it is checkable
 * today, and it stays true whichever way the Codex runtime is eventually
 * built.
 *
 * The canonical context model is provider-neutral, so when a real Codex
 * adapter arrives it consumes the same `AgentContextAttachment` list the
 * Claude adapter does, through the same `CreateSessionRequest.attachments`
 * field. No second context model is needed, and none should be added.
 */

const T0 = 1_700_000_000_000;

const CONTEXT: AgentAttachedContext = {
  snapshotId: "snap-1",
  capturedAt: T0,
  attachments: [
    { kind: "workspace", id: "ws-a", label: "Research" },
    { kind: "project", id: "p1", label: "API service", detail: "C:/work/api" },
    { kind: "tab", id: "a1", label: "Deployment guide", detail: "https://docs.example.com" },
  ],
};

describe("context cannot widen Codex", () => {
  it("declares the same empty capability set with context attached", () => {
    const adapter = createCodexControlAdapter();
    expect([...adapter.getCapabilities()]).toEqual([]);
  });

  it("refuses to start a session however much context is supplied", async () => {
    const adapter = createCodexControlAdapter();
    const service = createControlService({
      runtime: () => ({ allowed: true, kind: "local-desktop" }),
      resolveAdapter: () => adapter,
    });

    const started = await service.startSession({
      provider: "openai-codex",
      context: CONTEXT,
      permissions: createGrant(["read_workspace"], T0) ?? undefined,
    });

    expect(started).toEqual({
      ok: false,
      error: { code: "unsupported", message: expect.any(String) },
    });
  });

  it("gains no write, command, MCP or approval capability from a project attachment", async () => {
    const adapter = createCodexControlAdapter();

    // Directly, bypassing the service's gate entirely — so this is a claim
    // about the adapter, not about the layer in front of it.
    const created = await adapter.createSession({
      sessionId: "s1",
      permissions: { scopes: [], grantedAt: T0 },
      attachments: CONTEXT.attachments,
    });

    expect(created).toEqual({
      ok: false,
      error: { code: "unsupported", message: expect.any(String) },
    });

    for (const capability of ["write_files", "run_commands", "mcp", "approvals"] as const) {
      expect(adapter.getCapabilities().has(capability)).toBe(false);
    }
  });

  it("emits no event, so context cannot produce fabricated Codex activity", () => {
    const adapter = createCodexControlAdapter();
    const seen: unknown[] = [];
    adapter.subscribeToEvents((event) => seen.push(event));

    return adapter
      .createSession({
        sessionId: "s1",
        permissions: { scopes: [], grantedAt: T0 },
        attachments: CONTEXT.attachments,
      })
      .then(() => {
        expect(seen).toEqual([]);
      });
  });
});
