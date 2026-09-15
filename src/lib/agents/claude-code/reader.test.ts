import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The reader exercised against a real temporary filesystem laid out exactly
 * like the live installation, with invented content.
 *
 * `CLAUDE_CONFIG_DIR` points the reader at the fixture tree, so these tests
 * never read the developer's own `~/.claude` — which would make every
 * assertion depend on whatever the machine happened to be doing at the time,
 * and would pull real session content into a test run.
 */

let home: string;
let previousConfigDir: string | undefined;

const SESSION = "b70abc10-f01a-48de-8d41-8ac936e8eff8";
const PROJECT_DIR = "C--Users-someone-project";
const CWD = "C:\\Users\\someone\\project";
const T0 = Date.parse("2026-09-15T08:00:00.000Z");

function sessionsDir(): string {
  return join(home, ".claude", "sessions");
}

function projectDir(): string {
  return join(home, ".claude", "projects", PROJECT_DIR);
}

function transcriptPath(sessionId = SESSION): string {
  return join(projectDir(), `${sessionId}.jsonl`);
}

/** A registry entry shaped like the live one, control channel included so we can prove it is dropped. */
function writeRegistry(over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(sessionsDir(), "9492.json"),
    JSON.stringify({
      pid: 9492,
      sessionId: SESSION,
      cwd: CWD,
      startedAt: T0,
      version: "2.1.270",
      kind: "interactive",
      entrypoint: "claude-desktop",
      messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-deadbeef",
      name: "project-c4",
      status: "busy",
      statusUpdatedAt: T0,
      ...over,
    })
  );
}

function assistantLine(id: string, name = "Edit", fileName = "a.ts"): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid: `uuid-${id}`,
    timestamp: new Date(T0).toISOString(),
    gitBranch: "main",
    message: { content: [{ type: "tool_use", id, name, input: { file_path: fileName } }] },
  })}\n`;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tabdump-claude-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  mkdirSync(sessionsDir(), { recursive: true });
  mkdirSync(projectDir(), { recursive: true });
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  rmSync(home, { recursive: true, force: true });
  vi.resetModules();
});

/** Imported lazily so each test gets a module bound to the current fixture home. */
async function reader() {
  return import("./reader");
}

describe("availability", () => {
  it("reports available when a projects directory exists", async () => {
    const { isClaudeCodeAvailable } = await reader();

    expect(await isClaudeCodeAvailable()).toBe(true);
  });

  it("reports unavailable when there is no local installation", async () => {
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    const { isClaudeCodeAvailable, sweepSessions } = await reader();

    expect(await isClaudeCodeAvailable()).toBe(false);
    expect(await sweepSessions([], T0)).toEqual({ available: false, results: [] });
  });
});

describe("session registry", () => {
  it("reads a live session and maps its status", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), "");
    const { readSessionRegistry } = await reader();

    const entries = await readSessionRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe(SESSION);
    expect(entries[0].cwd).toBe(CWD);
    expect(entries[0].status).toBe("busy");
  });

  it("drops the control channel, so no later code can reach it", async () => {
    writeRegistry();
    const { readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    expect(entry).not.toHaveProperty("messagingSocketPath");
    expect(JSON.stringify(entry)).not.toContain("pipe");
  });

  it("skips entries with no valid session id or cwd", async () => {
    writeFileSync(join(sessionsDir(), "1.json"), JSON.stringify({ sessionId: "nope", cwd: CWD }));
    writeFileSync(join(sessionsDir(), "2.json"), JSON.stringify({ sessionId: SESSION }));
    writeRegistry();
    const { readSessionRegistry } = await reader();

    expect(await readSessionRegistry()).toHaveLength(1);
  });

  it("survives a malformed or half-written registry file", async () => {
    writeFileSync(join(sessionsDir(), "broken.json"), "{not json");
    writeRegistry();
    const { readSessionRegistry } = await reader();

    expect(await readSessionRegistry()).toHaveLength(1);
  });

  it("returns nothing when the sessions directory is absent", async () => {
    rmSync(sessionsDir(), { recursive: true, force: true });
    const { readSessionRegistry } = await reader();

    expect(await readSessionRegistry()).toEqual([]);
  });
});

describe("incremental transcript reading", () => {
  it("reads a small transcript from the beginning on first sight", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), assistantLine("toolu_1") + assistantLine("toolu_2"));
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const result = await readSessionActivity(entry, undefined, T0);

    expect(result.records.flatMap((r) => r.tools).map((t) => t.id)).toEqual([
      "toolu_1",
      "toolu_2",
    ]);
    expect(result.session.status).toBe("working");
    expect(result.session.title).toBe("project-c4");
  });

  it("returns nothing new when the file has not changed", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), assistantLine("toolu_1"));
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const first = await readSessionActivity(entry, undefined, T0);
    const second = await readSessionActivity(entry, first.cursor, T0);

    expect(second.records).toEqual([]);
    expect(second.cursor.offset).toBe(first.cursor.offset);
  });

  it("returns only what was appended since the last poll", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), assistantLine("toolu_1"));
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const first = await readSessionActivity(entry, undefined, T0);

    appendFileSync(transcriptPath(), assistantLine("toolu_2"));
    const second = await readSessionActivity(entry, first.cursor, T0);

    expect(second.records.flatMap((r) => r.tools).map((t) => t.id)).toEqual(["toolu_2"]);

    appendFileSync(transcriptPath(), assistantLine("toolu_3"));
    const third = await readSessionActivity(entry, second.cursor, T0);

    expect(third.records.flatMap((r) => r.tools).map((t) => t.id)).toEqual(["toolu_3"]);
  });

  it("does not parse a partial final line, and picks it up whole once completed", async () => {
    writeRegistry();
    const partial = assistantLine("toolu_1") + '{"type":"assistant","uuid":"hal';
    writeFileSync(transcriptPath(), partial);
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const first = await readSessionActivity(entry, undefined, T0);

    expect(first.records.flatMap((r) => r.tools).map((t) => t.id)).toEqual(["toolu_1"]);

    // The writer finishes the line it was in the middle of.
    writeFileSync(transcriptPath(), assistantLine("toolu_1") + assistantLine("toolu_2"));
    const second = await readSessionActivity(entry, first.cursor, T0);

    expect(second.records.flatMap((r) => r.tools).map((t) => t.id)).toEqual(["toolu_2"]);
  });

  it("consumes nothing when no complete line is available at all", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), '{"type":"assistant"');
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const result = await readSessionActivity(entry, undefined, T0);

    expect(result.records).toEqual([]);
    expect(result.cursor.offset).toBe(0);
  });

  it("skips a malformed line without losing the ones around it", async () => {
    writeRegistry();
    writeFileSync(
      transcriptPath(),
      assistantLine("toolu_1") + "{ this is not json }\n" + assistantLine("toolu_2")
    );
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const result = await readSessionActivity(entry, undefined, T0);

    expect(result.records.flatMap((r) => r.tools).map((t) => t.id)).toEqual([
      "toolu_1",
      "toolu_2",
    ]);
  });

  it("handles an empty transcript", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), "");
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const result = await readSessionActivity(entry, undefined, T0);

    expect(result.records).toEqual([]);
    expect(result.cursor.offset).toBe(0);
  });

  it("starts over when the file was truncated or replaced", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), assistantLine("toolu_1") + assistantLine("toolu_2"));
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const first = await readSessionActivity(entry, undefined, T0);
    expect(first.cursor.offset).toBeGreaterThan(0);

    // A different, shorter file now lives at the same path.
    writeFileSync(transcriptPath(), assistantLine("toolu_fresh"));
    const second = await readSessionActivity(entry, first.cursor, T0);

    expect(second.records.flatMap((r) => r.tools).map((t) => t.id)).toEqual(["toolu_fresh"]);
  });

  it("copes with a session whose transcript does not exist", async () => {
    writeRegistry();
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const result = await readSessionActivity(entry, undefined, T0);

    expect(result.records).toEqual([]);
    expect(result.session.externalId).toBe(SESSION);
  });

  it("reads correctly across a multi-byte character boundary", async () => {
    writeRegistry();
    const withUnicode = `${JSON.stringify({
      type: "assistant",
      uuid: "u1",
      timestamp: new Date(T0).toISOString(),
      message: {
        content: [{ type: "tool_use", id: "toolu_u", name: "Edit", input: { file_path: "café-日本.ts" } }],
      },
    })}\n`;
    writeFileSync(transcriptPath(), withUnicode);
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const first = await readSessionActivity(entry, undefined, T0);
    expect(first.records[0].tools[0].fileName).toBe("café-日本.ts");

    appendFileSync(transcriptPath(), assistantLine("toolu_next"));
    const second = await readSessionActivity(entry, first.cursor, T0);

    // The offset was in bytes, so the next read starts on a record boundary.
    expect(second.records.flatMap((r) => r.tools).map((t) => t.id)).toEqual(["toolu_next"]);
  });
});

describe("lifecycle signals", () => {
  it("reports an explicit release artifact", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), assistantLine("toolu_1"));
    writeFileSync(
      join(projectDir(), `${SESSION}.desktop-released.json`),
      JSON.stringify({ v: 1, releasedAt: new Date(T0).toISOString(), reason: "delete" })
    );
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const result = await readSessionActivity(entry, undefined, T0);

    expect(result.session.terminal).toBe("deleted");
  });

  it("reports no terminal signal when there is no artifact", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), assistantLine("toolu_1"));
    const { readSessionActivity, readSessionRegistry } = await reader();

    const [entry] = await readSessionRegistry();
    const result = await readSessionActivity(entry, undefined, T0);

    expect(result.session.terminal).toBeUndefined();
  });

  it("a session that simply vanishes leaves nothing behind to observe", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), assistantLine("toolu_1"));
    const { sweepSessions } = await reader();

    expect((await sweepSessions([], T0)).results).toHaveLength(1);

    // The process exits: its registry file goes, the transcript stays, and no
    // sidecar is written. This is the real observed behaviour, and it is why
    // disappearance is never treated as a terminal status.
    unlinkSync(join(sessionsDir(), "9492.json"));
    const after = await sweepSessions([], T0);

    expect(after.available).toBe(true);
    expect(after.results).toEqual([]);
  });
});

describe("path safety", () => {
  it("cannot be steered to a file outside the projects root by a forged cursor", async () => {
    writeRegistry();
    writeFileSync(transcriptPath(), assistantLine("toolu_1"));

    const secret = join(home, "secret.jsonl");
    writeFileSync(secret, assistantLine("toolu_secret"));

    const { sweepSessions } = await reader();
    // Cursors are validated before they get here; this asserts the reader
    // still only ever looks up the registry's own session ids.
    const sweep = await sweepSessions(
      [{ sessionId: SESSION, offset: 0, size: 0 }],
      T0
    );

    const ids = sweep.results.flatMap((r) => r.records.flatMap((rec) => rec.tools.map((t) => t.id)));
    expect(ids).not.toContain("toolu_secret");
  });
});
