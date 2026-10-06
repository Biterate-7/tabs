import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ENV_ALLOWLIST } from "./env";
import { PROVIDER_LAUNCH_TABLE } from "./allowlist";

/**
 * The launch layer's guard suite (Phase J).
 *
 * `lib/agents/launch/` is the only place outside a provider SDK where Hubble
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
  // A Windows checkout (core.autocrlf) ends lines in \r\n; the checks below
  // are about the code, not its line endings.
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

/** Codex 0.159.0's app-server launch, verified (docs/codex-app-server.md). */
const CODEX_APP_SERVER_ARGS = [
  "app-server", "--listen", "stdio://",
  "--disable", "unified_exec_tty", "--disable", "view_image", "--disable", "multi_agent", "--disable", "multi_agent_v2",
  "--disable", "apps", "--disable", "plugins", "--disable", "remote_plugin", "--disable", "plugin_sharing",
  "--disable", "tool_suggest", "--disable", "hooks", "--disable", "computer_use", "--disable", "browser_use",
  "--disable", "browser_use_external", "--disable", "browser_use_full_cdp_access", "--disable", "in_app_browser",
  "--disable", "image_generation", "--disable", "skill_mcp_dependency_install", "--disable", "shell_snapshot",
  "--disable", "workspace_dependencies", "--disable", "realtime_conversation", "--disable", "guardian_approval",
  "--disable", "goals", "--disable", "memories", "--disable", "worktrees",
  "-c", "web_search=disabled", "-c", "check_for_update_on_startup=false",
];

const sources = walk(LAUNCH_DIR).map((file) => ({
  file: path.relative(SRC_DIR, file),
  name: path.basename(file),
  code: codeOf(readFileSync(file, "utf8")),
}));

describe("what Hubble can start", () => {
  it("is exactly this table", () => {
    expect(
      PROVIDER_LAUNCH_TABLE.map((entry) => ({
        provider: entry.provider,
        executables: (entry.acp ?? entry.appServer)?.executables ?? [],
        args: (entry.acp ?? entry.appServer)?.args ?? [],
      }))
    ).toEqual([
      { provider: "claude-code", executables: [], args: [] },
      { provider: "gemini", executables: ["gemini"], args: ["--acp", "--approval-mode", "default"] },
      { provider: "openai-codex", executables: ["codex"], args: CODEX_APP_SERVER_ARGS },
      { provider: "grok", executables: ["grok"], args: ["agent", "--no-leader", "stdio"] },
    ]);
  });

  it("pins, per agent, the modes in which it asks before acting — or that none does (Phase J.2)", () => {
    expect(
      PROVIDER_LAUNCH_TABLE.filter((entry) => entry.acp).map((entry) => ({
        provider: entry.provider,
        approval: entry.acp!.approval.kind === "asking-mode" ? entry.acp!.approval.modeIds : "unavailable",
      }))
    ).toEqual([
      { provider: "gemini", approval: ["default"] },
      { provider: "grok", approval: ["ask", "default"] },
    ]);
    // Codex is no longer driven through codex-acp, whose modes all acted
    // unasked; it is an app-server agent (below), and nothing launches codex-acp.
    expect(JSON.stringify(PROVIDER_LAUNCH_TABLE)).not.toContain("codex-acp");
  });

  it("pins every Codex switch that keeps it asking — verified against Codex 0.159.0", () => {
    const codex = PROVIDER_LAUNCH_TABLE.find((entry) => entry.provider === "openai-codex")!.appServer!;
    const disabled = codex.args.flatMap((arg, index) => (codex.args[index - 1] === "--disable" ? [arg] : []));
    // Interactive terminals: `write_stdin` into an approved shell ran further input unasked.
    expect(disabled).toContain("unified_exec_tty");
    // Read any image on disk without asking.
    expect(disabled).toContain("view_image");
    for (const surface of ["multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "computer_use", "browser_use", "browser_use_external", "image_generation"]) {
      expect(disabled).toContain(surface);
    }
    // Hosted web search off; the server on this process's own pipes.
    expect(codex.args).toContain("web_search=disabled");
    expect(codex.args.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
    for (const arg of codex.args) {
      // Never loosen approval, never widen the sandbox, never switch anything
      // on, and never touch the Windows sandbox (its elevated mode raises an
      // administrator prompt by itself).
      expect(arg).not.toMatch(/never|danger|full-access|yolo|bypass|on-request|auto_review|^--enable$|windows\.sandbox|approval_policy|sandbox_mode/);
    }
    // Code mode stays ON (real-agent QA, 2026-09-30): the default model runs
    // every command through it, and its cells are a bare JavaScript isolate —
    // no fs, fetch, import, process or WebAssembly — whose only way to act is
    // Codex's own tools (exec_command, apply_patch), which ask Hubble.
    expect(disabled).not.toContain("code_mode_host");
    expect(codex.verifiedPlatforms).toEqual(["win32"]);
    expect(codex.minimumVersion).toBe("0.159.0");
  });

  it("points Codex at Hubble's own folder — the user's CODEX_HOME is never inherited", () => {
    const codex = PROVIDER_LAUNCH_TABLE.find((entry) => entry.provider === "openai-codex")!.appServer!;
    expect(codex.homeEnv).toBe("CODEX_HOME");
    expect(AGENT_ENV_ALLOWLIST).not.toContain("CODEX_HOME");
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    expect(processCode).toContain("{ ...agentEnvironment(options.env), [entry.homeEnv]: home }");
    expect(processCode).toContain("prepareCodexHome(home, options.homeFs ?? realCodexHomeFs, platform)");
  });

  it("runs Codex's own sign-in with a literal argument list, looked up with an own-property check", () => {
    const codex = PROVIDER_LAUNCH_TABLE.find((entry) => entry.provider === "openai-codex")!.appServer!;
    expect(codex.loginArgs).toEqual({ chatgpt: ["login"] });
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    expect(processCode).toContain("Object.prototype.hasOwnProperty.call(entry.loginArgs, methodId)");
    expect(processCode).toContain("const loginArgs = entry.loginArgs[methodId];");
  });

  it("never lists a mode in which an agent approves its own actions as an asking mode", () => {
    for (const entry of PROVIDER_LAUNCH_TABLE) {
      const approval = entry.acp?.approval;
      if (approval?.kind !== "asking-mode") continue;
      for (const modeId of approval.modeIds) {
        expect(modeId).not.toMatch(/yolo|auto|always|bypass|full|accept|dont/i);
      }
    }
  });

  it("pins the flags that keep a session inside Hubble's approvals and process tree", () => {
    const gemini = PROVIDER_LAUNCH_TABLE.find((entry) => entry.provider === "gemini")!.acp!.args;
    // Overrides a user setting of yolo or auto_edit.
    const at = gemini.indexOf("--approval-mode");
    expect(gemini.slice(at, at + 2)).toEqual(["--approval-mode", "default"]);
    // Grok's leader mode would run the session in a shared process outside the job object.
    expect(PROVIDER_LAUNCH_TABLE.find((entry) => entry.provider === "grok")!.acp!.args).toContain("--no-leader");
    for (const entry of PROVIDER_LAUNCH_TABLE) {
      for (const arg of entry.acp?.args ?? []) {
        expect(arg).not.toMatch(/yolo|always-approve|dangerously|bypass|^--leader$/);
      }
    }
  });

  it("follows npm shims only into the vendors' own packages", () => {
    expect(PROVIDER_LAUNCH_TABLE.flatMap((entry) => (entry.acp ?? entry.appServer)?.npmPackages ?? [])).toEqual([
      "@google/gemini-cli",
      "@openai/codex",
      "@xai-official/grok",
    ]);
  });

  // Changed deliberately (Agent Authentication & Runtime): the Claude.ai
  // subscription login (`--claudeai`) is gone. Anthropic does not permit an
  // app built on the Claude Agent SDK to offer it; only the Console sign-in
  // ("API usage billing instead of a Claude subscription") remains.
  it("pins the only CLI operations Hubble runs itself: Claude Code's own Console sign-in (Phase J.1)", () => {
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
          console: ["auth", "login", "--console"],
        },
      },
    ]);
  });

  it("never offers a subscription login anywhere in the table", () => {
    const allowlist = sources.find((entry) => entry.name === "allowlist.ts")!.code;
    expect(allowlist).not.toContain('"--claudeai"');
    for (const entry of PROVIDER_LAUNCH_TABLE) {
      expect(Object.keys(entry.native?.loginArgs ?? {})).not.toContain("claudeai");
    }
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
      // Plain tokens only — Codex's feature names and `key=value` settings
      // included — and nothing interpolated, spread or computed.
      expect(match[1]).toMatch(/^\[("[a-z0-9_=:/.-]+"(, )?)*\],?$/);
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

  it("passes the allowlist's arguments, plus only a validated context server name after the entry's own flag (J.4)", () => {
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    // The only two argument shapes: the entry's own, or Node running the
    // package script with the entry's own — each followed by the context
    // arguments, which are empty unless the session has a context server.
    expect(processCode).toContain("[...entry.args, ...contextArgs]");
    expect(processCode).toContain("[resolved.script, ...entry.args, ...contextArgs]");
    expect(processCode).not.toMatch(/\bargs\.push|\.concat\(/);
    // The one push: the entry's literal flag and a name in the minted shape.
    expect(processCode.match(/contextArgs\.push\([^)]*\)/g)).toEqual([
      "contextArgs.push(entry.contextIdentity.allowlistFlag, request.contextServerName)",
    ]);
    expect(processCode).toContain(
      'entry.contextIdentity.kind !== "exclusive-mcp" || !isContextServerName(request.contextServerName)'
    );
  });

  it("pins how each agent's context calls are proven, verified from its source (J.4)", () => {
    const identity = Object.fromEntries(
      PROVIDER_LAUNCH_TABLE.filter((entry) => entry.acp).map((entry) => [entry.provider, entry.acp!.contextIdentity])
    );
    expect(identity.gemini).toEqual({
      kind: "exclusive-mcp",
      allowlistFlag: "--allowed-mcp-server-names",
      mcpConfirmationOptionIds: ["proceed_always_server", "proceed_always_tool"],
    });
    expect(identity.grok?.kind).toBe("unavailable");
    // Codex takes its context server in `thread/start`, not on its command
    // line: an app-server launch appends nothing to the entry's arguments.
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    expect(processCode).toContain("resolved.kind === \"native\" ? [...entry.args] : [resolved.script, ...entry.args]");
  });

  it("revalidates the working directory with the project validator", () => {
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    expect(processCode).toContain("validateProjectPath(request.projectPath)");
  });

  it("gives the agent an allowlisted environment with no key and no Hubble secret", () => {
    for (const name of AGENT_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|POSTGRES|DATABASE|TABDUMP|ANTHROPIC|OPENAI|GEMINI|XAI|CODEX/i);
    }
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    expect(processCode).toContain("env: agentEnvironment(options.env)");
  });

  it("marks every spawned executable as machine-local, so a hosted build does not trace the whole project into its server function", () => {
    // Without it, Next's tracer assumes a runtime-computed program path could
    // be any project file and ships all of them (~1,300 files) in the
    // `/api/agents/control` function on every deployment — where this module
    // is present but, behind the hosted-platform veto, never spawns.
    const processCode = sources.find((entry) => entry.name === "process.ts")!.code;
    const spawns = processCode.match(/\bspawn\s*\([^,]*,/g) ?? [];
    expect(spawns.length).toBeGreaterThan(0);
    for (const call of spawns) expect(call).toMatch(/^spawn\(\/\*turbopackIgnore: true\*\/ \w+,$/);
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
      // The project check runner (Hubble 1.6) reuses the resolver and the
      // agents' environment — never the launcher.
      "lib/agents/project-host/checks.ts",
      "lib/agents/runtime/desktop.ts",
      "lib/agents/runtime/server.ts",
    ]);
  });

  it("does not decide sign-in from files: detection has no home directory and no marker (Phase J.2)", () => {
    const detect = sources.find((entry) => entry.name === "detect.ts")!.code;
    expect(detect).not.toMatch(/homeDirectory|homedir|signIn|marker/i);
    const allowlist = sources.find((entry) => entry.name === "allowlist.ts")!.code;
    expect(allowlist).not.toMatch(/signInMarkers|credentials\.json|oauth_creds|auth\.json/);
  });
});
