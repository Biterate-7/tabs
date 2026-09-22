import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSandboxService } from "@/lib/agents/remote/__fixtures__/sandbox";
import { createMemoryRemoteStore } from "@/lib/agents/remote/store";
import { createRemoteBindings } from "@/lib/agents/remote/bindings";
import { createRuntimeHost } from "@/lib/agents/runtime/host";
import { createClaudeCodeControlAdapter } from "@/lib/agents/control/providers/claude-code/adapter";
import {
  createRemoteClaudeRuntime,
  PROVIDER_CREDENTIAL_ENV_VAR,
} from "@/lib/agents/control/providers/claude-code/remote-runtime";
import { createClaudeCredentialAdapter } from "./providers/claude";
import { createCredentialService, resolveCredential } from "./service";
import { createMemoryConnectionStore } from "./store";
import {
  createAesCipher,
  createCredentialStore,
  createMemorySecretRows,
  generateCredentialKey,
} from "./secret-store";
import { registerCredentialAdapter, resetCredentialAdapters } from "./registry";
import type { ClaudeCredentialSource } from "@/lib/agents/control/providers/claude-code/runtime";
import type { FakeSandboxService } from "@/lib/agents/remote/__fixtures__/sandbox";
import type { RemoteStore } from "@/lib/agents/remote/store";
import type { RemoteProject } from "@/lib/agents/remote/types";
import type { ExecutionGateResult } from "@/lib/agents/runtime/gate";
import type { RuntimeActor, RuntimeHost } from "@/lib/agents/runtime/host";
import type { CredentialService } from "./service";
import type { CredentialStore } from "./secret-store";
import type { ConnectionStore } from "./store";

/**
 * §15 — two users, two credentials, one deployment.
 *
 * ## Why this is an end-to-end test rather than a unit one
 *
 * `security.test.ts` proves that the credential *service* keeps two users
 * apart. That is necessary and it is not the claim a user cares about. The
 * claim they care about is that when Alice and Bob each start a Claude session
 * on the same TabDump, Alice's agent runs on Alice's key — and the only way to
 * assert that is to watch what actually reaches the provider process.
 *
 * So this suite wires the real thing: a real credential store, a real Claude
 * credential adapter, the real resolver, the real runtime host, the real
 * control adapter and the real remote runtime. The only fake is the sandbox
 * platform, which is where the assertion is taken — `startBridge` is the one
 * call that carries a credential, and the fixture records every call.
 *
 * ## The four states the brief asks about
 *
 *   1. concurrent sessions → each gets its own credential;
 *   2. disconnect A → A cannot start, B is unaffected;
 *   3. rotate B → B's next session gets the new credential;
 *   4. and the credential appears nowhere else the platform can see.
 */

const T0 = 1_700_000_000_000;
const ALICE: RuntimeActor = { id: "account:alice" };
const BOB: RuntimeActor = { id: "account:bob" };

// Distinctive, and unmistakably different from each other. The whole suite is
// about which of these two strings ends up where.
const ALICE_KEY = "sk-ant-api03-ALICE-DO-NOT-LEAK-aaaa";
const BOB_KEY = "sk-ant-api03-BOB-DO-NOT-LEAK-bbbbbb";
const BOB_KEY_2 = "sk-ant-api03-BOB-ROTATED-cccccccccc";

const REMOTE_GATE: ExecutionGateResult = {
  allowed: true,
  environment: "remote",
  kind: "remote",
  decision: { allowed: true, kind: "remote-sandbox" },
};

let remoteStore: RemoteStore;
let sandbox: FakeSandboxService;
let connections: ConnectionStore;
let secrets: CredentialStore;
let service: CredentialService;

function remoteProject(over: Partial<RemoteProject>): RemoteProject {
  return {
    id: "rp-1",
    ownerId: ALICE.id,
    name: "Project",
    source: "remote_upload",
    sandboxName: "tabdump-aaaabbbbcccc",
    scopes: ["read_project", "write_project"],
    status: "ready",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/**
 * The credential source `runtime/server.ts` builds for one actor.
 *
 * Reproduced here rather than imported because `server.ts` is `server-only`
 * and pulls in Postgres and the sandbox platform. What matters is that the
 * *shape* is identical — a closure over one owner id, resolving through the
 * real resolver on every call — and that is what this is.
 */
function credentialSourceFor(ownerId: string): ClaudeCredentialSource {
  return async () => {
    const resolution = await resolveCredential({ connections, secrets }, ownerId, "claude-code");
    if (!resolution.ok) return { ok: false, reason: resolution.reason };
    return {
      ok: true,
      connectionId: resolution.credential.connectionId,
      env: resolution.credential.env,
    };
  };
}

/** One serverless request's worth of runtime, bound to one actor. */
function newRequest(actor: RuntimeActor): RuntimeHost {
  const adapter = createClaudeCodeControlAdapter({
    runtime: createRemoteClaudeRuntime({
      sandbox,
      store: remoteStore,
      ownerId: actor.id,
      credentials: credentialSourceFor(actor.id),
    }),
  });

  return createRuntimeHost({
    gate: REMOTE_GATE,
    resolveAdapter: (provider) => (provider === "claude-code" ? adapter : undefined),
    remote: createRemoteBindings({ store: remoteStore }),
    providers: ["claude-code"],
    runtimeId: "remote-fixed",
  });
}

/** Every credential the platform was ever handed, in order. */
function bridgeCredentials(): string[] {
  return sandbox.calls
    .filter((call) => call.kind === "startBridge")
    .map((call) =>
      call.kind === "startBridge" ? (call.input.env[PROVIDER_CREDENTIAL_ENV_VAR] ?? "") : ""
    );
}

async function connect(ownerId: string, secret: string) {
  const outcome = await service.connect({
    ownerId,
    provider: "claude-code",
    authMethod: "api_key",
    secret,
  });
  if (!outcome.ok) throw new Error(`fixture failed to connect ${ownerId}`);
  return outcome.connection;
}

async function startSession(actor: RuntimeActor, projectId: string) {
  const host = newRequest(actor);
  return host.execute(actor, { name: "create_session", provider: "claude-code", projectId });
}

beforeEach(async () => {
  resetCredentialAdapters();
  registerCredentialAdapter(
    createClaudeCredentialAdapter({
      // Accepts anything key-shaped, so the suite is about routing rather
      // than about validation, which `service.test.ts` already covers.
      fetchImpl: (async (_url, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("x-api-key") ?? "";
        return new Response("{}", { status: key.startsWith("sk-ant-") ? 200 : 401 });
      }) as typeof fetch,
    })
  );

  connections = createMemoryConnectionStore();
  secrets = createCredentialStore(
    createMemorySecretRows(),
    createAesCipher(Buffer.from(generateCredentialKey(), "base64"))
  );
  service = createCredentialService({ connections, secrets });

  remoteStore = createMemoryRemoteStore();
  sandbox = createFakeSandboxService();

  // One project each, in its own sandbox.
  await remoteStore.createProject(remoteProject({ id: "rp-alice", ownerId: ALICE.id }));
  await remoteStore.createProject(
    remoteProject({ id: "rp-bob", ownerId: BOB.id, sandboxName: "tabdump-ddddeeeeffff" })
  );

  for (const name of ["tabdump-aaaabbbbcccc", "tabdump-ddddeeeeffff"]) {
    await sandbox.ensure({ sandboxName: name, timeoutMs: 60_000, allowedHosts: ["api.anthropic.com"] });
  }
});

describe("two users starting sessions on one deployment", () => {
  it("gives each agent its own user's credential", async () => {
    await connect(ALICE.id, ALICE_KEY);
    await connect(BOB.id, BOB_KEY);

    // Concurrently, and deliberately: a shared module-level credential or a
    // mutated `process.env` would show up here as both sessions getting the
    // same key, or as a race that produces the wrong one.
    const [alice, bob] = await Promise.all([
      startSession(ALICE, "rp-alice"),
      startSession(BOB, "rp-bob"),
    ]);

    expect(alice.ok).toBe(true);
    expect(bob.ok).toBe(true);

    const aliceBridge = sandbox.calls.find(
      (call) => call.kind === "startBridge" && call.input.sandboxName === "tabdump-aaaabbbbcccc"
    );
    const bobBridge = sandbox.calls.find(
      (call) => call.kind === "startBridge" && call.input.sandboxName === "tabdump-ddddeeeeffff"
    );

    expect(
      aliceBridge?.kind === "startBridge" && aliceBridge.input.env[PROVIDER_CREDENTIAL_ENV_VAR]
    ).toBe(ALICE_KEY);
    expect(
      bobBridge?.kind === "startBridge" && bobBridge.input.env[PROVIDER_CREDENTIAL_ENV_VAR]
    ).toBe(BOB_KEY);
  });

  it("refuses a user who has connected nothing, while the other still runs", async () => {
    await connect(BOB.id, BOB_KEY);

    const alice = await startSession(ALICE, "rp-alice");
    expect(alice.ok).toBe(false);
    expect(alice.ok === false && alice.error.code).toBe("authentication_required");

    // And crucially: no sandbox was started for her. A user with no credential
    // must not cause a microVM to be created — that would bill the deployment
    // for a session that was never going to run.
    expect(bridgeCredentials()).toEqual([]);

    const bob = await startSession(BOB, "rp-bob");
    expect(bob.ok).toBe(true);
    expect(bridgeCredentials()).toEqual([BOB_KEY]);
  });

  it("does not let one user's project id reach the other's credential", async () => {
    await connect(ALICE.id, ALICE_KEY);
    await connect(BOB.id, BOB_KEY);

    // Bob names Alice's project. The remote store's owner scoping refuses it
    // before any credential is used — a credential proves authentication and
    // grants no additional TabDump permission (§16).
    const crossed = await startSession(BOB, "rp-alice");
    expect(crossed.ok).toBe(false);
    expect(bridgeCredentials()).toEqual([]);
  });
});

describe("disconnecting", () => {
  it("stops the next session for that user and leaves the other working", async () => {
    const aliceConnection = await connect(ALICE.id, ALICE_KEY);
    await connect(BOB.id, BOB_KEY);

    expect((await startSession(ALICE, "rp-alice")).ok).toBe(true);
    expect((await startSession(BOB, "rp-bob")).ok).toBe(true);

    await service.disconnect(ALICE.id, aliceConnection.id);

    // Alice: refused, with the reason that sends her to the Connect button.
    const afterDisconnect = await startSession(ALICE, "rp-alice");
    expect(afterDisconnect.ok).toBe(false);
    expect(afterDisconnect.ok === false && afterDisconnect.error.code).toBe(
      "authentication_required"
    );

    // Bob: entirely unaffected. Disconnecting is not a global operation, and
    // a shared adapter or a cached credential would show up here.
    const bobAgain = await startSession(BOB, "rp-bob");
    expect(bobAgain.ok).toBe(true);

    expect(bridgeCredentials()).toEqual([ALICE_KEY, BOB_KEY, BOB_KEY]);
  });

  it("does not disturb a session that is already running", async () => {
    const aliceConnection = await connect(ALICE.id, ALICE_KEY);
    const created = await startSession(ALICE, "rp-alice");
    expect(created.ok).toBe(true);

    await service.disconnect(ALICE.id, aliceConnection.id);

    // Defined behaviour, stated rather than accidental: the agent is a process
    // inside a microVM that is already authenticated and already working.
    // Disconnecting revokes TabDump's ability to *start* sessions; it does not
    // reach inside a running one, and claiming it did would be a promise this
    // architecture cannot keep. Stopping the run is a separate, explicit act.
    const session = await remoteStore.findSession(ALICE.id, sessionIdOf(created));
    expect(session).toBeDefined();
  });
});

describe("rotating", () => {
  it("hands the new credential to the next session and never the old one again", async () => {
    await connect(ALICE.id, ALICE_KEY);
    const bobConnection = await connect(BOB.id, BOB_KEY);

    expect((await startSession(BOB, "rp-bob")).ok).toBe(true);
    expect(bridgeCredentials()).toEqual([BOB_KEY]);

    const rotated = await service.rotate({
      ownerId: BOB.id,
      connectionId: bobConnection.id,
      secret: BOB_KEY_2,
    });
    expect(rotated.ok).toBe(true);

    expect((await startSession(BOB, "rp-bob")).ok).toBe(true);
    expect(bridgeCredentials()).toEqual([BOB_KEY, BOB_KEY_2]);

    // Alice is untouched throughout.
    expect((await startSession(ALICE, "rp-alice")).ok).toBe(true);
    expect(bridgeCredentials()).toEqual([BOB_KEY, BOB_KEY_2, ALICE_KEY]);
  });

  it("keeps serving the old credential when a rotation is rejected", async () => {
    const bobConnection = await connect(BOB.id, BOB_KEY);

    const failed = await service.rotate({
      ownerId: BOB.id,
      connectionId: bobConnection.id,
      // Not key-shaped, so the provider refuses it.
      secret: "definitely-not-a-key",
    });
    expect(failed.ok).toBe(false);

    // §12's requirement, observed where it actually matters: the session that
    // starts after a failed rotation runs on the credential that still works.
    expect((await startSession(BOB, "rp-bob")).ok).toBe(true);
    expect(bridgeCredentials()).toEqual([BOB_KEY]);
  });
});

describe("what the platform is told", () => {
  it("puts the credential in the bridge environment and nowhere else", async () => {
    await connect(ALICE.id, ALICE_KEY);
    await startSession(ALICE, "rp-alice");

    // Every call the sandbox platform received, minus the one environment that
    // is allowed to carry a credential. Nothing else may contain it: not the
    // ensure call's tags, not the bridge config, not a workspace write.
    const withoutEnv = sandbox.calls.map((call) =>
      call.kind === "startBridge" ? { ...call, input: { ...call.input, env: "[redacted]" } } : call
    );

    expect(JSON.stringify(withoutEnv)).not.toContain(ALICE_KEY);
    expect(JSON.stringify(withoutEnv)).not.toContain("DO-NOT-LEAK");

    // And the bridge environment carries exactly one variable.
    const started = sandbox.calls.find((call) => call.kind === "startBridge");
    expect(started?.kind === "startBridge" && Object.keys(started.input.env)).toEqual([
      PROVIDER_CREDENTIAL_ENV_VAR,
    ]);
  });

  it("puts the credential in no durable record and no event", async () => {
    await connect(ALICE.id, ALICE_KEY);
    const host = newRequest(ALICE);
    const created = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-alice",
    });
    expect(created.ok).toBe(true);

    const projects = await remoteStore.listProjects(ALICE.id);
    const session = await remoteStore.findSession(ALICE.id, sessionIdOf(created));
    const events = await host.execute(ALICE, {
      name: "get_events",
      sessionId: sessionIdOf(created),
      afterSequence: 0,
    });

    const surface = JSON.stringify({ projects, session, events, view: created });
    expect(surface).not.toContain(ALICE_KEY);
    expect(surface).not.toContain("DO-NOT-LEAK");
    expect(surface).not.toContain("sk-ant");
  });
});

/** Pulls the session id out of a `create_session` result, failing loudly if it is not there. */
function sessionIdOf(result: unknown): string {
  const value = (result as { ok?: boolean; value?: { sessionId?: string } }).value;
  if (!value?.sessionId) throw new Error("expected a created session");
  return value.sessionId;
}
