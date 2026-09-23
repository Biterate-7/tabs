import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createFakeSandboxService } from "./__fixtures__/sandbox";
import { createRemoteProject } from "./projects";
import { createMemoryRemoteStore } from "./store";
import { isSandboxName, mintSandboxName } from "./sandbox";
import { AGENT_BRIDGE_SOURCE } from "./bridge";
import { RUNTIME_COMMAND_NAMES } from "@/lib/agents/runtime/protocol";
import {
  decideRemoteRuntime,
  decideServerRuntime,
  LOCAL_RUNTIME_ENV_VALUE,
  LOCAL_RUNTIME_ENV_VAR,
} from "@/lib/agents/control/runtime";

/**
 * The guards on the second path in TabDump that executes anything.
 *
 * Phase I makes a hosted deployment able to run a real agent. Every rule that
 * keeps that safe is checked here, because every one of them fails silently if
 * left to review.
 */

const DIR = path.resolve(__dirname);
const REPO_ROOT = path.resolve(DIR, "../../../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__fixtures__" ? [] : walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const sources = walk(DIR).map((file) => ({
  file: path.relative(REPO_ROOT, file),
  name: path.basename(file),
  source: readFileSync(file, "utf8"),
}));

function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * 1. The local boundary did not move
 * ------------------------------------------------------------------ */

describe("the local execution boundary is unchanged", () => {
  it("still refuses local execution on a hosted platform, opt-in or not", () => {
    // The single most important regression this phase could have introduced.
    expect(decideServerRuntime({ VERCEL: "1" })).toEqual({
      allowed: false,
      kind: "hosted",
      reason: "hosted-platform",
    });

    // And the opt-in cannot override the veto — the exact mistake an operator
    // is most likely to make.
    expect(
      decideServerRuntime({ VERCEL: "1", [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE })
    ).toEqual({ allowed: false, kind: "hosted", reason: "hosted-platform" });
  });

  it("still denies by default when nothing is configured", () => {
    expect(decideServerRuntime({})).toEqual({
      allowed: false,
      kind: "unknown",
      reason: "not-opted-in",
    });
  });
});

/* ------------------------------------------------------------------ *
 * 2. The remote plane fails closed
 * ------------------------------------------------------------------ */

describe("the remote plane fails closed", () => {
  it("refuses with no sandbox credentials", () => {
    expect(decideRemoteRuntime({}, { durableStore: true })).toEqual({
      allowed: false,
      reason: "no-sandbox-credentials",
    });
  });

  it("refuses with no durable store, even holding credentials", () => {
    // A sandbox created with nowhere to record its identity is a microVM that
    // is running, billing, and unreachable.
    expect(decideRemoteRuntime({ VERCEL_OIDC_TOKEN: "t" }, { durableStore: false })).toEqual({
      allowed: false,
      reason: "no-durable-store",
    });
  });

  it("refuses a partial access-token trio rather than treating it as progress", () => {
    expect(
      decideRemoteRuntime(
        { VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "prj" },
        { durableStore: true }
      )
    ).toEqual({ allowed: false, reason: "no-sandbox-credentials" });
  });

  it("allows only with both halves", () => {
    expect(decideRemoteRuntime({ VERCEL_OIDC_TOKEN: "t" }, { durableStore: true })).toEqual({
      allowed: true,
      credentials: "oidc",
    });
  });

  it("never consults NODE_ENV", () => {
    // A production build is not a statement about whether this deployment has
    // been given the infrastructure to run agents.
    const runtime = readFileSync(
      path.join(REPO_ROOT, "src/lib/agents/control/runtime.ts"),
      "utf8"
    );
    expect(codeOf(runtime)).not.toContain("NODE_ENV");
  });

  it("loads the sandbox SDK through a specifier the deployment tracer can follow", () => {
    // A variable inside an ignored import is invisible to the build's file
    // tracer, so the SDK was missing from every deployed agent route and the
    // catch below it quietly reported "unavailable" on Vercel. Only a literal
    // specifier puts the package into the function.
    const impl = codeOf(readFileSync(path.join(DIR, "sandbox-vercel.ts"), "utf8"));
    expect(impl).toContain('import("@vercel/sandbox")');
  });
});

/* ------------------------------------------------------------------ *
 * 3. No arbitrary execution surface
 * ------------------------------------------------------------------ */

describe("no arbitrary shell or filesystem surface", () => {
  it("exposes no general command primitive on the sandbox seam", () => {
    // The platform SDK offers "run this string in a microVM". Exposing it here
    // would mean the remote plane's safety rested on every future caller
    // choosing not to pass user input into it.
    const seam = codeOf(readFileSync(path.join(DIR, "sandbox.ts"), "utf8"));

    for (const forbidden of ["runCommand", "exec(", "spawn(", "shell", "argv"]) {
      expect(seam.includes(forbidden), `sandbox.ts must not expose ${forbidden}`).toBe(false);
    }
  });

  it("builds the one command it runs entirely from constants", () => {
    const impl = readFileSync(path.join(DIR, "sandbox-vercel.ts"), "utf8");

    // Every `runCommand` in the implementation names a literal binary. If a
    // variable ever appears in `cmd:`, this fails.
    const commands = impl.match(/cmd:\s*([^,\n]+)/g) ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/cmd:\s*"(npm|node)"/);
    }
  });

  it("keeps every sandbox path rooted in a constant", () => {
    const impl = codeOf(readFileSync(path.join(DIR, "sandbox-vercel.ts"), "utf8"));

    // Paths are template-joined to a constant root, never taken whole from an
    // argument. A `path: ` that is a bare parameter would be the hole.
    const paths = impl.match(/path:\s*`[^`]*`/g) ?? [];
    for (const entry of paths) {
      expect(entry).toMatch(/\$\{REMOTE_(WORKSPACE_ROOT|CONTROL_ROOT|INBOX_DIR)\}/);
    }
  });

  it("gives the browser no way to name a sandbox", () => {
    // The protocol is a closed union. If a command could carry a sandbox id,
    // the server's resolution of projectId → sandbox would be bypassable.
    const protocol = readFileSync(
      path.join(REPO_ROOT, "src/lib/agents/runtime/protocol.ts"),
      "utf8"
    );

    expect(codeOf(protocol)).not.toMatch(/sandbox/i);
    // And the vocabulary did not grow a bytes-carrying verb.
    expect(RUNTIME_COMMAND_NAMES).toHaveLength(14);
  });

  it("writes an inbox file that a caller's label cannot escape", async () => {
    const sandbox = createFakeSandboxService();
    await sandbox.ensure({ sandboxName: "tabdump-abc123", timeoutMs: 1000, allowedHosts: [] });

    // The slug is applied in the real implementation; here we assert the
    // contract the seam documents — a label, never a path.
    await sandbox.writeInbox("tabdump-abc123", "../../escape", { kind: "message", text: "x" });

    const call = sandbox.calls.find((entry) => entry.kind === "writeInbox");
    expect(call?.kind === "writeInbox" && call.name).toBe("../../escape");

    // And the real implementation strips it to `[a-z0-9-]`.
    const impl = readFileSync(path.join(DIR, "sandbox-vercel.ts"), "utf8");
    expect(impl).toContain('replace(/[^a-z0-9-]/gi, "")');
  });
});

/* ------------------------------------------------------------------ *
 * 4. Sandbox identity
 * ------------------------------------------------------------------ */

describe("sandbox identity", () => {
  it("mints names that reveal nothing and are recognisable as ours", () => {
    const first = mintSandboxName();
    const second = mintSandboxName();

    expect(first).not.toBe(second);
    expect(isSandboxName(first)).toBe(true);
    // The prefix is what lets a reclamation sweep list this deployment's
    // sandboxes without touching anything else in the same project.
    expect(first.startsWith("tabdump-")).toBe(true);
  });

  it("rejects anything that is not one of ours", () => {
    for (const bogus of ["", "sandbox-1", "tabdump-", "tabdump-AB!", "../tabdump-abc12345"]) {
      expect(isSandboxName(bogus), bogus).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. The bridge
 * ------------------------------------------------------------------ */

describe("the in-sandbox bridge", () => {
  it("is a constant, with no hole a caller could reach", () => {
    // The bridge is the one thing this system executes. As a constant with
    // only compile-time interpolations, it is provable by inspection that
    // nothing a user supplies ever becomes code.
    const bridge = readFileSync(path.join(DIR, "bridge.ts"), "utf8");
    const template = bridge.slice(bridge.indexOf("AGENT_BRIDGE_SOURCE = `"));
    const holes = template.match(/\$\{[^}]+\}/g) ?? [];

    for (const hole of holes) {
      // Only constants from ./types.ts, serialized.
      expect(hole).toMatch(/JSON\.stringify\(REMOTE_[A-Z_]+\)|REMOTE_LIMITS\.[a-zA-Z]+/);
    }
  });

  it("never grants a tool on its own authority", () => {
    // Every exit from the permission wait is a `settle(...)`, and the only
    // `granted` path is one where a decision file arrived.
    expect(AGENT_BRIDGE_SOURCE).toContain('behavior: "allow"');
    // The allow is reached only through `settle`, which requires `granted`.
    expect(AGENT_BRIDGE_SOURCE).toMatch(/const settle = \(granted, reason\)/);
    // And the deadline path denies.
    expect(AGENT_BRIDGE_SOURCE).toContain("No decision was made in time.");
  });

  it("inherits no MCP servers the user configured elsewhere", () => {
    expect(AGENT_BRIDGE_SOURCE).toContain("mcpServers: {}");
    expect(AGENT_BRIDGE_SOURCE).toContain("strictMcpConfig: true");
  });

  it("runs the agent in the project workspace, not the control directory", () => {
    expect(AGENT_BRIDGE_SOURCE).toContain("cwd: WORKSPACE");
  });
});

/* ------------------------------------------------------------------ *
 * 6. Credentials
 * ------------------------------------------------------------------ */

describe("credentials", () => {
  it("has no column, field or storage for one", () => {
    const schema = readFileSync(path.join(DIR, "schema.sql"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .toLowerCase();

    for (const forbidden of ["api_key", "token", "secret", "password", "credential"]) {
      expect(schema.includes(forbidden), `schema must have no ${forbidden}`).toBe(false);
    }
  });

  it("writes nothing to browser storage anywhere in the remote plane", () => {
    for (const { file, source } of sources) {
      const code = codeOf(source);
      expect(code.includes("localStorage"), file).toBe(false);
      expect(code.includes("sessionStorage"), file).toBe(false);
      expect(code.includes("document.cookie"), file).toBe(false);
    }
  });

  it("logs nothing from the remote plane", () => {
    // A cloud platform's error text can carry a token; a log line is the
    // easiest place for one to end up.
    for (const { file, source } of sources) {
      const code = codeOf(source);
      expect(code.includes("console.log"), file).toBe(false);
      expect(code.includes("console.error"), file).toBe(false);
    }
  });

  it("keeps a created project's record free of anything secret-shaped", async () => {
    const store = createMemoryRemoteStore();
    const sandbox = createFakeSandboxService();

    const created = await createRemoteProject(
      { store, sandbox },
      {
        ownerId: "account:alice",
        name: "API service",
        scopes: ["read_project"],
        files: [{ path: "a.ts", content: new Uint8Array([1]) }],
      }
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const serialized = JSON.stringify(created.project).toLowerCase();
    for (const forbidden of ["apikey", "anthropic", "token", "secret", "password"]) {
      expect(serialized.includes(forbidden), forbidden).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. Egress
 * ------------------------------------------------------------------ */

describe("egress", () => {
  it("is deny-by-default with an explicit allowlist", async () => {
    const store = createMemoryRemoteStore();
    const sandbox = createFakeSandboxService();

    await createRemoteProject(
      { store, sandbox },
      {
        ownerId: "account:alice",
        name: "API service",
        scopes: [],
        files: [{ path: "a.ts", content: new Uint8Array([1]) }],
      }
    );

    const ensure = sandbox.calls.find((call) => call.kind === "ensure");
    expect(ensure?.kind === "ensure" && [...ensure.input.allowedHosts]).toEqual([
      "api.anthropic.com",
      "registry.npmjs.org",
    ]);
  });

  it("does not allow the sandbox to reach this deployment", () => {
    // Which is why the control channel is files rather than a callback: there
    // is no credential inside the microVM that could reach back.
    const runtime = readFileSync(
      path.join(REPO_ROOT, "src/lib/agents/control/providers/claude-code/remote-runtime.ts"),
      "utf8"
    );
    const allowlist = runtime.slice(
      runtime.indexOf("ALLOWED_EGRESS"),
      runtime.indexOf("] as const")
    );

    expect(allowlist).not.toMatch(/vercel\.app|localhost|tabsdump/i);
  });
});
