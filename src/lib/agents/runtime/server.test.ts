import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_RUNTIME_ENV_VALUE, LOCAL_RUNTIME_ENV_VAR } from "@/lib/agents/control/runtime";
import { disposeRuntimeHost, getRuntimeHost } from "./server";
import { LOCAL_ACTOR } from "./host";
import type { RuntimeStatus } from "./protocol";

/**
 * The shipped wiring, and the one invariant it must never break.
 *
 * > **A runtime that reports `executable: true` has an adapter.**
 *
 * The inverse of that — a host saying `REMOTE · Ready` and then refusing every
 * command — is the exact "fake state" this phase exists to preclude, and it is
 * reachable only through this module, because this is the only place where a
 * gate decision and a provider resolver are married.
 *
 * The earlier shape made it *argued* rather than *impossible*: the remote
 * branch was guarded by a four-way `&&`, and a failure of the last two
 * conjuncts fell through to a local branch that reused the allowing remote
 * gate. These tests pin the fixed behaviour rather than the fix.
 */

/** A clean slate between cases: the gate is cached, and a partial reset is how env leaks. */
afterEach(async () => {
  await disposeRuntimeHost();
  vi.unstubAllEnvs();
});

async function statusFor(): Promise<RuntimeStatus> {
  const host = await getRuntimeHost(LOCAL_ACTOR);
  const result = await host.execute(LOCAL_ACTOR, { name: "get_status" });
  if (!result.ok) throw new Error("get_status must always answer");
  return result.value;
}

/** Whether this host would actually reach a provider. The half `executable` does not say. */
async function canReachProvider(): Promise<boolean> {
  const host = await getRuntimeHost(LOCAL_ACTOR);
  const created = await host.execute(LOCAL_ACTOR, {
    name: "create_session",
    provider: "claude-code",
  });

  // A refusal for any reason is fine; what matters is that a host claiming to
  // be executable does not refuse with "there is no adapter here".
  return !(!created.ok && created.error.code === "runtime_unavailable");
}

/**
 * Environments that must all resolve to a refusal.
 *
 * Each is a real misconfiguration an operator can produce, and each used to be
 * a candidate for the fallthrough.
 */
const REFUSING: readonly { name: string; env: Record<string, string> }[] = [
  {
    name: "nothing configured at all",
    env: {},
  },
  {
    name: "a hosted platform with no sandbox credentials",
    env: { VERCEL: "1" },
  },
  {
    name: "a hosted platform that copied the local opt-in into its dashboard",
    // The mistake most likely to happen, and the veto that must survive it.
    env: { VERCEL: "1", [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE },
  },
  {
    name: "sandbox credentials but no durable store",
    env: { VERCEL: "1", VERCEL_OIDC_TOKEN: "token" },
  },
  {
    name: "a partial access-token trio",
    env: { VERCEL: "1", VERCEL_TEAM_ID: "team_x", VERCEL_PROJECT_ID: "prj_x" },
  },
];

describe("a refused runtime never claims to be executable", () => {
  for (const { name, env } of REFUSING) {
    it(`refuses: ${name}`, async () => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      // Explicitly absent, so a developer's own .env cannot make this pass.
      vi.stubEnv("POSTGRES_URL", "");
      vi.stubEnv("DATABASE_URL", "");

      const status = await statusFor();

      expect(status.executable).toBe(false);
      // A refusal always carries the sentence explaining it. A blank one would
      // leave the UI with nothing to say but "unavailable".
      expect(status.detail).toBeTruthy();
      expect(status.environment).not.toBe("remote");
    });
  }

  it("withholds the adapter as well as refusing, on every refusing environment", async () => {
    for (const { name, env } of REFUSING) {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      vi.stubEnv("POSTGRES_URL", "");
      vi.stubEnv("DATABASE_URL", "");

      const host = await getRuntimeHost(LOCAL_ACTOR);
      const created = await host.execute(LOCAL_ACTOR, {
        name: "create_session",
        provider: "claude-code",
      });

      expect(created, name).toMatchObject({
        ok: false,
        error: { code: "runtime_unavailable" },
      });

      await disposeRuntimeHost();
      vi.unstubAllEnvs();
    }
  });

  it("does not fall back to local when the remote plane is misconfigured", async () => {
    // The refusal a hosted deployment with half its configuration gets must
    // never be "fine, use the server's filesystem instead".
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "token");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("DATABASE_URL", "");

    const status = await statusFor();

    expect(status.executable).toBe(false);
    expect(status.environment).not.toBe("local");
    expect(await canReachProvider()).toBe(false);
  });
});

describe("the invariant, stated directly", () => {
  it("never reports executable without a reachable adapter", async () => {
    // Swept across every environment above plus the local one, because the
    // invariant is about the *pairing* rather than about any single case.
    const environments: Record<string, string>[] = [
      ...REFUSING.map((entry) => entry.env),
      { [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE },
    ];

    for (const env of environments) {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      vi.stubEnv("POSTGRES_URL", "");
      vi.stubEnv("DATABASE_URL", "");

      const status = await statusFor();
      if (status.executable) {
        // The implication, tested as an implication: if it says yes, it must
        // be able to reach one.
        expect(await canReachProvider(), JSON.stringify(env)).toBe(true);
      }

      await disposeRuntimeHost();
      vi.unstubAllEnvs();
    }
  });
});

describe("the local plane still works", () => {
  it("executes locally on an opted-in machine with no hosted markers", async () => {
    vi.stubEnv(LOCAL_RUNTIME_ENV_VAR, LOCAL_RUNTIME_ENV_VALUE);
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("DATABASE_URL", "");

    const status = await statusFor();

    expect(status.executable).toBe(true);
    expect(status.environment).toBe("local");
    // And it genuinely reaches an adapter rather than merely claiming to.
    expect(await canReachProvider()).toBe(true);
  });
});

describe("the cached gate is reset with the host", () => {
  it("re-decides after a dispose rather than inheriting the previous environment", async () => {
    // A partial reset is how one test's environment leaks into the next one's
    // answer — and, in a dev server, how a reload keeps a stale decision.
    vi.stubEnv(LOCAL_RUNTIME_ENV_VAR, LOCAL_RUNTIME_ENV_VALUE);
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    expect((await statusFor()).executable).toBe(true);

    await disposeRuntimeHost();
    vi.unstubAllEnvs();

    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    expect((await statusFor()).executable).toBe(false);
  });
});
