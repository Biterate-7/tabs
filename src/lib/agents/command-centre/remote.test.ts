import { describe, expect, it } from "vitest";
import {
  START_BLOCKER_MESSAGE,
  availableModes,
  controlAvailability,
  expiresInLabel,
  precheckUpload,
  startBlocker,
} from "./remote";
import { REMOTE_LIMITS } from "@/lib/agents/remote/types";
import type { StartBlocker } from "./remote";
import type { RuntimeProviderStatus, RuntimeStatus } from "@/lib/agents/runtime/protocol";

/**
 * The command centre's remote vocabulary.
 *
 * Pure, so these drive every branch without rendering anything — which is what
 * lets the component tests be about composition rather than about whether the
 * Start button's rules are right.
 */

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    environment: "remote",
    executable: true,
    runtimeId: "runtime-1",
    providers: [],
    ...over,
  };
}

function provider(over: Partial<RuntimeProviderStatus> = {}): RuntimeProviderStatus {
  return {
    provider: "claude-code",
    connection: "connected",
    available: true,
    authentication: "unknown",
    capabilities: ["create_session", "message"],
    ...over,
  };
}

describe("available execution modes", () => {
  it("offers only remote on a hosted runtime", () => {
    // The brief's requirement: local must not appear as an executable option
    // in hosted mode, because it genuinely cannot execute there.
    expect(availableModes(status({ environment: "remote" }))).toEqual(["remote"]);
  });

  it("offers only local on a local runtime", () => {
    expect(availableModes(status({ environment: "local" }))).toEqual(["local"]);
  });

  it("offers nothing when the runtime cannot execute", () => {
    expect(availableModes(status({ executable: false }))).toEqual([]);
    expect(availableModes(status({ environment: "hosted", executable: false }))).toEqual([]);
    expect(availableModes(status({ environment: "browser", executable: false }))).toEqual([]);
    expect(availableModes(null)).toEqual([]);
  });

  it("offers nothing for an environment it cannot execute in, even if told it is executable", () => {
    // Fail closed on a combination the gate does not produce. An `unknown`
    // environment reporting `executable` is a host we do not understand, and
    // the safe reading is "no modes" rather than "pick one".
    expect(availableModes(status({ environment: "unknown", executable: true }))).toEqual([]);
  });
});

describe("the start gate", () => {
  const ready = { status: "ready" };

  it("permits a complete remote selection", () => {
    expect(
      startBlocker({ status: status(), provider: provider(), mode: "remote", project: ready })
    ).toBeNull();
  });

  it("permits a local session with no project at all", () => {
    // An agent with no filesystem scope is limited but real, and that has
    // always been allowed locally.
    expect(
      startBlocker({
        status: status({ environment: "local" }),
        provider: provider(),
        mode: "local",
        project: null,
      })
    ).toBeNull();
  });

  it("refuses a remote session with no project, because the project is the sandbox", () => {
    expect(
      startBlocker({ status: status(), provider: provider(), mode: "remote", project: null })
    ).toBe("no-project");
  });

  const cases: readonly { name: string; input: Parameters<typeof startBlocker>[0]; expected: StartBlocker }[] = [
    {
      name: "no runtime",
      input: { status: null, provider: provider(), mode: "remote", project: ready },
      expected: "runtime-unavailable",
    },
    {
      name: "a runtime that cannot execute",
      input: {
        status: status({ executable: false }),
        provider: provider(),
        mode: null,
        project: ready,
      },
      expected: "runtime-unavailable",
    },
    {
      name: "no provider",
      input: { status: status(), provider: undefined, mode: "remote", project: ready },
      expected: "provider-unavailable",
    },
    {
      name: "an unavailable provider",
      input: {
        status: status(),
        provider: provider({ available: false }),
        mode: "remote",
        project: ready,
      },
      expected: "provider-unavailable",
    },
    {
      name: "a provider that needs signing in",
      input: {
        status: status(),
        provider: provider({ authentication: "required" }),
        mode: "remote",
        project: ready,
      },
      expected: "authentication-required",
    },
    {
      name: "a provider that cannot start sessions",
      input: {
        status: status(),
        provider: provider({ capabilities: ["message"] }),
        mode: "remote",
        project: ready,
      },
      expected: "provider-cannot-start",
    },
    {
      name: "a project still being created",
      input: {
        status: status(),
        provider: provider(),
        mode: "remote",
        project: { status: "creating" },
      },
      expected: "project-not-ready",
    },
    {
      name: "a project whose environment failed",
      input: {
        status: status(),
        provider: provider(),
        mode: "remote",
        project: { status: "failed" },
      },
      expected: "project-failed",
    },
  ];

  for (const { name, input, expected } of cases) {
    it(`refuses ${name} with its own reason`, () => {
      expect(startBlocker(input)).toBe(expected);
    });
  }

  it("keeps every reason distinct rather than collapsing them", () => {
    // The brief forbids "Agent unavailable" standing in for all of these,
    // because each has a different next step.
    const reasons = new Set(cases.map((entry) => entry.expected));
    const messages = new Set([...reasons].map((reason) => START_BLOCKER_MESSAGE[reason]));
    expect(messages.size).toBe(reasons.size);
  });

  it("permits a stopped or expired project, because starting resumes it", () => {
    // Not a refusal: a stopped sandbox is snapshotted, and resuming it with
    // the project's files intact is the point of a persistent remote project.
    for (const state of ["stopped", "expired", "running"]) {
      expect(
        startBlocker({
          status: status(),
          provider: provider(),
          mode: "remote",
          project: { status: state },
        }),
        state
      ).toBeNull();
    }
  });
});

describe("the upload precheck", () => {
  function file(path: string, size = 1024) {
    return { path, size };
  }

  it("accepts an ordinary folder and counts what will be left out", () => {
    const result = precheckUpload([
      file("src/index.ts"),
      file("package.json"),
      file("node_modules/left-pad/index.js"),
      file(".env"),
    ]);

    expect(result).toMatchObject({ ok: true, files: 2, excluded: 2 });
  });

  it("refuses a path the server's own normalizer refuses", () => {
    // Calls the same function the server calls, so the two cannot drift into
    // disagreeing about what is safe.
    for (const bad of ["../escape", "/etc/passwd", "C:/Windows", "a\u0000b"]) {
      expect(precheckUpload([file(bad)]), bad).toEqual({ ok: false, reason: "unsafe-path" });
    }
  });

  it("refuses an empty folder, and one that is empty after exclusions", () => {
    expect(precheckUpload([])).toEqual({ ok: false, reason: "no-files" });
    expect(precheckUpload([file("node_modules/x.js"), file(".env")])).toEqual({
      ok: false,
      reason: "no-files",
    });
  });

  it("refuses a folder past the platform's body limit", () => {
    const big = Math.ceil(REMOTE_LIMITS.maxUploadBytes / 2) + 1;
    expect(precheckUpload([file("a.bin", big), file("b.bin", big)])).toEqual({
      ok: false,
      reason: "upload-too-large",
    });
  });

  it("refuses more files than the server would accept", () => {
    const many = Array.from({ length: REMOTE_LIMITS.maxUploadFiles + 1 }, (_, index) =>
      file(`f${index}.ts`, 1)
    );
    expect(precheckUpload(many)).toEqual({ ok: false, reason: "too-many-files" });
  });

  it("does not count excluded files toward the size budget", () => {
    // Otherwise a folder with a large node_modules would be refused for a
    // size the server was never going to receive.
    const result = precheckUpload([
      file("src/index.ts", 100),
      file("node_modules/big.bin", REMOTE_LIMITS.maxUploadBytes),
    ]);

    expect(result).toMatchObject({ ok: true, files: 1, bytes: 100 });
  });
});

describe("expiry labels", () => {
  const T0 = 1_700_000_000_000;

  it("says nothing when there is no deadline", () => {
    expect(expiresInLabel(undefined, T0)).toBeNull();
  });

  it("reads coarsely, because the deadline moves when a session extends it", () => {
    expect(expiresInLabel(T0 + 30_000, T0)).toBe("Expires in under a minute");
    expect(expiresInLabel(T0 + 60_000, T0)).toBe("Expires in 1 minute");
    expect(expiresInLabel(T0 + 15 * 60_000, T0)).toBe("Expires in 15 minutes");
    expect(expiresInLabel(T0 + 60 * 60_000, T0)).toBe("Expires in about an hour");
    expect(expiresInLabel(T0 + 3 * 60 * 60_000, T0)).toBe("Expires in about 3 hours");
  });

  it("says expired rather than a negative countdown", () => {
    expect(expiresInLabel(T0 - 1, T0)).toBe("Expired");
  });
});

describe("control availability on the connector page", () => {
  it("is unavailable when no runtime answered", () => {
    // Never "Available" merely because the UI knows the provider's name.
    expect(controlAvailability(null, "claude-code")).toMatchObject({ kind: "unavailable" });
  });

  it("is unavailable when the runtime cannot execute, and says the gate's own reason", () => {
    const refused = status({ executable: false, detail: "Agents cannot run on a hosted TabDump." });
    expect(controlAvailability(refused, "claude-code")).toEqual({
      kind: "unavailable",
      reason: "Agents cannot run on a hosted TabDump.",
    });
  });

  it("is unavailable for a provider with no adapter registered here", () => {
    expect(controlAvailability(status({ providers: [] }), "claude-code")).toMatchObject({
      kind: "unavailable",
    });
  });

  it("names authentication separately from unavailability", () => {
    const needsAuth = status({
      providers: [provider({ authentication: "required", connection: "configuration_required" })],
    });
    expect(controlAvailability(needsAuth, "claude-code")).toMatchObject({
      kind: "authentication-required",
    });
  });

  it("is unavailable for a provider that cannot start sessions", () => {
    const limited = status({ providers: [provider({ capabilities: ["message"] })] });
    expect(controlAvailability(limited, "claude-code")).toMatchObject({ kind: "unavailable" });
  });

  it("reports the plane and exactly the capabilities the adapter declared", () => {
    const ready = status({
      environment: "remote",
      providers: [
        provider({ capabilities: ["create_session", "message", "approvals", "write_files"] }),
      ],
    });

    expect(controlAvailability(ready, "claude-code")).toEqual({
      kind: "available",
      environment: "remote",
      // Passed through, not described. The capability model already forbids
      // claiming one that is not implemented.
      capabilities: ["create_session", "message", "approvals", "write_files"],
    });
  });
});
