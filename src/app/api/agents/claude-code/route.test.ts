import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCursor } from "@/lib/agents/claude-code/cursor";
import { OBSERVATION_ALLOWLIST } from "@/lib/agents/claude-code/normalizer";
import type { ClaudeObservationResponse } from "@/lib/agents/claude-code/contract";

let home: string;
let previousConfigDir: string | undefined;

const SESSION = "b70abc10-f01a-48de-8d41-8ac936e8eff8";
const CWD = "C:\\Users\\someone\\project";
const T0 = Date.parse("2026-09-15T08:00:00.000Z");

function sessionsDir() {
  return join(home, ".claude", "sessions");
}
function projectDir() {
  return join(home, ".claude", "projects", "C--Users-someone-project");
}

function seedInstallation(): void {
  mkdirSync(sessionsDir(), { recursive: true });
  mkdirSync(projectDir(), { recursive: true });
  writeFileSync(
    join(sessionsDir(), "9492.json"),
    JSON.stringify({
      sessionId: SESSION,
      cwd: CWD,
      name: "project-c4",
      status: "busy",
      statusUpdatedAt: T0,
      messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-deadbeef",
    })
  );
  writeFileSync(
    join(projectDir(), `${SESSION}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      uuid: "u1",
      timestamp: new Date(T0).toISOString(),
      message: {
        content: [
          { type: "thinking", thinking: "PRIVATE-REASONING" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "echo SECRET-CREDENTIAL", description: "Print a value" },
          },
        ],
      },
    })}\n`
  );
}

async function post(body: unknown): Promise<ClaudeObservationResponse> {
  const { POST } = await import("./route");
  const response = await POST(
    new Request("http://localhost/api/agents/claude-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
  return (await response.json()) as ClaudeObservationResponse;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tabdump-cc-api-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  rmSync(home, { recursive: true, force: true });
});

describe("when Claude Code is available locally", () => {
  beforeEach(seedInstallation);

  it("reports the session and its safe activity", async () => {
    const body = await post({ cursor: "" });

    expect(body.available).toBe(true);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].externalId).toBe(SESSION);
    expect(body.sessions[0].status).toBe("working");
    expect(body.observations.some((o) => o.activity === "Print a value")).toBe(true);
  });

  it("returns an opaque cursor that carries no path", async () => {
    const body = await post({ cursor: "" });

    expect(body.cursor).toBeTruthy();
    expect(body.cursor).not.toContain("/");
    expect(body.cursor).not.toContain("\\");

    const decoded = decodeCursor(body.cursor);
    expect(decoded[0].sessionId).toBe(SESSION);
    expect(JSON.stringify(decoded)).not.toContain(".claude");
  });

  it("returns nothing new when given the cursor it just issued", async () => {
    const first = await post({ cursor: "" });
    expect(first.observations.some((o) => o.activity)).toBe(true);

    const second = await post({ cursor: first.cursor });
    // The base status observation still comes back; the activity does not.
    expect(second.observations.filter((o) => o.activity)).toEqual([]);
  });

  it("leaks no prompt, reasoning, command or control channel", async () => {
    const serialized = JSON.stringify(await post({ cursor: "" }));

    for (const secret of ["PRIVATE-REASONING", "SECRET-CREDENTIAL", "echo ", "pipe", "cc-msg"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("emits only allowlisted observation fields", async () => {
    const body = await post({ cursor: "" });

    for (const observation of body.observations) {
      for (const key of Object.keys(observation)) {
        expect(OBSERVATION_ALLOWLIST).toContain(key);
      }
    }
  });
});

describe("input handling", () => {
  beforeEach(seedInstallation);

  it("accepts a malformed body by starting fresh rather than failing the poll", async () => {
    const body = await post("{not json");

    expect(body.available).toBe(true);
    expect(body.sessions).toHaveLength(1);
  });

  it("ignores a forged cursor's attempt to name a file", async () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 1, e: [{ s: "../../../../etc/passwd", o: 0, z: 0 }] })
    ).toString("base64url");

    const body = await post({ cursor: forged });

    expect(body.available).toBe(true);
    expect(body.sessions.map((s) => s.externalId)).toEqual([SESSION]);
  });

  it("ignores any path-shaped field in the body", async () => {
    const body = await post({
      cursor: "",
      path: "C:\\Windows\\System32\\config\\SAM",
      file: "/etc/shadow",
      dir: "..",
    });

    expect(body.sessions.map((s) => s.externalId)).toEqual([SESSION]);
    expect(JSON.stringify(body)).not.toContain("System32");
    expect(JSON.stringify(body)).not.toContain("shadow");
  });
});

describe("when there is no local Claude Code", () => {
  it("reports unavailable instead of pretending — the hosted-deployment case", async () => {
    // No installation seeded: exactly what a Vercel deployment sees, where
    // `~/.claude` is not the user's machine.
    const body = await post({ cursor: "" });

    expect(body).toEqual({ available: false, sessions: [], observations: [], cursor: "" });
  });

  it("invents no sessions or activity when unavailable", async () => {
    const body = await post({ cursor: "" });

    expect(body.sessions).toEqual([]);
    expect(body.observations).toEqual([]);
  });
});
