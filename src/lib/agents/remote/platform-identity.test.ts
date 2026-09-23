import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hasPlatformOidcToken } from "./platform-identity";
import { decideRemoteRuntime } from "@/lib/agents/control/runtime";

/**
 * The OIDC half of the remote gate, against the platform's real mechanism.
 *
 * Phase I.3 found this refusing on a genuine Vercel deployment: the function
 * received its token per request, the gate looked only at `process.env`, and
 * `/api/agents/remote-projects` answered 503 on a project with OIDC enabled.
 * The context below is installed the way Vercel's runtime installs it.
 */

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const ENV_VAR = "VERCEL_OIDC_TOKEN";
const DIR = path.resolve(__dirname);
const REPO_ROOT = path.resolve(DIR, "../../../..");

type ContextHolder = { [REQUEST_CONTEXT]?: { get(): { headers?: Record<string, string> } } };

function withRequestHeaders(headers: Record<string, string> | undefined): void {
  (globalThis as ContextHolder)[REQUEST_CONTEXT] = { get: () => (headers ? { headers } : {}) };
}

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
  delete (globalThis as ContextHolder)[REQUEST_CONTEXT];
});

afterEach(() => {
  delete (globalThis as ContextHolder)[REQUEST_CONTEXT];
  if (savedEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv;
});

describe("hasPlatformOidcToken", () => {
  it("is true for a token delivered per request, with no environment variable", () => {
    // The production case, and the one the environment-only check missed.
    withRequestHeaders({ "x-vercel-oidc-token": "header-token" });
    expect(process.env[ENV_VAR]).toBeUndefined();
    expect(hasPlatformOidcToken()).toBe(true);
  });

  it("is true for the local-development copy in the environment", () => {
    process.env[ENV_VAR] = "pulled-token";
    expect(hasPlatformOidcToken()).toBe(true);
  });

  it("is false with neither a request context nor a variable", () => {
    expect(hasPlatformOidcToken()).toBe(false);
  });

  it("is false for a request context that carries no token", () => {
    withRequestHeaders({ "x-some-other-header": "value" });
    expect(hasPlatformOidcToken()).toBe(false);
  });

  it("is false for a blank token", () => {
    withRequestHeaders({ "x-vercel-oidc-token": "   " });
    expect(hasPlatformOidcToken()).toBe(false);
  });

  it("returns a boolean and nothing of the token", () => {
    withRequestHeaders({ "x-vercel-oidc-token": "must-not-escape" });
    const result: unknown = hasPlatformOidcToken();
    expect(result).toBe(true);
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });
});

describe("the remote gate with a platform-issued token", () => {
  it("allows with a per-request token and a durable store", () => {
    expect(decideRemoteRuntime({}, { durableStore: true, platformOidc: true })).toEqual({
      allowed: true,
      credentials: "oidc",
    });
  });

  it("still refuses without a durable store", () => {
    expect(decideRemoteRuntime({}, { durableStore: false, platformOidc: true })).toEqual({
      allowed: false,
      reason: "no-durable-store",
    });
  });

  it("still refuses when the platform says there is no token", () => {
    expect(decideRemoteRuntime({}, { durableStore: true, platformOidc: false })).toEqual({
      allowed: false,
      reason: "no-sandbox-credentials",
    });
  });

  it("is asked by both server callers", () => {
    // Either caller left on the environment-only check reintroduces the
    // production refusal on its own route.
    for (const file of ["src/lib/agents/remote/services.ts", "src/lib/agents/runtime/server.ts"]) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(source, file).toContain("platformOidc: hasPlatformOidcToken()");
    }
  });

  it("never reads the token from the environment itself", () => {
    // The platform's own lookup decides, so this module cannot drift from
    // what the sandbox SDK would authenticate with.
    const source = readFileSync(path.join(DIR, "platform-identity.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toContain("process.env");
    expect(code).toContain("getVercelOidcTokenSync()");
  });
});
