import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createClaudeCredentialAdapter } from "./providers/claude";
import { createCredentialService, resolveCredential } from "./service";
import { createMemoryConnectionStore } from "./store";
import {
  createAesCipher,
  createCredentialStore,
  createMemorySecretRows,
  generateCredentialKey,
} from "./secret-store";
import {
  credentialSupportFor,
  credentialSupportTable,
  registerCredentialAdapter,
  resetCredentialAdapters,
} from "./registry";
import { AGENT_CONTEXT_KINDS } from "@/lib/agents/control/context";
import { LEAK_CANARY } from "./__fixtures__/source";
import type { CredentialService } from "./service";
import type { CredentialStore } from "./secret-store";
import type { ConnectionStore } from "./store";

/**
 * The guard suite for user-owned provider credentials.
 *
 * Four things are asserted here, and each of them is a claim the rest of the
 * phase's documentation makes:
 *
 *   1. **A credential never leaves the server** — §14, by sweeping every
 *      serialized output for a distinctive canary.
 *   2. **One user's credential is unreachable from another** — §13, by trying.
 *   3. **There is no fallback to a deployment-wide key** — §6, by source
 *      inspection, because the absence of a code path cannot be tested by
 *      exercising one.
 *   4. **The registry does not overclaim** — §20.
 */

const DIR = path.resolve(__dirname);
const REPO_ROOT = path.resolve(DIR, "../../../..");
const SRC = path.resolve(REPO_ROOT, "src");

const ALICE = "account:alice";
const BOB = "account:bob";

const ALICE_KEY = `${LEAK_CANARY}-alice-aaaaaaaa`;
const BOB_KEY = `${LEAK_CANARY}-bob-bbbbbbbbbb`;

/* ------------------------------------------------------------------ *
 * Source sweeping
 * ------------------------------------------------------------------ */

function walk(dir: string, skipFixtures = true): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (skipFixtures && entry === "__fixtures__") return [];
      if (entry === "node_modules") return [];
      return walk(full, skipFixtures);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Strips comment lines, so prose about a forbidden pattern is not an offence. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const credentialSources = walk(DIR).map((file) => ({
  file: path.relative(REPO_ROOT, file),
  name: path.basename(file),
  source: readFileSync(file, "utf8"),
}));

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function fakeAnthropic() {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-api-key") ?? "";
    // Every canary-shaped key is accepted, so a test can connect two users
    // without caring which is which.
    return new Response("{}", { status: key.startsWith("sk-ant-") ? 200 : 401 });
  }) as typeof fetch;
}

describe("provider credential security", () => {
  let connections: ConnectionStore;
  let secrets: CredentialStore;
  let service: CredentialService;

  beforeEach(() => {
    resetCredentialAdapters();
    registerCredentialAdapter(createClaudeCredentialAdapter({ fetchImpl: fakeAnthropic() }));

    connections = createMemoryConnectionStore();
    secrets = createCredentialStore(
      createMemorySecretRows(),
      createAesCipher(Buffer.from(generateCredentialKey(), "base64"))
    );
    service = createCredentialService({ connections, secrets });
  });

  async function connect(ownerId: string, secret: string) {
    const outcome = await service.connect({
      ownerId,
      provider: "claude-code",
      authMethod: "api_key",
      secret,
      displayName: "Key",
    });
    if (!outcome.ok) throw new Error(`fixture failed to connect ${ownerId}`);
    return outcome.connection;
  }

  /* ---------------------------------------------------------------- *
   * §14 — leakage
   * ---------------------------------------------------------------- */

  describe("the credential never appears in anything a client can read", () => {
    it("is absent from every value the service returns", async () => {
      const connected = await connect(ALICE, ALICE_KEY);
      const listed = await service.list(ALICE);
      const fetched = await service.get(ALICE, connected.id);
      const rotated = await service.rotate({
        ownerId: ALICE,
        connectionId: connected.id,
        secret: BOB_KEY,
      });
      const revalidated = await service.revalidate(ALICE, connected.id);

      // Serialized, because JSON is the form these cross the network in — and
      // a field that is `undefined` in an object is absent from its JSON,
      // which is exactly the difference that matters.
      const surface = JSON.stringify({ connected, listed, fetched, rotated, revalidated });

      expect(surface).not.toContain(LEAK_CANARY);
      expect(surface).not.toContain(ALICE_KEY);
      expect(surface).not.toContain(BOB_KEY);
    });

    it("is absent from a failed validation's error", async () => {
      const outcome = await service.connect({
        ownerId: ALICE,
        provider: "claude-code",
        authMethod: "api_key",
        // Rejected by shape, so the message is the one most likely to have
        // been written by interpolating the input.
        secret: `${LEAK_CANARY}-but-malformed !!`,
      });

      expect(outcome.ok).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(LEAK_CANARY);
    });

    it("is absent from the connection view even when the store holds it", async () => {
      const connected = await connect(ALICE, ALICE_KEY);

      // The secret is genuinely there — this is not passing because nothing
      // was stored.
      expect(await secrets.reveal(connected.id, ALICE)).toBe(ALICE_KEY);

      const view = await service.get(ALICE, connected.id);
      expect(Object.keys(view ?? {}).sort()).toEqual([
        "authMethod",
        "createdAt",
        "displayName",
        "id",
        "lastValidatedAt",
        "provider",
        "status",
        "updatedAt",
      ]);
      // No owner either. A client has no use for an id it cannot act on, and
      // every reason not to learn the shape of somebody else's.
      expect(JSON.stringify(view)).not.toContain(ALICE);
    });

    it("is absent from the stored row itself", async () => {
      const connected = await connect(ALICE, ALICE_KEY);
      const rows = await connections.list(ALICE);

      // The connection table is read constantly. If a credential were on it,
      // one `SELECT *` in a support session would be the whole breach.
      expect(JSON.stringify(rows)).not.toContain(LEAK_CANARY);
      expect(rows[0]?.id).toBe(connected.id);
    });

    it("is absent from a resolved credential's own serialization, except in the runtime env", async () => {
      await connect(ALICE, ALICE_KEY);
      const resolved = await resolveCredential({ connections, secrets }, ALICE, "claude-code");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      // The one object in the system that legitimately holds a credential
      // holds it in exactly one place, under exactly one key.
      const { env, ...rest } = resolved.credential;
      expect(JSON.stringify(rest)).not.toContain(LEAK_CANARY);
      expect(Object.keys(env)).toEqual(["ANTHROPIC_API_KEY"]);
    });
  });

  /* ---------------------------------------------------------------- *
   * §13 — multi-user isolation
   * ---------------------------------------------------------------- */

  describe("one user cannot reach another's connection", () => {
    it("does not list it", async () => {
      await connect(ALICE, ALICE_KEY);
      expect(await service.list(BOB)).toEqual([]);
    });

    it("does not return it by id, even the correct id", async () => {
      const alice = await connect(ALICE, ALICE_KEY);
      // Bob knows the id. Guessing one is the only work an attacker has to do,
      // so the interesting case is the one where they already have it.
      expect(await service.get(BOB, alice.id)).toBeUndefined();
    });

    it("does not resolve it into a runtime credential", async () => {
      await connect(ALICE, ALICE_KEY);
      const resolved = await resolveCredential({ connections, secrets }, BOB, "claude-code");
      expect(resolved).toEqual({ ok: false, reason: "not_connected" });
    });

    it("does not rotate it", async () => {
      const alice = await connect(ALICE, ALICE_KEY);
      const outcome = await service.rotate({
        ownerId: BOB,
        connectionId: alice.id,
        secret: BOB_KEY,
      });

      expect(outcome.ok).toBe(false);
      expect(await secrets.reveal(alice.id, ALICE)).toBe(ALICE_KEY);
    });

    it("does not disconnect it", async () => {
      const alice = await connect(ALICE, ALICE_KEY);
      expect(await service.disconnect(BOB, alice.id)).toEqual({ ok: false });
      expect(await secrets.reveal(alice.id, ALICE)).toBe(ALICE_KEY);
    });

    it("does not revalidate it, which would otherwise spend the owner's quota", async () => {
      const alice = await connect(ALICE, ALICE_KEY);
      const outcome = await service.revalidate(BOB, alice.id);
      expect(outcome.ok).toBe(false);
    });

    it("keeps two users' credentials distinct end to end", async () => {
      await connect(ALICE, ALICE_KEY);
      await connect(BOB, BOB_KEY);

      const forAlice = await resolveCredential({ connections, secrets }, ALICE, "claude-code");
      const forBob = await resolveCredential({ connections, secrets }, BOB, "claude-code");

      expect(forAlice.ok === true && forAlice.credential.env.ANTHROPIC_API_KEY).toBe(ALICE_KEY);
      expect(forBob.ok === true && forBob.credential.env.ANTHROPIC_API_KEY).toBe(BOB_KEY);
      expect(forAlice.ok === true && forBob.ok === true && forAlice.credential.connectionId).not.toBe(
        forBob.ok === true ? forBob.credential.connectionId : ""
      );
    });
  });

  /* ---------------------------------------------------------------- *
   * §6 — no fallback
   * ---------------------------------------------------------------- */

  describe("there is no fallback to a deployment-wide credential", () => {
    it("refuses rather than resolving anything when the user has no connection", async () => {
      const resolved = await resolveCredential({ connections, secrets }, ALICE, "claude-code");
      // Not a key from somewhere else. The forbidden edge —
      // "user credential unavailable → global Anthropic key" — has no
      // expression here.
      expect(resolved).toEqual({ ok: false, reason: "not_connected" });
    });

    it("names no environment fallback anywhere in the credential layer", () => {
      const offenders: string[] = [];
      for (const { file, source } of credentialSources) {
        const code = codeOf(source);
        for (const pattern of [
          /process\.env\.ANTHROPIC/,
          /process\.env\[[^\]]*ANTHROPIC/,
          // The shape a fallback takes: a resolution, then `??` onto an
          // environment read.
          /\?\?\s*process\.env/,
        ]) {
          if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
        }
      }

      expect(offenders).toEqual([]);
    });

    it("reads no provider key from the environment anywhere under src/lib", () => {
      // The repository-wide version of the same claim. The only permitted
      // reader is the integration fixture, which is a developer's own key for
      // a developer's own opt-in suite — category C in
      // docs/provider-credential-audit.md.
      const ALLOWED = path.join("credentials", "__fixtures__", "source.ts");

      const offenders: string[] = [];
      for (const file of walk(path.join(SRC, "lib"), false)) {
        const relative = path.relative(REPO_ROOT, file);
        if (relative.includes(ALLOWED)) continue;

        const code = codeOf(readFileSync(file, "utf8"));
        if (/process\.env\.ANTHROPIC/.test(code) || /process\.env\[[^\]]*ANTHROPIC/.test(code)) {
          offenders.push(relative);
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- *
   * §17 — credentials are not context
   * ---------------------------------------------------------------- */

  describe("credentials and context stay separate", () => {
    it("has no credential-shaped context kind", () => {
      // The attachment union is closed, so this is a real guarantee rather
      // than a check somebody has to remember at each new call site.
      for (const kind of AGENT_CONTEXT_KINDS) {
        expect(kind).not.toMatch(/credential|secret|key|token/i);
      }
    });

    it("is not importable from the context layer", () => {
      // An agent must not be able to ask for its own credential through the
      // thing that assembles what it is told.
      const contextDir = path.resolve(SRC, "lib/agents/context");
      for (const file of walk(contextDir, false)) {
        const code = codeOf(readFileSync(file, "utf8"));
        expect(code).not.toMatch(/from\s+["'].*credentials/);
      }
    });

    it("keeps the credential layer out of prompt assembly", () => {
      const promptFile = path.resolve(
        SRC,
        "lib/agents/control/providers/claude-code/context-prompt.ts"
      );
      const code = codeOf(readFileSync(promptFile, "utf8"));
      expect(code).not.toMatch(/credential/i);
      expect(code).not.toMatch(/ANTHROPIC/);
    });
  });

  /* ---------------------------------------------------------------- *
   * §20 — the registry does not overclaim
   * ---------------------------------------------------------------- */

  describe("the provider registry", () => {
    it("reports Claude as connectable by API key and nothing else", () => {
      const support = credentialSupportFor("claude-code");
      expect(support.kind).toBe("supported");
      expect(support.kind === "supported" && [...support.authMethods]).toEqual(["api_key"]);
    });

    it("reports every unimplemented provider as unsupported rather than inventing one", () => {
      const table = credentialSupportTable();

      // Codex, Gemini, Grok and Custom have connection *architecture* and no
      // adapter. A registration whose `validate` always succeeded would hand a
      // user a "Connected" badge for a credential nothing ever checked, which
      // is the fake the brief rules out.
      for (const provider of ["openai-codex", "gemini", "grok", "custom"] as const) {
        expect(table.get(provider)).toEqual({ kind: "unsupported" });
      }
    });

    it("offers no auth method an adapter does not implement", () => {
      // `workload_identity` and `official_oauth` exist in the type union so a
      // future adapter is an addition rather than a rewrite. Neither may be
      // offered until something implements it.
      const support = credentialSupportFor("claude-code");
      expect(support.kind === "supported" && support.authMethods).not.toContain("official_oauth");
      expect(support.kind === "supported" && support.authMethods).not.toContain("workload_identity");
    });
  });

  /* ---------------------------------------------------------------- *
   * Structural rules about this layer's own source
   * ---------------------------------------------------------------- */

  describe("the credential layer's own shape", () => {
    it("writes no secret to browser storage, a log, or an analytics call", () => {
      const offenders: string[] = [];
      for (const { file, source } of credentialSources) {
        const code = codeOf(source);
        for (const forbidden of [
          "localStorage",
          "sessionStorage",
          "indexedDB",
          "console.log",
          "console.error",
          "console.warn",
          "document.cookie",
        ]) {
          if (code.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
        }
      }

      expect(offenders).toEqual([]);
    });

    it("confines plaintext reads to the resolver", () => {
      // `reveal` is the only function that produces a credential. One caller
      // is what makes "where could this have leaked from?" a question with one
      // answer.
      const callers = credentialSources.filter(
        ({ name, source }) =>
          name !== "secret-store.ts" && /\.reveal\(/.test(codeOf(source))
      );

      expect(callers.map((entry) => entry.name).sort()).toEqual(["service.ts"]);
    });

    it("never stores a credential in the browser's session-credential module", () => {
      // That module is observation-only and lives in the browser. A credential
      // that can drive an agent must not be there — see category D2 in
      // docs/provider-credential-audit.md.
      for (const { file, source } of credentialSources) {
        expect(codeOf(source), file).not.toMatch(/session-credentials/);
      }
    });

    it("exposes no client-reachable path to the validator", () => {
      // The adapter stays on the server: a browser bundle that could call
      // `validate` would be a browser bundle that could be pointed at a
      // different provider URL with somebody's key.
      const hookSource = readFileSync(
        path.resolve(SRC, "hooks/use-provider-connections.ts"),
        "utf8"
      );
      const code = codeOf(hookSource);

      expect(code).not.toMatch(/from\s+["'].*credentials\/(registry|service|providers)/);
      expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      // The one endpoint it may talk to.
      expect(code).toContain("/api/agents/provider-connections");
    });
  });
});
