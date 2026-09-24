import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ENV_ALLOWLIST } from "./env";
import { PROVIDER_LAUNCH_TABLE } from "./allowlist";

/**
 * The launch layer's guard suite (Phase J).
 *
 * `lib/agents/launch/` is the only place outside a provider SDK where TabDump
 * starts a process. These tests pin what that means, by reading the source:
 * exactly which programs, with exactly which arguments, through no shell, with
 * an allowlisted environment, reachable only from the server wiring.
 */

const LAUNCH_DIR = path.resolve(__dirname);
const SRC_DIR = path.resolve(__dirname, "../../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const sources = walk(LAUNCH_DIR).map((file) => ({
  file: path.relative(SRC_DIR, file),
  name: path.basename(file),
  code: codeOf(readFileSync(file, "utf8")),
}));

describe("what TabDump can start", () => {
  it("is exactly this table", () => {
    expect(
      PROVIDER_LAUNCH_TABLE.map((entry) => ({
        provider: entry.provider,
        executables: entry.acp?.executables ?? [],
        args: entry.acp?.args ?? [],
      }))
    ).toEqual([
      { provider: "claude-code", executables: [], args: [] },
      { provider: "gemini", executables: ["gemini"], args: ["--acp"] },
      { provider: "openai-codex", executables: ["codex-acp"], args: [] },
      { provider: "grok", executables: ["grok"], args: ["agent", "stdio"] },
    ]);
  });

  it("pins the only CLI operations TabDump runs itself: Claude Code's own sign-in (Phase J.1)", () => {
    const natives = PROVIDER_LAUNCH_TABLE.filter((entry) => entry.native).map((entry) => ({
      provider: entry.provider,
      executables: entry.native!.executables,
      statusArgs: entry.native!.statusArgs,
      loginArgs: entry.native!.loginArgs,
    }));
    expect(natives).toEqual([
      {
        provider: "claude-code",
        executables: ["claude"],
        statusArgs: ["auth", "status", "--json"],
        loginArgs: {
          claudeai: ["auth", "login", "--claudeai"],
          console: ["auth", "login", "--console"],
        },
      },
    ]);
  });

  it("looks the operation's arguments up in the table rather than accepting them", () => {
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    expect(processCode).toContain("entry.statusArgs");
    expect(processCode).toContain("entry.loginArgs[operation.methodId]");
    // Own-property check, so a method id like "__proto__" cannot reach argv.
    expect(processCode).toContain("Object.prototype.hasOwnProperty.call(entry.loginArgs, operation.methodId)");
  });

  it("has no entry for a custom agent — a user-named program is never launched", () => {
    expect(PROVIDER_LAUNCH_TABLE.some((entry) => entry.provider === "custom")).toBe(false);
  });

  it("declares its argument lists as literals", () => {
    const allowlist = sources.find((entry) => entry.name === "allowlist.ts")!.code;
    const values = [...allowlist.matchAll(/args:\s*(\[[^\n]*)/g)];
    expect(values.length).toBe(3);
    for (const match of values) {
      expect(match[1]).toMatch(/^\[("[a-z-]+"(, )?)*\],?$/);
    }
  });
});

describe("how it starts it", () => {
  it("spawns in exactly one module, never with a shell", () => {
    const spawning = sources.filter((entry) => /\bspawn\s*\(/.test(entry.code));
    expect(spawning.map((entry) => entry.name)).toEqual(["process.ts"]);

    const processCode = spawning[0].code;
    expect(processCode).toContain("shell: false");
    expect(processCode).not.toMatch(/shell:\s*true/);
    for (const forbidden of ["exec(", "execSync", "execFile", "spawnSync", "eval(", "new Function("]) {
      expect(processCode).not.toContain(forbidden);
    }
  });

  it("passes the allowlist's arguments and appends nothing", () => {
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    // The only two argument shapes: the entry's own, or Node running the
    // package script with the entry's own.
    expect(processCode).toContain("[...entry.args]");
    expect(processCode).toContain("[resolved.script, ...entry.args]");
    expect(processCode).not.toMatch(/args\.push|\.concat\(/);
  });

  it("revalidates the working directory with the project validator", () => {
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    expect(processCode).toContain("validateProjectPath(request.projectPath)");
  });

  it("gives the agent an allowlisted environment with no key and no TabDump secret", () => {
    for (const name of AGENT_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|POSTGRES|DATABASE|TABDUMP|ANTHROPIC|OPENAI|GEMINI|XAI|CODEX/i);
    }
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    expect(processCode).toContain("env: agentEnvironment(options.env)");
  });

  it("is server-only", () => {
    const processCode = readFileSync(path.join(LAUNCH_DIR, "process.ts"), "utf8");
    expect(processCode.startsWith('import "server-only";')).toBe(true);
  });
});

describe("who can reach it", () => {
  it("is imported only by the server wiring", () => {
    const importers: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file.startsWith(LAUNCH_DIR)) continue;
      const code = codeOf(readFileSync(file, "utf8"));
      if (/from\s+["'][^"']*agents\/launch\//.test(code)) importers.push(path.relative(SRC_DIR, file));
    }
    // The web's local runtime and the desktop app's runtime sidecar (Phase J.1).
    expect(importers.map((file) => file.replace(/\\/g, "/")).sort()).toEqual([
      "lib/agents/runtime/desktop.ts",
      "lib/agents/runtime/server.ts",
    ]);
  });

  it("never reads a sign-in marker's contents — presence only", () => {
    const detect = sources.find((entry) => entry.name === "detect.ts")!.code;
    expect(detect).toContain("isFile(");
    expect(detect).not.toContain("readText(");
  });
});
