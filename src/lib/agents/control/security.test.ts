import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createControlService } from "./service";
import { createApprovalBroker } from "./approvals";
import { createUnimplementedControlAdapter } from "./unimplemented";
import { createClaudeCodeControlSeam } from "./providers/claude-code";
import { createCodexControlAdapter } from "./providers/codex";
import { capabilitySet, NO_CAPABILITIES } from "./capabilities";
import { createGrant, isCapabilityPermitted, isGranted } from "./permissions";
import { containsPath, createProject, validateProjectPath } from "./projects";
import {
  allowDesktopRuntime,
  decideServerRuntime,
  denyNonServerRuntime,
  LOCAL_RUNTIME_ENV_VALUE,
  LOCAL_RUNTIME_ENV_VAR,
} from "./runtime";
import type { AgentControlEvent } from "./events";
import type { AgentControlAdapter, ControlResult } from "./types";
import type { AgentCapabilitySet } from "./capabilities";
import type { AgentProject } from "./projects";

/**
 * The control plane's structural guards.
 *
 * ## What changed, and why these replace rather than relax the old rules
 *
 * TabDump's agent layer was read-only, enforced by guard suites that fail the
 * build if anything under `lib/agents/` gains a way to act. The command
 * centre needs to act, so the invariant has been **split** rather than
 * softened:
 *
 * > TabDump observes agents through the observation plane, and communicates
 * > with agents through a separately permissioned control plane.
 *
 * The observation guards are **untouched**. `connectors/security.test.ts`,
 * `claude-code/security.test.ts` and `agents/security.test.ts` still assert
 * that no observation module can execute, write or reach a control channel,
 * and those suites still pass unmodified — which is the point. Nothing was
 * deleted to make room for this file.
 *
 * What this suite adds is the second half: the control plane may act, and
 * every gate on that acting is checked mechanically, because every one of
 * them fails silently if left to review.
 */

const CONTROL_DIR = path.resolve(__dirname);
const AGENTS_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.resolve(__dirname, "../../..");
const REPO_ROOT = path.resolve(SRC_DIR, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__fixtures__" || entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const controlSources = walk(CONTROL_DIR).map((file) => ({
  file: path.relative(REPO_ROOT, file),
  name: path.basename(file),
  source: readFileSync(file, "utf8"),
}));

/** Code lines only — prose legitimately discusses what is deliberately *not* done. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const T0 = 1_700_000_000_000;

function project(over: Partial<AgentProject> = {}): AgentProject {
  const made = createProject(
    { id: "p1", name: "Research", path: "C:/work/research", providers: ["claude-code"] },
    T0
  );
  if (!made.ok) throw new Error("fixture failed");
  return { ...made.project, ...over };
}

/** An adapter that claims everything and records what reached it. */
function spyAdapter(capabilities: AgentCapabilitySet): AgentControlAdapter & { calls: string[] } {
  const calls: string[] = [];
  const base = createUnimplementedControlAdapter({ provider: "claude-code", detail: "test" });

  return {
    ...base,
    calls,
    getCapabilities: () => capabilities,
    createSession: async () => {
      calls.push("createSession");
      return { ok: true, value: { sessionId: "s1", status: "ready" } } as ControlResult<{
        sessionId: string;
        status: "ready";
      }>;
    },
    sendMessage: async () => {
      calls.push("sendMessage");
      return { ok: true, value: undefined };
    },
    cancelRun: async () => {
      calls.push("cancelRun");
      return { ok: true, value: undefined };
    },
    respondToApproval: async () => {
      calls.push("respondToApproval");
      return { ok: true, value: undefined };
    },
  } as AgentControlAdapter & { calls: string[] };
}

/* ------------------------------------------------------------------ *
 * 1–2. The observation plane still cannot act
 * ------------------------------------------------------------------ */

describe("the observation plane is unchanged", () => {
  it("still forbids execution and filesystem access in the connector layer", () => {
    // Asserted from here as well as in the connector layer's own suite, so
    // that someone adding control cannot "fix" a failure over there by
    // relaxing it without this failing too.
    const connectorSources = walk(path.join(AGENTS_DIR, "connectors")).map((file) => ({
      file: path.relative(REPO_ROOT, file),
      source: readFileSync(file, "utf8"),
    }));

    expect(connectorSources.length).toBeGreaterThanOrEqual(10);

    const offenders: string[] = [];
    for (const { file, source } of connectorSources) {
      const code = codeOf(source);
      for (const forbidden of ["child_process", "node:fs", "spawn(", "execFile", "execSync"]) {
        if (code.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the read-only connector contract free of any acting member", () => {
    const contract = readFileSync(path.join(AGENTS_DIR, "connectors/types.ts"), "utf8");
    const declaration = contract.slice(contract.indexOf("export interface AgentConnector"));
    const members = [...declaration.matchAll(/^\s{2}(?:readonly\s+)?(\w+)[(:]/gm)].map((m) => m[1]);

    for (const forbidden of ["sendMessage", "createSession", "cancelRun", "exec", "prompt"]) {
      expect(members).not.toContain(forbidden);
    }
  });

  it("keeps the observation adapter seam free of any acting member", () => {
    const adapter = readFileSync(path.join(AGENTS_DIR, "adapter.ts"), "utf8");
    const declared = [...adapter.matchAll(/^\s{2}(?:readonly\s+)?(\w+)[(:]/gm)].map((m) => m[1]);

    for (const forbidden of ["start", "stop", "kill", "cancel", "exec", "prompt", "sendMessage"]) {
      expect(declared).not.toContain(forbidden);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. No unrestricted shell or filesystem API
 * ------------------------------------------------------------------ */

describe("the control plane exposes no general-purpose escape hatch", () => {
  it("finds the files it is supposed to be checking", () => {
    expect(controlSources.length).toBeGreaterThanOrEqual(10);
    const names = controlSources.map((entry) => entry.name);
    expect(names).toContain("service.ts");
    expect(names).toContain("runtime.ts");
    expect(names).toContain("permissions.ts");
  });

  it("declares no function that would run an arbitrary command", () => {
    // The single most dangerous thing this plane could grow. A structured,
    // scoped operation is the design; `shell(cmd)` is its negation.
    const offenders: string[] = [];
    for (const { file, source } of controlSources) {
      for (const pattern of [
        /\bfunction\s+(shell|exec|execute|runCommand|runShell|spawn)\s*\(/,
        /\b(shell|exec|execute|runShell)\s*:\s*\(/,
        /\bexport\s+(async\s+)?function\s+run\s*\(/,
      ]) {
        if (pattern.test(codeOf(source))) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("declares no function that would read or write an arbitrary path", () => {
    const offenders: string[] = [];
    for (const { file, source } of controlSources) {
      for (const pattern of [
        /\bfunction\s+(readFile|writeFile|deleteFile|listDirectory|readDir)\s*\(/,
        /\b(readFile|writeFile|readDir)\s*:\s*\(/,
      ]) {
        if (pattern.test(codeOf(source))) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("imports no process, shell or filesystem module in the domain layer", () => {
    // The control *domain* is pure and runs in the browser. The runtime that
    // eventually spawns a process is a separate, server-only module which
    // does not exist yet; when it does, it lives outside this directory and
    // gets its own guard. Nothing here may reach for one meanwhile.
    const forbidden = [
      "child_process",
      "node:child_process",
      "node:fs",
      "node:fs/promises",
      "fs/promises",
      "node:path",
      "node:net",
      "node:os",
      "node:worker_threads",
      "node:vm",
    ];

    const offenders: string[] = [];
    for (const { file, source } of controlSources) {
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
    for (const { file, source } of controlSources) {
      for (const call of [
        "spawnSync",
        "execFile",
        "execSync",
        "spawn(",
        "exec(",
        "eval(",
        "new Function(",
      ]) {
        if (codeOf(source).includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. UI cannot reach an adapter
 * ------------------------------------------------------------------ */

describe("components cannot reach a runtime", () => {
  it("no component imports a control adapter or the adapter contract", () => {
    // The transport requirement, made structural: a React component talks to
    // the service, and the service holds the adapters. A component importing
    // an adapter would be one refactor away from calling it directly.
    const componentFiles = walk(path.join(SRC_DIR, "components"));
    expect(componentFiles.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of componentFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of [
        /from\s+["'][^"']*control\/providers\//,
        /from\s+["'][^"']*control\/unimplemented/,
        /createClaudeCodeControlAdapter/,
        /createCodexControlAdapter/,
      ]) {
        if (pattern.test(source)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("no component or hook spawns a process", () => {
    const files = [...walk(path.join(SRC_DIR, "components")), ...walk(path.join(SRC_DIR, "hooks"))];

    const offenders: string[] = [];
    for (const file of files) {
      const code = codeOf(readFileSync(file, "utf8"));
      for (const forbidden of ["child_process", "spawn(", "execFile", "execSync"]) {
        if (code.includes(forbidden)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${forbidden}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 5. The runtime boundary fails closed
 * ------------------------------------------------------------------ */

describe("hosted execution fails closed", () => {
  it("denies an empty environment", () => {
    // The default answer is no. Not "no unless something looks local".
    expect(decideServerRuntime({})).toMatchObject({ allowed: false, reason: "not-opted-in" });
  });

  it("denies a non-server context outright", () => {
    expect(denyNonServerRuntime()).toMatchObject({
      allowed: false,
      reason: "no-server-context",
    });
  });

  it("allows only the exact opt-in value", () => {
    for (const value of ["1", "true", "yes", "on", "", "0", "false", LOCAL_RUNTIME_ENV_VALUE.toUpperCase()]) {
      expect(decideServerRuntime({ [LOCAL_RUNTIME_ENV_VAR]: value }).allowed).toBe(false);
    }

    expect(
      decideServerRuntime({ [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE }).allowed
    ).toBe(true);
  });

  it("refuses a hosted platform even when the opt-in is set", () => {
    // The mistake most likely to actually happen: pasting the opt-in into a
    // hosting dashboard. The veto is ordered before the opt-in for this case.
    for (const marker of ["VERCEL", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "DYNO", "K_SERVICE"]) {
      const decision = decideServerRuntime({
        [marker]: "1",
        [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE,
      });

      expect(decision).toMatchObject({ allowed: false, reason: "hosted-platform" });
    }
  });

  it("never consults a forgeable signal", () => {
    // Each of these is either chosen by the client or true on somebody
    // else's server. None may appear in the decision.
    const source = codeOf(readFileSync(path.join(CONTROL_DIR, "runtime.ts"), "utf8"));

    for (const forbidden of [
      "localhost",
      "127.0.0.1",
      "::1",
      "userAgent",
      "navigator",
      "__TAURI_INTERNALS__",
      "headers",
      "NODE_ENV",
      "referer",
      "origin",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("reaches no global of its own", () => {
    // The decision is a pure function of an environment it is *handed*. A
    // module that read `process.env` itself could be reached from a bundle
    // where that object had been shimmed.
    const source = codeOf(readFileSync(path.join(CONTROL_DIR, "runtime.ts"), "utf8"));
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("globalThis");
    expect(source).not.toContain("window.");
  });

  it("refuses every operation when the runtime denies", () => {
    const adapter = spyAdapter(capabilitySet("create_session", "message", "cancel_run"));
    const service = createControlService({
      runtime: denyNonServerRuntime,
      resolveAdapter: () => adapter,
      resolveProject: () => project(),
      now: () => T0,
    });

    return Promise.all([
      service.startSession({ provider: "claude-code" }),
      service.cancelRun("anything"),
    ]).then(([started]) => {
      expect(started).toMatchObject({ ok: false, error: { code: "runtime-denied" } });
      expect(adapter.calls).toEqual([]);
    });
  });

  it("only the desktop adapter may assert a desktop runtime", () => {
    // `allowDesktopRuntime` is the one function that returns `allowed` without
    // consulting anything. Nothing may call it except a desktop entry point,
    // and nothing does yet.
    const callers = controlSources.filter(
      (entry) => entry.name !== "runtime.ts" && codeOf(entry.source).includes("allowDesktopRuntime")
    );

    expect(callers.map((entry) => entry.file)).toEqual([]);
    expect(allowDesktopRuntime()).toMatchObject({ allowed: true, kind: "local-desktop" });
  });
});

/* ------------------------------------------------------------------ *
 * 6–8. Registration, capability and permission gates
 * ------------------------------------------------------------------ */

const ALLOW = () => ({ allowed: true as const, kind: "local-server" as const });

describe("an unregistered provider cannot execute", () => {
  it("refuses when no adapter resolves", () => {
    const service = createControlService({
      runtime: ALLOW,
      resolveAdapter: () => undefined,
      now: () => T0,
    });

    return service.startSession({ provider: "grok" }).then((result) => {
      expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
    });
  });
});

describe("an undeclared capability cannot be invoked", () => {
  it("refuses before the adapter is reached", async () => {
    // The adapter here *implements* createSession perfectly well. It simply
    // does not declare the capability, and that alone must stop it.
    const adapter = spyAdapter(NO_CAPABILITIES);
    const service = createControlService({
      runtime: ALLOW,
      resolveAdapter: () => adapter,
      now: () => T0,
    });

    const result = await service.startSession({ provider: "claude-code" });

    expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(adapter.calls).toEqual([]);
  });

  it("refuses a capability the adapter did not declare, even when others are declared", async () => {
    const adapter = spyAdapter(capabilitySet("create_session"));
    const service = createControlService({
      runtime: ALLOW,
      resolveAdapter: () => adapter,
      now: () => T0,
    });

    const started = await service.startSession({ provider: "claude-code" });
    expect(started.ok).toBe(true);

    const sessionId = started.ok ? started.value.id : "";
    const sent = await service.sendMessage({
      sessionId,
      text: "hello",
      context: { attachments: [] },
    });

    expect(sent).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(adapter.calls).toEqual(["createSession"]);
  });
});

describe("project scope must be explicitly supplied", () => {
  it("denies a local-effect capability with no project", () => {
    const grant = createGrant(["write_project"], T0, "p1")!;

    expect(isCapabilityPermitted("write_files", grant, undefined)).toBe(false);
    expect(isCapabilityPermitted("read_files", grant, undefined)).toBe(false);
    expect(isCapabilityPermitted("run_commands", grant, undefined)).toBe(false);
  });

  it("denies a grant for a different project", () => {
    const grant = createGrant(["write_project"], T0, "p1")!;
    expect(isGranted(grant, "write_project", "p2")).toBe(false);
    expect(isGranted(grant, "write_project", "p1")).toBe(true);
  });

  it("refuses a project-scoped grant that names no project", () => {
    // Not a broad grant — an invalid one.
    expect(createGrant(["write_project"], T0)).toBeNull();
  });

  it("denies an unknown project id at the service", async () => {
    const adapter = spyAdapter(capabilitySet("create_session"));
    const service = createControlService({
      runtime: ALLOW,
      resolveAdapter: () => adapter,
      resolveProject: () => undefined,
      now: () => T0,
    });

    const result = await service.startSession({ provider: "claude-code", projectId: "ghost" });

    expect(result).toMatchObject({ ok: false, error: { code: "project-denied" } });
    expect(adapter.calls).toEqual([]);
  });

  it("denies a project this provider is not authorized for", async () => {
    const adapter = spyAdapter(capabilitySet("create_session"));
    const service = createControlService({
      runtime: ALLOW,
      resolveAdapter: () => adapter,
      // Authorized for Claude Code only.
      resolveProject: () => project({ providers: ["openai-codex"] }),
      now: () => T0,
    });

    const result = await service.startSession({ provider: "claude-code", projectId: "p1" });

    expect(result).toMatchObject({ ok: false, error: { code: "project-denied" } });
    expect(adapter.calls).toEqual([]);
  });
});

describe("a provider adapter cannot reach an arbitrary path", () => {
  it("refuses a filesystem root as a project", () => {
    for (const root of ["/", "C:/", "c:\\", "D:", "//server"]) {
      expect(validateProjectPath(root).ok).toBe(false);
    }
  });

  it("refuses a home directory or a well-known user folder", () => {
    for (const location of [
      "C:/Users",
      "C:/Users/alice/Desktop",
      "C:/Users/alice/Documents",
      "/home",
      "/Users/alice/Downloads",
      "C:/Users/alice/.ssh",
      "C:/Windows/System32",
    ]) {
      expect(validateProjectPath(location).ok).toBe(false);
    }
  });

  it("refuses a path that has not been resolved", () => {
    for (const candidate of ["C:/work/../../etc", "/repo/./thing", "C:relative", "  "]) {
      expect(validateProjectPath(candidate).ok).toBe(false);
    }
  });

  it("refuses containment for anything outside the project", () => {
    const scoped = project();
    expect(scoped.path).toBe("C:/work/research");

    for (const outside of [
      "C:/work/other/file.ts",
      // The separator case: a sibling whose name starts with the project's.
      "C:/work/research-other/file.ts",
      "C:/Windows/System32/config",
      "../../../etc/passwd",
      "/etc/passwd",
    ]) {
      expect(containsPath(scoped, outside).ok).toBe(false);
    }

    // And still resolves what genuinely is inside it.
    expect(containsPath(scoped, "C:/work/research/src/App.tsx")).toEqual({
      ok: true,
      relativePath: "src/App.tsx",
    });
  });
});

/* ------------------------------------------------------------------ *
 * 9. Approvals cannot be bypassed
 * ------------------------------------------------------------------ */

describe("approval-required operations cannot bypass the broker", () => {
  it("gives an adapter no way to mint its own approval", () => {
    // An adapter that could call the broker could mint one already granted.
    // It raises an `approval_requested` event instead, and the service routes
    // it. Asserted structurally because the interface is the whole defence.
    const contract = readFileSync(path.join(CONTROL_DIR, "types.ts"), "utf8");
    const declaration = contract.slice(contract.indexOf("export interface AgentControlAdapter"));
    const members = [...declaration.matchAll(/^\s{2}(\w+)[(:]/gm)].map((m) => m[1]);

    expect(members).toContain("respondToApproval");
    expect(members).not.toContain("requestApproval");
    expect(members).not.toContain("grantApproval");
    expect(members).not.toContain("approve");
  });

  it("no provider adapter imports the broker", () => {
    const providerFiles = walk(path.join(CONTROL_DIR, "providers"));
    expect(providerFiles.length).toBeGreaterThanOrEqual(2);

    for (const file of providerFiles) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("createApprovalBroker");
      expect(source).not.toMatch(/from\s+["'][^"']*approvals["']/);
    }
  });

  it("a granted decision cannot be overturned afterwards", () => {
    const broker = createApprovalBroker();
    const made = broker.request(
      {
        id: "a1",
        sessionId: "s1",
        provider: "claude-code",
        action: "modify_files",
        scope: "write_project",
        projectId: "p1",
        targets: ["notes.md"],
      },
      T0
    );
    expect(made.ok).toBe(true);

    expect(broker.resolve("a1", "denied", T0 + 10).ok).toBe(true);
    // A late "granted" must not resurrect a denied request.
    expect(broker.resolve("a1", "granted", T0 + 20)).toMatchObject({
      ok: false,
      reason: "already-resolved",
    });
    expect(broker.get("a1")?.status).toBe("denied");
  });

  it("expires to denied rather than lingering as answerable", () => {
    const broker = createApprovalBroker();
    broker.request(
      {
        id: "a2",
        sessionId: "s1",
        provider: "claude-code",
        action: "run_command",
        scope: "run_commands",
        projectId: "p1",
        targets: ["build"],
        ttlMs: 1000,
      },
      T0
    );

    expect(broker.resolve("a2", "granted", T0 + 5000)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(broker.get("a2")?.status).toBe("expired");
  });

  it("refuses an approval that names no project", () => {
    const broker = createApprovalBroker();
    const result = broker.request(
      {
        id: "a3",
        sessionId: "s1",
        provider: "claude-code",
        action: "modify_files",
        scope: "write_project",
        projectId: "",
        targets: ["x.md"],
      },
      T0
    );

    expect(result).toMatchObject({ ok: false, reason: "missing-project" });
  });

  it("refuses an approval target that escapes the project", () => {
    const broker = createApprovalBroker();
    const result = broker.request(
      {
        id: "a4",
        sessionId: "s1",
        provider: "claude-code",
        action: "modify_files",
        scope: "write_project",
        projectId: "p1",
        targets: ["../../etc/passwd", "/etc/shadow", "C:/Windows/x"],
      },
      T0
    );

    // Every target was invalid, so nothing is left to approve.
    expect(result).toMatchObject({ ok: false, reason: "no-targets" });
  });

  it("will not talk over a session that is waiting on an approval", async () => {
    let emit: ((event: AgentControlEvent) => void) | null = null;
    const adapter = spyAdapter(capabilitySet("create_session", "message", "approvals"));
    adapter.subscribeToEvents = (listener) => {
      emit = listener;
      return () => {
        emit = null;
      };
    };

    const service = createControlService({
      runtime: ALLOW,
      resolveAdapter: () => adapter,
      now: () => T0,
    });

    const started = await service.startSession({ provider: "claude-code" });
    expect(started.ok).toBe(true);
    const sessionId = started.ok ? started.value.id : "";

    // Driven through the real path rather than by setting a field: the
    // adapter raises `approval_requested`, the service moves the session into
    // `waiting_for_approval`, and a message must then be refused rather than
    // racing the decision.
    expect(emit).not.toBeNull();
    emit!({
      id: "e1",
      sessionId,
      provider: "claude-code",
      kind: "approval_requested",
      timestamp: T0,
      summary: "wants to modify files",
      approvalId: "a9",
    });

    expect(service.session(sessionId)?.status).toBe("waiting_for_approval");

    const blocked = await service.sendMessage({
      sessionId,
      text: "hi",
      context: { attachments: [] },
    });

    expect(blocked).toMatchObject({ ok: false, error: { code: "approval-required" } });
    // The claim is that the *message* never reached the provider. The adapter
    // is also told how the approval was answered — this one is denied, because
    // this adapter raised a request it cannot describe and nothing
    // undescribable may be granted — and that call is not the one under test.
    expect(adapter.calls).not.toContain("sendMessage");
  });

  it("denies an approval the adapter cannot describe, rather than leaving the provider blocked", async () => {
    // An adapter raises an approval by emitting an event and holds the
    // provider's decision open until it is told an answer. If the service
    // could not mint a broker record — here because the adapter offers no
    // detail accessor at all — the honest outcome is a denial. The two
    // failures it rules out are opposite and both bad: granting something
    // nobody could evaluate, and leaving a provider waiting forever on a
    // decision that can never be made.
    let emit: ((event: AgentControlEvent) => void) | null = null;
    const adapter = spyAdapter(capabilitySet("create_session", "message", "approvals"));
    adapter.subscribeToEvents = (listener) => {
      emit = listener;
      return () => {
        emit = null;
      };
    };

    const service = createControlService({
      runtime: ALLOW,
      resolveAdapter: () => adapter,
      now: () => T0,
    });

    const started = await service.startSession({ provider: "claude-code" });
    const sessionId = started.ok ? started.value.id : "";

    emit!({
      id: "e1",
      sessionId,
      provider: "claude-code",
      kind: "approval_requested",
      timestamp: T0,
      summary: "wants to modify files",
      approvalId: "a9",
    });

    expect(adapter.calls).toContain("respondToApproval");
    // And nothing was recorded as answerable, so there is no route by which a
    // later `respondToApproval` could grant it after the fact.
    expect(service.approvals.get("a9")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 10. Provider specifics stay behind the adapter
 * ------------------------------------------------------------------ */

describe("provider-specific detail stays behind the control adapter", () => {
  it("names no provider in the generic control modules", () => {
    // The contract must read identically whether or not Claude Code exists.
    const generic = controlSources.filter((entry) => !entry.file.includes("providers"));

    const offenders: string[] = [];
    for (const { file, source } of generic) {
      const code = codeOf(source);
      for (const pattern of [/\bclaude[-_]?code\b/i, /\bcodex\b/i, /\bgemini\b/i, /\bgrok\b/i]) {
        if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("carries no provider CLI vocabulary anywhere in the contract", () => {
    const contract = codeOf(readFileSync(path.join(CONTROL_DIR, "types.ts"), "utf8"));

    for (const flag of [
      "permissionMode",
      "allowedTools",
      "disallowedTools",
      "addDir",
      "add-dir",
      "mcpConfig",
      "outputFormat",
      "forkSession",
      "maxBudget",
      "argv",
      "--",
    ]) {
      expect(contract).not.toContain(flag);
    }
  });

  it("gives a control event nowhere to carry a command or a payload", () => {
    const events = codeOf(readFileSync(path.join(CONTROL_DIR, "events.ts"), "utf8"));

    for (const forbidden of ["command:", "argv:", "script:", "shell:", "stdout:", "stderr:", "contents:", "diff:", "patch:"]) {
      expect(events.toLowerCase()).not.toContain(forbidden);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 11. Nothing is faked
 * ------------------------------------------------------------------ */

describe("what the browser catalogue registers claims nothing", () => {
  // The browser cannot spawn a Claude Code process and must not carry the
  // code that could, so what the catalogue registers is an honest "not
  // drivable from here" — see providers/claude-code/index.ts. The REAL
  // adapter and its genuine capabilities are covered in
  // providers/claude-code/adapter.test.ts.
  it("declares no capability for either registered provider", () => {
    for (const adapter of [createClaudeCodeControlSeam(), createCodexControlAdapter()]) {
      expect([...adapter.getCapabilities()]).toEqual([]);
    }
  });

  it("refuses every operation", async () => {
    for (const adapter of [createClaudeCodeControlSeam(), createCodexControlAdapter()]) {
      const results = await Promise.all([
        adapter.connect(),
        adapter.createSession({
          sessionId: "s1",
          permissions: { scopes: [], grantedAt: T0 },
          attachments: [],
        }),
        adapter.resumeSession({
          sessionId: "s1",
          providerSessionId: "x",
          permissions: { scopes: [], grantedAt: T0 },
        }),
        adapter.sendMessage({ sessionId: "s1", text: "hi", context: { attachments: [] } }),
        adapter.cancelRun("s1"),
        adapter.respondToApproval("a1", "granted"),
      ]);

      for (const result of results) {
        expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
      }
    }
  });

  it("never reports itself connected", () => {
    for (const adapter of [createClaudeCodeControlSeam(), createCodexControlAdapter()]) {
      expect(adapter.getConnectionStatus().kind).toBe("unavailable");
    }
  });

  it("has no code path that emits an event", () => {
    // The structural reason no fabricated activity can appear: the
    // unimplemented adapter accepts a listener and holds no way to call it.
    const source = codeOf(readFileSync(path.join(CONTROL_DIR, "unimplemented.ts"), "utf8"));

    expect(source).not.toMatch(/listener\s*\(\s*\{/);
    expect(source).not.toContain("emit(");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("setTimeout");
  });

  it("delivers no event through a real adapter subscription", () => {
    const events: unknown[] = [];
    const adapter = createClaudeCodeControlSeam();
    const unsubscribe = adapter.subscribeToEvents((event) => events.push(event));

    expect(events).toEqual([]);
    unsubscribe();
  });
});

/* ------------------------------------------------------------------ *
 * 12. No credential reaches storage
 * ------------------------------------------------------------------ */

describe("the control plane persists no secret", () => {
  /*
    The one exception, and exactly where it lives (Phase J.3): the two
    adapters that hand an agent its session's TabDump context credential put
    it in an Authorization header. The credential is issued by the runtime per
    session, held only in memory, revoked when the session ends — and never a
    field of anything the control plane declares or stores. Each entry must
    still match: an exception that is no longer needed fails this test.
  */
  const SESSION_CONTEXT_HEADER = new Map<string, RegExp>([
    [path.join("src", "lib", "agents", "control", "providers", "acp", "adapter.ts"), /\bbearer\b/i],
    [path.join("src", "lib", "agents", "control", "providers", "claude-code", "sdk-runtime.ts"), /\bbearer\b/i],
  ]);

  it("declares no credential field anywhere", () => {
    const offenders: string[] = [];
    const excused: string[] = [];
    for (const { file, source } of controlSources) {
      const code = codeOf(source);
      for (const pattern of [
        /\bapiKey\b/i,
        /\baccessToken\b/i,
        /\brefreshToken\b/i,
        /\bsecret\s*:/i,
        /\bpassword\b/i,
        /\bcredential\s*:/i,
        /\bbearer\b/i,
      ]) {
        if (!pattern.test(code)) continue;
        if (String(SESSION_CONTEXT_HEADER.get(file)) === String(pattern)) excused.push(file);
        else offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
    expect(excused.sort()).toEqual([...SESSION_CONTEXT_HEADER.keys()].sort());
  });

  it("builds the session context header only from the session's own entry", () => {
    // ACP: the token comes from the request's contextServer, nowhere else —
    // and only when the agent has a proven context identity (J.4).
    const acp = codeOf(readFileSync(path.join(CONTROL_DIR, "providers", "acp", "adapter.ts"), "utf8"));
    expect(acp.match(/Bearer \$\{[^}]+\}/g)).toEqual(["Bearer ${contextServer.token}"]);
    expect(acp).toContain("const contextServer = contextIdentity && request.contextServer ? request.contextServer : undefined;");
    // Claude: the header is a template Claude Code expands from its own
    // environment, so the token is never on the command line.
    const claude = codeOf(readFileSync(path.join(CONTROL_DIR, "providers", "claude-code", "sdk-runtime.ts"), "utf8"));
    expect(claude).toMatch(/Authorization: "Bearer " \+ "\$" \+ "\{" \+ CONTEXT_TOKEN_ENV \+ "\}"/);
    expect(claude).not.toMatch(/Bearer \$\{/);
  });

  it("registers both of its keys as account-scoped", async () => {
    // A project record names a directory one account authorized. Another
    // account in the same browser must never inherit it.
    const { SCOPED_STORAGE_KEYS } = await import("@/lib/storage/namespace");
    const { CONTROL_PROJECTS_KEY, CONTROL_SESSIONS_KEY } = await import("./persistence");

    expect(SCOPED_STORAGE_KEYS).toContain(CONTROL_SESSIONS_KEY);
    expect(SCOPED_STORAGE_KEYS).toContain(CONTROL_PROJECTS_KEY);
  });

  it("touches only its own two keys", () => {
    const source = readFileSync(path.join(CONTROL_DIR, "persistence.ts"), "utf8");
    const keys = new Set<string>();
    for (const match of codeOf(source).matchAll(/["'](tabdump:[^"']+)["']/g)) keys.add(match[1]);

    expect([...keys].sort()).toEqual(["tabdump:agent-projects:v1", "tabdump:agent-sessions:v1"]);
  });
});
