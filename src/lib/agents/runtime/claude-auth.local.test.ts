import { describe, expect, it } from "vitest";
import { createDesktopRuntime } from "./desktop";
import type { RuntimeCommand } from "./protocol";

/**
 * Opt-in: the desktop runtime against the **real** installed Claude Code CLI
 * (Agent Authentication & Runtime).
 *
 *   TABDUMP_CLAUDE_AUTH_LOCAL=1 npx vitest run src/lib/agents/runtime/claude-auth.local.test.ts
 *
 * Runs only `claude auth status` — the CLI's own machine-readable status,
 * through the production launcher and allowlisted environment. Starts no
 * session, signs nothing in or out, and reads no credential file. Asserts
 * that whatever the machine's login is, Hubble reports it as closed values
 * only, and refuses a Claude subscription login.
 */

const ENABLED = process.env.TABDUMP_CLAUDE_AUTH_LOCAL === "1";
const describeLocal = ENABLED ? describe : describe.skip;

describeLocal("the real Claude Code login, as Hubble sees it", () => {
  it("reports which kind of login is in use, refuses a subscription, and leaks no account detail", async () => {
    const runtime = createDesktopRuntime({ env: process.env, runtimeId: "local-claude-auth" });
    const send = (command: RuntimeCommand) => runtime.handle({ runtimeId: "local-claude-auth", command });
    try {
      const connected = (await send({ name: "connect_provider", provider: "claude-code" })) as {
        ok: boolean;
        value?: Record<string, unknown>;
      };
      expect(connected.ok).toBe(true);
      const view = connected.value!;
      // Only closed values: what a UI may hold.
      console.log(
        "claude-code:",
        JSON.stringify({
          connection: view.connection,
          authentication: view.authentication,
          authKind: view.authKind,
          authIssue: view.authIssue,
          authMethods: view.authMethods,
        })
      );

      expect(view.authMethods).toEqual([{ id: "console", name: "Sign in with Anthropic Console" }]);
      if (view.authKind === "subscription") {
        expect(view.authentication).toBe("authenticated");
        expect(view.authIssue).toBe("method_not_permitted");
        // Refused before anything starts.
        expect(await send({ name: "create_session", provider: "claude-code" })).toMatchObject({
          ok: false,
          error: { code: "authentication_required" },
        });
      } else if (view.authentication === "authenticated") {
        expect(view.authIssue).toBeUndefined();
      }
      // Nothing the CLI printed about the account reaches a reply.
      expect(JSON.stringify(connected)).not.toMatch(/@|orgId|orgName|subscriptionType|claude\.ai/);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});
