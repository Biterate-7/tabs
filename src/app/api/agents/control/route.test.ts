import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_RUNTIME_ENV_VALUE,
  LOCAL_RUNTIME_ENV_VAR,
} from "@/lib/agents/control/runtime";
import { disposeRuntimeHost } from "@/lib/agents/runtime/server";
import type { RuntimeCommand, RuntimeStatus } from "@/lib/agents/runtime/protocol";

/**
 * The transport.
 *
 * The route itself contains no control logic — parse, identify, delegate — so
 * what is worth testing is exactly the three things only a request can
 * answer: where it came from, who is asking, and which runtime generation it
 * believes it is talking to. Plus the one property the whole design rests on:
 * a hosted deployment serving this route refuses to execute anything.
 */

const ORIGIN = "http://localhost:3000";

function request(body: unknown, over: { origin?: string | null; contentType?: string | null } = {}) {
  const headers: Record<string, string> = { host: "localhost:3000" };
  const origin = over.origin === undefined ? ORIGIN : over.origin;
  if (origin) headers.origin = origin;
  const contentType = over.contentType === undefined ? "application/json" : over.contentType;
  if (contentType) headers["content-type"] = contentType;

  return new Request(`${ORIGIN}/api/agents/control`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function post(body: unknown, over?: Parameters<typeof request>[1]) {
  const { POST } = await import("./route");
  const response = await POST(request(body, over));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The handshake, returning the identity every other command has to carry. */
async function handshake(): Promise<string> {
  const { body } = await post({ command: { name: "get_status" } });
  return (body.value as RuntimeStatus).runtimeId;
}

let previousOptIn: string | undefined;

beforeEach(() => {
  previousOptIn = process.env[LOCAL_RUNTIME_ENV_VAR];
});

afterEach(async () => {
  await disposeRuntimeHost();
  if (previousOptIn === undefined) delete process.env[LOCAL_RUNTIME_ENV_VAR];
  else process.env[LOCAL_RUNTIME_ENV_VAR] = previousOptIn;
});

describe("where the request came from", () => {
  it("refuses a cross-origin post", async () => {
    // The one real browser-borne threat against a localhost server: a page
    // the user happens to visit could otherwise fetch this endpoint.
    const result = await post(
      { command: { name: "get_status" } },
      { origin: "https://evil.example" }
    );

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("refuses a post that is not JSON", async () => {
    // A cross-site form, image or classic script tag can only produce a
    // "simple" content type, so requiring JSON means such a request must be
    // preflighted — and nothing here answers a preflight.
    const result = await post(
      { command: { name: "get_status" } },
      { contentType: "application/x-www-form-urlencoded" }
    );

    expect(result.status).toBe(403);
  });

  it("gives a refused origin the same answer as a malformed body", async () => {
    // A probe learns that the endpoint exists and nothing about why it said
    // no.
    const crossOrigin = await post({}, { origin: "https://evil.example" });
    const malformed = await post({ command: { name: "nonsense" } });

    expect(crossOrigin.body).toEqual(malformed.body);
  });
});

describe("what the body may say", () => {
  it("refuses a body that is not readable JSON", async () => {
    const result = await post("{not json");
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("refuses a verb that is not in the union", async () => {
    for (const name of ["exec", "spawn", "shell", "readFile", "run"]) {
      const result = await post({ command: { name, command: "rm -rf /" } });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
  });

  it("cannot name its own actor", async () => {
    // Identity is derived from the request, never read from the body, which
    // is why `RuntimeCommand` has no field for one. An actor key in the body
    // is dropped by the parser and never reaches the host.
    process.env[LOCAL_RUNTIME_ENV_VAR] = LOCAL_RUNTIME_ENV_VALUE;
    const runtimeId = await handshake();

    const result = await post({
      runtimeId,
      actor: { id: "account:somebody-else" },
      command: { name: "list_sessions" },
    });

    expect(result.body.ok).toBe(true);
    expect((result.body.value as { sessions: unknown[] }).sessions).toEqual([]);
  });
});

describe("the generation check", () => {
  it("answers the handshake without a runtime id", async () => {
    const result = await post({ command: { name: "get_status" } });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect((result.body.value as RuntimeStatus).runtimeId).toBeTruthy();
  });

  it("refuses a command carrying an identity from another process", async () => {
    // A tab left open across a server restart. Being told so is what makes it
    // reattach, rather than silently addressing sessions that no longer exist.
    const result = await post({
      runtimeId: "runtime-from-yesterday",
      command: { name: "list_sessions" },
    });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ ok: false, error: { code: "runtime_disconnected" } });
  });

  it("refuses a command carrying no identity at all", async () => {
    const result = await post({ command: { name: "list_sessions" } });
    expect(result.body).toMatchObject({ ok: false, error: { code: "runtime_disconnected" } });
  });
});

describe("hosted execution", () => {
  it("refuses everything but the status when the runtime has not proved itself local", async () => {
    // The default state of this route on any machine that has not opted in —
    // which includes every hosted deployment.
    delete process.env[LOCAL_RUNTIME_ENV_VAR];
    const runtimeId = await handshake();

    const status = await post({ command: { name: "get_status" } });
    expect((status.body.value as RuntimeStatus).executable).toBe(false);

    const commands: RuntimeCommand[] = [
      { name: "list_sessions" },
      { name: "create_session", provider: "claude-code" },
      { name: "authorize_projects", projects: [] },
    ];

    for (const command of commands) {
      const result = await post({ runtimeId, command });
      expect(result.body).toMatchObject({
        ok: false,
        error: { code: "runtime_unavailable" },
      });
    }
  });

  it("reports the environment without naming what would change it", async () => {
    delete process.env[LOCAL_RUNTIME_ENV_VAR];
    const status = await post({ command: { name: "get_status" } });
    const serialized = JSON.stringify(status.body);

    expect(serialized).not.toContain(LOCAL_RUNTIME_ENV_VAR);
    expect(serialized).not.toContain(LOCAL_RUNTIME_ENV_VALUE);
  });
});

describe("a local runtime", () => {
  beforeEach(() => {
    process.env[LOCAL_RUNTIME_ENV_VAR] = LOCAL_RUNTIME_ENV_VALUE;
  });

  it("reports itself executable and lists its providers", async () => {
    const status = await post({ command: { name: "get_status" } });
    const value = status.body.value as RuntimeStatus;

    expect(value.environment).toBe("local");
    expect(value.executable).toBe(true);
    // Claude through its SDK, and every ACP agent in the launch allowlist
    // (Phase J). Listing one is not claiming it is installed — see
    // `detect_providers` for that — only that this runtime can drive it.
    expect(value.providers.map((provider) => provider.provider)).toEqual([
      "claude-code",
      "gemini",
      "openai-codex",
      "grok",
    ]);
  });

  it("does not claim a provider is authenticated merely because it loaded", async () => {
    // Three separate facts. Claude Code authenticates lazily, so anything
    // before a run starts is a guess.
    const status = await post({ command: { name: "get_status" } });
    const provider = (status.body.value as RuntimeStatus).providers[0];

    expect(provider.authentication).toBe("unknown");
  });

  it("answers a well-formed command with 200 whatever it decided", async () => {
    // The result carries the outcome, so a caller has one shape to read
    // rather than a status code to interpret alongside it.
    const runtimeId = await handshake();

    const result = await post({
      runtimeId,
      command: { name: "get_session", sessionId: "never-existed" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: false, error: { code: "session_not_found" } });
  });

  it("refuses a project path the validator rejects", async () => {
    const runtimeId = await handshake();

    const result = await post({
      runtimeId,
      command: {
        name: "authorize_projects",
        projects: [
          {
            id: "root",
            name: "Everything",
            path: "C:/",
            providers: ["claude-code"],
            permissions: { scopes: ["write_project"], projectId: "root", grantedAt: 1 },
          },
        ],
      },
    });

    expect(result.body.ok).toBe(true);
    expect((result.body.value as { accepted: string[] }).accepted).toEqual([]);
  });
});
