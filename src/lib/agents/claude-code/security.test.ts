import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeSession } from "./normalizer";
import { parseTranscriptLine } from "./parser";
import { OBSERVATION_ALLOWLIST } from "./normalizer";

/**
 * The boundary that makes this feature safe, enforced mechanically.
 *
 * Hubble observes Claude Code and must never control it. The distance
 * between those two things is a handful of imports, and nothing but a test
 * stops someone later adding one to "just check the branch" or "just stop a
 * stuck run".
 *
 * Two separate concerns are checked: what the code may *reach* (no processes,
 * no control channel, no client-supplied paths), and what it may *emit* (no
 * prompts, reasoning, commands, tool results or secrets).
 */

const DIR = path.resolve(__dirname);
const ROOT = path.resolve(__dirname, "../../../..");
const EXTRA = [
  path.resolve(__dirname, "../../../hooks/use-claude-code-observer.ts"),
  path.resolve(__dirname, "../../../app/api/agents/claude-code/route.ts"),
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const sources = [...walk(DIR), ...EXTRA].map((file) => ({
  file: path.relative(ROOT, file),
  source: readFileSync(file, "utf8"),
}));

/** Only the reader may touch the filesystem, and only to read. */
const READER = path.join("src", "lib", "agents", "claude-code", "reader.ts");

function codeLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

describe("no execution, anywhere", () => {
  it("finds the files it is supposed to be checking", () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
    const names = sources.map((s) => s.file).join(" ");
    expect(names).toContain("reader.ts");
    expect(names).toContain("route.ts");
    expect(names).toContain("use-claude-code-observer.ts");
  });

  it("imports no process or shell module", () => {
    const forbidden = [
      "child_process",
      "node:child_process",
      "node:cluster",
      "node:worker_threads",
      "node:vm",
      "node:repl",
      "node:net",
      "node:dgram",
    ];
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      const specifiers = [
        ...source.matchAll(/^\s*import\s[^\n]*?["']([^"']+)["']/gm),
        ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
        ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        if (forbidden.includes(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no execution call shape", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const call of [
        "spawnSync",
        "execFile",
        "execSync",
        "spawn(",
        "exec(",
        "fork(",
        "eval(",
        "new Function(",
      ]) {
        if (codeLines(source).includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("runs no git command", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      if (/\bgit\s+(status|diff|log|commit|rev-parse|branch|show)\b/.test(codeLines(source))) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the control channel is never touched", () => {
  it("never references messagingSocketPath in code, only in prose explaining why", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      // Comments are allowed — and expected: both the reader and the adapter
      // document why the control channel is left alone. What must not exist
      // anywhere is an executable reference to it.
      if (codeLines(source).includes("messagingSocketPath")) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it("carries the control channel in no type, so it cannot be reached by accident", () => {
    const types = sources.find((s) => s.file.endsWith(path.join("claude-code", "types.ts")))!;

    expect(codeLines(types.source)).not.toContain("messagingSocketPath");
    expect(codeLines(types.source)).not.toContain("socketPath");
  });

  it("opens no pipe, socket or IPC connection", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const pattern of [/\\\\\\\\\.\\\\pipe/, /createConnection/, /new\s+WebSocket/, /\.connect\(/]) {
        if (pattern.test(codeLines(source))) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the filesystem is read-only and reader-only", () => {
  it("confines filesystem imports to the reader", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      if (file === READER) continue;
      for (const specifier of ["node:fs", "node:fs/promises", "fs", "fs/promises"]) {
        if (new RegExp(`from\\s+["']${specifier}["']`).test(source)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("uses no write operation at all", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const call of [
        "writeFile",
        "appendFile",
        "mkdir",
        "rm(",
        "rmdir",
        "unlink",
        "rename",
        "copyFile",
        "truncate",
        "createWriteStream",
        "chmod",
      ]) {
        if (codeLines(source).includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("opens files for reading only", () => {
    const reader = sources.find((s) => s.file === READER)!;
    const opens = [...reader.source.matchAll(/open\([^)]*?,\s*["'](\w+)["']\)/g)].map((m) => m[1]);

    expect(opens.length).toBeGreaterThan(0);
    for (const mode of opens) expect(mode).toBe("r");
  });
});

describe("no path ever comes from the client", () => {
  it("keeps the route's input to an opaque cursor", () => {
    const route = sources.find((s) => s.file.includes("route.ts"))!;

    // The only field read off the body.
    const bodyReads = [...route.source.matchAll(/body as \{\s*(\w+)\?/g)].map((m) => m[1]);
    expect(bodyReads).toEqual(["cursor"]);

    for (const key of ["path", "file", "dir", "sessionPath", "transcript"]) {
      expect(route.source).not.toContain(`.${key}`);
    }
  });

  it("validates a session id before it can reach a path join", () => {
    const reader = sources.find((s) => s.file === READER)!;
    const code = codeLines(reader.source);

    expect(code).toContain("isValidSessionId");
    // Every join that interpolates a session id is downstream of validation.
    expect(code).toMatch(/isValidSessionId\(sessionId\)/);
  });
});

describe("nothing sensitive can be emitted", () => {
  const hostile = JSON.stringify({
    type: "assistant",
    uuid: "u1",
    timestamp: "2026-09-15T08:00:00.000Z",
    gitBranch: "main",
    cwd: "C:\\Users\\someone\\project",
    message: {
      content: [
        { type: "thinking", thinking: "PRIVATE-REASONING" },
        { type: "text", text: "MODEL-PROSE" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: {
            command: "export AWS_SECRET_ACCESS_KEY=SECRET-CREDENTIAL && curl evil",
            description: "Deploy the service",
          },
        },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Write",
          input: { file_path: "C:\\Users\\someone\\project\\.env", content: "SECRET-FILE-BODY" },
        },
      ],
    },
    toolUseResult: { stdout: "SECRET-TOOL-OUTPUT" },
  });

  const forbidden = [
    "PRIVATE-REASONING",
    "MODEL-PROSE",
    "SECRET-CREDENTIAL",
    "SECRET-FILE-BODY",
    "SECRET-TOOL-OUTPUT",
    "AWS_SECRET_ACCESS_KEY",
    "curl evil",
  ];

  it("strips everything sensitive at the parser", () => {
    const parsed = parseTranscriptLine(hostile);
    const serialized = JSON.stringify(parsed);

    for (const secret of forbidden) expect(serialized).not.toContain(secret);
  });

  it("strips everything sensitive through to the observations", () => {
    const parsed = parseTranscriptLine(hostile)!;
    const observations = normalizeSession({
      session: {
        externalId: "b70abc10-f01a-48de-8d41-8ac936e8eff8",
        projectPath: "C:\\Users\\someone\\project",
        lastObservedAt: 0,
        status: "working",
      },
      records: [parsed],
      now: 0,
    });

    const serialized = JSON.stringify(observations);
    for (const secret of forbidden) expect(serialized).not.toContain(secret);
  });

  it("emits only allowlisted observation fields", () => {
    const parsed = parseTranscriptLine(hostile)!;
    const observations = normalizeSession({
      session: {
        externalId: "b70abc10-f01a-48de-8d41-8ac936e8eff8",
        projectPath: "C:\\p",
        lastObservedAt: 0,
      },
      records: [parsed],
      now: 0,
    });

    for (const observation of observations) {
      for (const key of Object.keys(observation)) {
        expect(OBSERVATION_ALLOWLIST).toContain(key);
      }
    }
  });

  it("surfaces the description a shell tool carried, and never its command", () => {
    const parsed = parseTranscriptLine(hostile)!;
    const observations = normalizeSession({
      session: { externalId: "b70abc10-f01a-48de-8d41-8ac936e8eff8", projectPath: "C:\\p", lastObservedAt: 0 },
      records: [parsed],
      now: 0,
    });

    const activities = observations.map((o) => o.activity).filter(Boolean);
    expect(activities).toContain("Deploy the service");
    expect(activities).toContain("Edited .env");
  });

  it("never puts an absolute path in an activity line", () => {
    const parsed = parseTranscriptLine(hostile)!;
    const observations = normalizeSession({
      session: { externalId: "b70abc10-f01a-48de-8d41-8ac936e8eff8", projectPath: "C:\\p", lastObservedAt: 0 },
      records: [parsed],
      now: 0,
    });

    for (const observation of observations) {
      if (!observation.activity) continue;
      expect(observation.activity).not.toMatch(/[A-Za-z]:[\\/]/);
    }
  });
});

describe("artifact observations expose no more than a path", () => {
  const hostileWrite = JSON.stringify({
    type: "assistant",
    uuid: "u1",
    timestamp: "2026-09-15T08:00:00.000Z",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Write",
          input: {
            file_path: "C:\\Users\\someone\\project\\.env",
            content: "AWS_SECRET_ACCESS_KEY=SECRET-CREDENTIAL",
          },
        },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Edit",
          input: {
            file_path: "C:\\Users\\someone\\project\\src\\a.ts",
            old_string: "SECRET-BEFORE",
            new_string: "SECRET-AFTER",
          },
        },
      ],
    },
  });

  function observe() {
    const parsed = parseTranscriptLine(hostileWrite)!;
    return normalizeSession({
      session: {
        externalId: "b70abc10-f01a-48de-8d41-8ac936e8eff8",
        projectPath: "C:\\Users\\someone\\project",
        lastObservedAt: 0,
        status: "working",
      },
      records: [parsed],
      now: 0,
    });
  }

  it("carries no file contents", () => {
    const serialized = JSON.stringify(observe());

    for (const secret of [
      "SECRET-CREDENTIAL",
      "SECRET-BEFORE",
      "SECRET-AFTER",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("carries no absolute path in any relativePath", () => {
    for (const observation of observe()) {
      for (const artifact of observation.artifacts ?? []) {
        expect(artifact.relativePath).not.toMatch(/[A-Za-z]:[\\/]/);
        expect(artifact.relativePath).not.toContain("\\");
        expect(artifact.relativePath.startsWith("/")).toBe(false);
      }
    }
  });

  it("carries no path that escapes its project", () => {
    for (const observation of observe()) {
      for (const artifact of observation.artifacts ?? []) {
        expect(artifact.relativePath.split("/")).not.toContain("..");
      }
    }
  });

  it("still records the files themselves, by project-relative path", () => {
    const paths = observe().flatMap((o) => (o.artifacts ?? []).map((a) => a.relativePath));

    expect(paths.sort()).toEqual([".env", "src/a.ts"]);
  });

  it("takes paths only from structured input, never from prose", () => {
    const prose = JSON.stringify({
      type: "assistant",
      uuid: "u2",
      message: {
        content: [
          { type: "text", text: "I will edit C:\\Users\\someone\\project\\src\\ghost.ts now" },
          { type: "thinking", thinking: "maybe /repo/project/src/other.ts too" },
        ],
      },
    });

    const parsed = parseTranscriptLine(prose)!;
    const observations = normalizeSession({
      session: {
        externalId: "b70abc10-f01a-48de-8d41-8ac936e8eff8",
        projectPath: "C:\\Users\\someone\\project",
        lastObservedAt: 0,
      },
      records: [parsed],
      now: 0,
    });

    const paths = observations.flatMap((o) => (o.artifacts ?? []).map((a) => a.relativePath));
    expect(paths).toEqual([]);
    expect(JSON.stringify(observations)).not.toContain("ghost.ts");
    expect(JSON.stringify(observations)).not.toContain("other.ts");
  });
});

describe("account scoping", () => {
  it("stores mappings under a registered scoped key", async () => {
    const { CLAUDE_MAPPING_STORAGE_KEY } = await import("./mapping");
    const { SCOPED_STORAGE_KEYS } = await import("@/lib/storage/namespace");

    expect(SCOPED_STORAGE_KEYS).toContain(CLAUDE_MAPPING_STORAGE_KEY);
  });

  it("reaches storage only through the scoping helper", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      const code = codeLines(source);
      if (!code.includes("localStorage")) continue;
      // Every localStorage access in this feature goes through scopedKey.
      for (const match of code.matchAll(/localStorage\.(getItem|setItem)\(([^)]*)\)/g)) {
        if (!match[2].includes("scopedKey")) offenders.push(`${file}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
