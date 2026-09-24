// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where the session context credential may exist (Phase J.3) — as a guard on
 * the source, so a later change cannot quietly widen it.
 *
 * The credential is minted by the registry, handed by the runtime host to the
 * control service, and by the service to the one adapter starting the agent.
 * That is the whole list. Nothing the webview runs, nothing the protocol
 * carries, and nothing that writes to storage or a log may name it.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SRC = path.join(REPO_ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__fixtures__" ? [] : walk(full);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
const code = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

/** Anything that names the credential itself or the entry that carries it. */
const CREDENTIAL = /tdctx_|TABDUMP_CONTEXT_TOKEN|CONTEXT_TOKEN_(PREFIX|ENV)|\bcontextServer\b|SessionContextServerEntry/;

const ALLOWED = new Set([
  "src/lib/agents/session-context/registry.ts",
  "src/lib/agents/runtime/host.ts",
  "src/lib/agents/runtime/server.ts",
  "src/lib/agents/runtime/desktop.ts",
  "src/lib/agents/control/types.ts",
  "src/lib/agents/control/service.ts",
  "src/lib/agents/control/providers/acp/adapter.ts",
  "src/lib/agents/control/providers/claude-code/adapter.ts",
  "src/lib/agents/control/providers/claude-code/runtime.ts",
  "src/lib/agents/control/providers/claude-code/sdk-runtime.ts",
]);

describe("the session context credential stays inside the runtime", () => {
  it("is named only by the runtime modules that mint it and hand it to an agent", () => {
    const naming = walk(SRC)
      .filter((file) => CREDENTIAL.test(code(file)))
      .map(rel)
      .sort();
    // Exactly these — and each still does, so an allowance nothing needs is removed.
    expect(naming).toEqual([...ALLOWED].sort());
  });

  it("never reaches the webview: no component, hook, page or client names it", () => {
    const browser = [
      ...walk(path.join(SRC, "components")),
      ...walk(path.join(SRC, "hooks")),
      ...walk(path.join(SRC, "app")).filter((file) => !/route\.ts$/.test(file)),
      path.join(SRC, "lib/agents/runtime/client.ts"),
      path.join(SRC, "lib/agents/runtime/protocol.ts"),
      path.join(SRC, "lib/agents/runtime/desktop-protocol.ts"),
    ];
    const offenders = browser.filter((file) => CREDENTIAL.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("has no field in the session's context view — the shape the webview gets", () => {
    const protocol = code(path.join(SRC, "lib/agents/runtime/protocol.ts"));
    const view = protocol.match(/export type RuntimeSessionContextView = \{[\s\S]*?\n\};/)?.[0];
    expect(view).toBeDefined();
    const fields = [...view!.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
    expect(fields).toEqual(["workspaceId", "workspaceName", "capabilities", "pendingActions"]);
  });

  it("is never stored, logged or put in a URL by the modules that hold it", () => {
    for (const file of ALLOWED) {
      const source = code(path.join(REPO_ROOT, file));
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB|writeFile|appendFile/);
      expect(source, file).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(source, file).not.toMatch(/[?&](token|access_token|auth)=/);
    }
  });

  it("keeps only a hash of it in the registry", () => {
    const registry = code(path.join(SRC, "lib/agents/session-context/registry.ts"));
    // The raw token is set into no map and no object: only its hash is.
    expect(registry).toMatch(/credentials\.set\(hash,/);
    expect(registry).not.toMatch(/\.set\(token\b/);
    expect(registry).not.toMatch(/\btoken\s*,\s*\n?\s*(sessionId|workspaceId)/);
  });
});
