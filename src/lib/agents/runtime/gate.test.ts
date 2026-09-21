import { describe, expect, it } from "vitest";
import {
  LOCAL_RUNTIME_ENV_VALUE,
  LOCAL_RUNTIME_ENV_VAR,
} from "@/lib/agents/control/runtime";
import {
  assertLocalExecutionAllowed,
  denyLocalExecution,
  environmentKindOf,
  gateFailure,
} from "./gate";

/**
 * The execution gate.
 *
 * Every case here is a machine TabDump could plausibly be running on, and the
 * property under test is the same for all of them: **nothing is executable
 * unless it has proven it is the user's own computer.**
 */

describe("the four environments", () => {
  it("a browser is not executable, and says why in its own terms", () => {
    const result = denyLocalExecution();

    expect(result.allowed).toBe(false);
    expect(result.kind).toBe("browser");
    // Distinct from "you have not configured it": this build cannot run
    // agents at all, and a UI should say so rather than offer a setting.
    expect(result.allowed === false && result.detail).toContain("cannot run agents");
  });

  it("an empty server environment is unknown, and unknown is not executable", () => {
    const result = assertLocalExecutionAllowed({});

    expect(result.allowed).toBe(false);
    expect(result.kind).toBe("unknown");
  });

  it("a hosted platform is not executable even with the opt-in set", () => {
    for (const marker of ["VERCEL", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "K_SERVICE", "DYNO"]) {
      const result = assertLocalExecutionAllowed({
        [marker]: "1",
        [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE,
      });

      expect(result.allowed).toBe(false);
      expect(result.kind).toBe("hosted");
    }
  });

  it("a deliberately opted-in local server is executable", () => {
    const result = assertLocalExecutionAllowed({
      [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE,
    });

    expect(result).toMatchObject({ allowed: true, kind: "local" });
    expect(result.decision).toMatchObject({ allowed: true, kind: "local-server" });
  });

  it("local development is not broken by the gate", () => {
    // A developer running TabDump on their own machine with the opt-in set
    // gets a working runtime, even in production mode and even with an
    // unrelated environment full of variables.
    const result = assertLocalExecutionAllowed({
      NODE_ENV: "production",
      PATH: "/usr/bin",
      HOME: "/home/dev",
      npm_lifecycle_event: "dev",
      [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE,
    });

    expect(result.allowed).toBe(true);
  });
});

describe("what does not make a runtime local", () => {
  it("refuses every near-miss of the opt-in", () => {
    for (const value of [
      "1",
      "true",
      "yes",
      "",
      "0",
      LOCAL_RUNTIME_ENV_VALUE.toUpperCase(),
      ` ${LOCAL_RUNTIME_ENV_VALUE}`,
      `${LOCAL_RUNTIME_ENV_VALUE} `,
    ]) {
      expect(assertLocalExecutionAllowed({ [LOCAL_RUNTIME_ENV_VAR]: value }).allowed).toBe(false);
    }
  });

  it("is not persuaded by anything that looks local but is not the opt-in", () => {
    // Each of these is either a forgeable signal or true on somebody else's
    // machine. None of them is the answer to "is this the user's computer".
    const environments: Record<string, string>[] = [
      { NODE_ENV: "development" },
      { HOSTNAME: "localhost" },
      { HOST: "127.0.0.1" },
      { HOME: "/home/someone" },
      { USERPROFILE: "C:/Users/someone" },
      { TERM: "xterm-256color" },
      { CLAUDE_CODE_PATH: "/usr/local/bin/claude" },
      { TAURI: "1" },
      { npm_lifecycle_event: "dev" },
    ];

    for (const env of environments) {
      expect(assertLocalExecutionAllowed(env).allowed).toBe(false);
    }
  });
});

describe("the projection", () => {
  it("reports both local kinds as one environment", () => {
    expect(environmentKindOf({ allowed: true, kind: "local-desktop" })).toBe("local");
    expect(environmentKindOf({ allowed: true, kind: "local-server" })).toBe("local");
  });

  it("keeps unknown distinct from hosted", () => {
    // They behave identically and read differently. Telling a developer who
    // forgot the opt-in that they are on a hosted platform would be false.
    expect(
      environmentKindOf({ allowed: false, kind: "unknown", reason: "not-opted-in" })
    ).toBe("unknown");
    expect(
      environmentKindOf({ allowed: false, kind: "hosted", reason: "hosted-platform" })
    ).toBe("hosted");
  });

  it("reports a no-server context as a browser", () => {
    expect(
      environmentKindOf({ allowed: false, kind: "unknown", reason: "no-server-context" })
    ).toBe("browser");
  });
});

describe("what a refusal tells a caller", () => {
  it("is always the same code, whatever the reason", () => {
    // A user deciding whether to install something or move machines needs
    // `runtime_unavailable` rather than a code that varies with which check
    // happened to fire.
    expect(gateFailure()).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable" },
    });
  });

  it("never names the opt-in variable", () => {
    // The sentence a hosted deployment could render must not be instructions
    // for turning execution on.
    for (const env of [{}, { VERCEL: "1" }]) {
      const result = assertLocalExecutionAllowed(env);
      const detail = result.allowed ? "" : result.detail;
      expect(detail).not.toContain(LOCAL_RUNTIME_ENV_VAR);
      expect(detail).not.toContain(LOCAL_RUNTIME_ENV_VALUE);
    }
  });
});
