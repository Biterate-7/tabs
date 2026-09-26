import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRuntimeHost, LOCAL_ACTOR } from "./host";
import { createScriptedAdapter } from "./__fixtures__/adapter";
import { parseRuntimeCommand, RUNTIME_COMMAND_NAMES } from "./protocol";
import { assertLocalExecutionAllowed } from "./gate";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeCommand } from "./protocol";

/**
 * The local execution surface's structural guards.
 *
 * ## What this file is for
 *
 * Phase F gives Hubble something it did not have: a path by which a browser
 * can cause a process to run on the user's machine. Every one of the
 * properties that makes that safe fails *silently* if it regresses — a gate
 * that stops being crossed, a command union that grows a passthrough, a
 * status object that starts carrying a path — so each is asserted here
 * mechanically rather than left to review.
 *
 * The observation plane's guards, the control plane's guards and the context
 * bridge's guards are all untouched and all still pass. Nothing here replaces
 * one of them; this is the layer they did not previously cover.
 */

const RUNTIME_DIR = path.resolve(__dirname);
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

/** Code lines only — prose legitimately discusses what is deliberately *not* done. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const runtimeSources = walk(RUNTIME_DIR).map((file) => ({
  file: path.relative(REPO_ROOT, file),
  name: path.basename(file),
  source: readFileSync(file, "utf8"),
}));

const T0 = 1_700_000_000_000;

const ALLOWED: ExecutionGateResult = {
  allowed: true,
  environment: "local",
  kind: "local",
  decision: { allowed: true, kind: "local-server" },
};

/** Every command, in a form the parser accepts. Used to sweep the whole surface at once. */
const EVERY_COMMAND: RuntimeCommand[] = [
  { name: "get_status" },
  { name: "list_sessions" },
  { name: "get_session", sessionId: "s1" },
  { name: "get_events", sessionId: "s1" },
  { name: "authorize_projects", projects: [] },
  { name: "create_session", provider: "claude-code" },
  { name: "resume_session", provider: "claude-code", providerSessionId: "p1" },
  { name: "send_message", sessionId: "s1", text: "hi" },
  { name: "cancel_run", sessionId: "s1" },
  {
    name: "attach_context",
    sessionId: "s1",
    context: { snapshotId: "snap", capturedAt: T0, attachments: [] },
  },
  { name: "detach_context", sessionId: "s1" },
  { name: "respond_to_approval", approvalId: "a1", decision: "granted" },
  { name: "dispose_session", sessionId: "s1" },
  {
    name: "link_observation",
    sessionId: "s1",
    observationAgentId: "a",
    observationRunId: "r",
  },
];

/* ------------------------------------------------------------------ *
 * 1. The surface has no general-purpose escape hatch
 * ------------------------------------------------------------------ */

describe("the runtime exposes no arbitrary execution", () => {
  it("finds the files it is supposed to be checking", () => {
    const names = runtimeSources.map((entry) => entry.name);
    expect(names).toContain("host.ts");
    expect(names).toContain("protocol.ts");
    expect(names).toContain("gate.ts");
    expect(names).toContain("client.ts");
    expect(names).toContain("server.ts");
  });

  it("declares no command that would run something arbitrary", () => {
    // The single most dangerous thing this surface could grow. The union
    // being closed is what makes this assertion writable at all.
    for (const forbidden of [
      "exec",
      "execute_command",
      "spawn",
      "shell",
      "run_command",
      "read_file",
      "write_file",
      "list_directory",
      "provider_call",
      "raw",
    ]) {
      expect(RUNTIME_COMMAND_NAMES as readonly string[]).not.toContain(forbidden);
    }
  });

  it("declares no function that would run an arbitrary command", () => {
    const offenders: string[] = [];
    for (const { file, source } of runtimeSources) {
      for (const pattern of [
        /\bfunction\s+(shell|exec|execute|runCommand|runShell|spawn)\s*\(/,
        /\b(shell|exec|execute|runShell)\s*:\s*\(/,
      ]) {
        if (pattern.test(codeOf(source))) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no execution call shape anywhere in the module", () => {
    const offenders: string[] = [];
    for (const { file, source } of runtimeSources) {
      for (const call of [
        "child_process",
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

    // The runtime *routes* provider operations; the provider adapter is the
    // only place allowed to invoke a provider runtime, and it reaches the SDK
    // rather than a shell.
    expect(offenders).toEqual([]);
  });

  it("reaches no filesystem module", () => {
    const forbidden = [
      "node:fs",
      "fs",
      "node:fs/promises",
      "fs/promises",
      "node:path",
      "node:os",
      "node:net",
      "node:worker_threads",
      "node:vm",
    ];

    const offenders: string[] = [];
    for (const { file, source } of runtimeSources) {
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

  it("gives a command nowhere to put a path", () => {
    // A project is named by id and resolved by the host. There is no field on
    // any command that a directory could travel in — except the project
    // record itself, which is revalidated on arrival.
    const parsed = parseRuntimeCommand({
      name: "create_session",
      provider: "claude-code",
      projectId: "p1",
      path: "C:/",
      cwd: "C:/",
      additionalDirectories: ["C:/Users"],
    });

    expect(JSON.stringify(parsed)).not.toContain("C:/");
  });
});

/* ------------------------------------------------------------------ *
 * 2. The browser cannot be the runtime
 * ------------------------------------------------------------------ */

describe("the browser is never the execution runtime", () => {
  it("no component or hook imports the host, the server wiring or an adapter", () => {
    const files = [
      ...walk(path.join(SRC_DIR, "components")),
      ...walk(path.join(SRC_DIR, "hooks")),
    ];
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of [
        /from\s+["'][^"']*runtime\/host["']/,
        /from\s+["'][^"']*runtime\/server["']/,
        /from\s+["'][^"']*control\/providers\//,
        /createRuntimeHost/,
        /getRuntimeHost/,
      ]) {
        if (pattern.test(source)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the browser client free of anything that could execute", () => {
    const client = codeOf(
      readFileSync(path.join(RUNTIME_DIR, "client.ts"), "utf8")
    );

    for (const forbidden of [
      "child_process",
      "createRuntimeHost",
      "ControlService",
      "createControlService",
      "Adapter",
      "process.env",
    ]) {
      expect(client).not.toContain(forbidden);
    }
  });

  it("marks the server wiring server-only", () => {
    // A bundler that pulled this into the browser graph would be shipping the
    // shape of the execution capability to every visitor of a hosted
    // deployment.
    const server = readFileSync(path.join(RUNTIME_DIR, "server.ts"), "utf8");
    expect(server.startsWith('import "server-only";')).toBe(true);
  });

  it("reads the real environment in exactly one place", () => {
    // The gate is a pure function of an environment it is handed. Exactly one
    // module supplies the real one, and it is the server-only wiring.
    const readers = runtimeSources.filter((entry) => codeOf(entry.source).includes("process.env"));
    expect(readers.map((entry) => entry.name)).toEqual(["server.ts"]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Hosted and unknown runtimes fail closed
 * ------------------------------------------------------------------ */

describe("a runtime that has not proved itself local executes nothing", () => {
  const refusals: [string, ExecutionGateResult][] = [
    ["an empty environment", assertLocalExecutionAllowed({})],
    ["a production build", assertLocalExecutionAllowed({ NODE_ENV: "production" })],
    ["a Vercel deployment", assertLocalExecutionAllowed({ VERCEL: "1", VERCEL_ENV: "production" })],
    ["a Lambda", assertLocalExecutionAllowed({ AWS_LAMBDA_FUNCTION_NAME: "hubble" })],
    ["a generic hosted Node", assertLocalExecutionAllowed({ RENDER: "true" })],
    [
      "a hosted platform with the opt-in pasted in",
      assertLocalExecutionAllowed({
        VERCEL: "1",
        TABDUMP_LOCAL_AGENT_RUNTIME: "i-am-running-tabdump-on-my-own-machine",
      }),
    ],
  ];

  for (const [label, gate] of refusals) {
    it(`refuses every command on ${label}`, async () => {
      const adapter = createScriptedAdapter({ now: () => T0 });
      const host = createRuntimeHost({
        gate,
        resolveAdapter: () => adapter,
        providers: ["claude-code"],
        now: () => T0,
        runtimeId: "r",
      });

      for (const command of EVERY_COMMAND) {
        if (command.name === "get_status") {
          const status = await host.execute(LOCAL_ACTOR, command);
          expect(status.ok).toBe(true);
          expect(status.ok && status.value.executable).toBe(false);
          continue;
        }

        const result = await host.execute(LOCAL_ACTOR, command as never);
        expect(result).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
      }

      // Nothing reached the provider at all.
      expect(adapter.calls).toEqual([]);
      expect(adapter.live()).toEqual([]);
    });
  }

  it("does not even hold a resolver on a refused runtime, in the shipped wiring", () => {
    // The host refuses before dispatch anyway; withholding the resolver means
    // a process that may not execute has no code path that could construct a
    // provider runtime at all.
    //
    // Asserted as a property of the source rather than as one exact sentence,
    // because the previous version of this test pinned a literal expression
    // and broke the moment the wiring grew a second execution plane — while
    // the property it cared about was still true. What matters is that the
    // resolver is *conditional on the gate*, and that the refusing branch
    // yields nothing.
    const server = codeOf(readFileSync(path.join(RUNTIME_DIR, "server.ts"), "utf8"));

    // The invariant is now carried by a closed union rather than by a chain of
    // conjuncts: a resolution is `remote`, `local` or `refused`, and the
    // remote arm *carries* the infrastructure it needs. There is therefore no
    // way to reach an adapter-bearing branch without having proved the
    // adapter can be built, and no fourth state to fall through to.
    expect(server).toMatch(/mode:\s*"remote"/);
    expect(server).toMatch(/mode:\s*"local"/);
    expect(server).toMatch(/mode:\s*"refused"/);

    // Dispatch is an exhaustive switch, not an `if` with a fallthrough. A
    // fourth mode would be a type error rather than a silent local host
    // carrying an allowing remote gate.
    expect(server).toMatch(/switch \(resolution\.mode\)/);
    expect(server).not.toMatch(/gate\.allowed && gate\.environment === "remote" && store/);

    // The refusing arm hands back nothing, spelled exactly one way.
    expect(server).toContain("() => undefined");
    expect(server).toMatch(/case "refused":[\s\S]{0,400}?\(\) => undefined/);

    // And a remote decision is downgraded to a refusal when the platform
    // cannot actually be reached, rather than carried forward incomplete.
    expect(server).toMatch(/denyRemoteExecution\("no-durable-store"\)/);
    expect(server).toMatch(/denyRemoteExecution\("no-sandbox-credentials"\)/);
  });

  it("never pairs an executable gate with an empty resolver, on any environment", async () => {
    // The behavioural half of the guard above. Asserted through the real
    // shipped wiring rather than by reading it: every environment that
    // reports `executable` must reach a provider, and every one that does not
    // must refuse with `runtime_unavailable`.
    const { disposeRuntimeHost, getRuntimeHost } = await import("./server");

    try {
      const host = await getRuntimeHost(LOCAL_ACTOR);
      const status = await host.execute(LOCAL_ACTOR, { name: "get_status" });
      expect(status.ok).toBe(true);
      if (!status.ok) return;

      const created = await host.execute(LOCAL_ACTOR, {
        name: "create_session",
        provider: "claude-code",
      });

      if (status.value.executable) {
        expect(created.ok || created.error.code !== "runtime_unavailable").toBe(true);
      } else {
        expect(created).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
      }
    } finally {
      await disposeRuntimeHost();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. Credentials
 * ------------------------------------------------------------------ */

describe("the runtime holds and returns no credential", () => {
  it("declares no credential field anywhere in the module", () => {
    const offenders: string[] = [];
    for (const { file, source } of runtimeSources) {
      const code = codeOf(source);
      for (const pattern of [
        /\b(apiKey|api_key|accessToken|refreshToken|oauthToken|bearer|clientSecret|password)\b\s*[?:]/i,
        /\bcredentials\s*:\s*\{/,
      ]) {
        if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("returns no environment value in a status reply", async () => {
    const adapter = createScriptedAdapter({ now: () => T0 });
    const host = createRuntimeHost({
      gate: ALLOWED,
      resolveAdapter: () => adapter,
      providers: ["claude-code"],
      now: () => T0,
      runtimeId: "runtime-1",
    });

    const status = await host.execute(LOCAL_ACTOR, { name: "get_status" });
    const serialized = JSON.stringify(status);

    for (const secret of [
      "ANTHROPIC_API_KEY",
      "sk-ant-",
      "TABDUMP_LOCAL_AGENT_RUNTIME",
      "C:/Users",
      "/home/",
      ".claude",
      "node_modules",
      "3000",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("returns no project path in a session view", async () => {
    const adapter = createScriptedAdapter({ now: () => T0 });
    const host = createRuntimeHost({
      gate: ALLOWED,
      resolveAdapter: () => adapter,
      providers: ["claude-code"],
      now: () => T0,
      runtimeId: "runtime-1",
    });

    await host.execute(LOCAL_ACTOR, {
      name: "authorize_projects",
      projects: [
        {
          id: "p1",
          name: "Research",
          path: "C:/work/research",
          providers: ["claude-code"],
          permissions: { scopes: ["read_project"], projectId: "p1", grantedAt: T0 },
        },
      ],
    });

    const started = await host.execute(LOCAL_ACTOR, {
      name: "create_session",
      provider: "claude-code",
      projectId: "p1",
    });

    // The session names its project by id. The directory it resolves to stays
    // on the server's side of the boundary.
    expect(JSON.stringify(started)).not.toContain("C:/work/research");
    expect(started.ok && started.value.projectId).toBe("p1");
  });
});

/* ------------------------------------------------------------------ *
 * 5. Observation stays independent
 * ------------------------------------------------------------------ */

describe("observation does not depend on control", () => {
  it("no observation module imports the runtime", () => {
    // Control is an additional source of knowledge, not a prerequisite. The
    // observation pipeline has to keep working with the control plane
    // switched off entirely — which is a hosted deployment's permanent state.
    const observationDirs = [
      path.join(SRC_DIR, "lib/agents/claude-code"),
      path.join(SRC_DIR, "lib/agents/connectors"),
    ];

    const offenders: string[] = [];
    for (const dir of observationDirs) {
      for (const file of walk(dir)) {
        const source = readFileSync(file, "utf8");
        for (const pattern of [/agents\/runtime\//, /agents\/control\/service/, /correlation/i]) {
          if (pattern.test(source)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("no domain ingestion module imports the runtime", () => {
    for (const name of ["adapter.ts", "runs.ts", "events.ts", "persistence.ts"]) {
      const source = readFileSync(path.join(SRC_DIR, "lib/agents", name), "utf8");
      expect(source).not.toContain("agents/runtime");
    }
  });

  it("does not require a control run to describe observed activity", () => {
    // Asserted through the registry's own behaviour rather than only by
    // imports: an externally started session is a complete record.
    const host = createRuntimeHost({
      gate: ALLOWED,
      resolveAdapter: () => undefined,
      now: () => T0,
      runtimeId: "r",
    });

    const observed = host.correlations.register(
      {
        provider: "claude-code",
        origin: "observation",
        providerSessionId: "prov-external",
        observationRunId: "run-1",
      },
      T0
    );

    expect(observed.controlRunId).toBeUndefined();
    expect(observed.observationRunId).toBe("run-1");
  });
});

/* ------------------------------------------------------------------ *
 * 6. The approval broker stays authoritative
 * ------------------------------------------------------------------ */

describe("approvals cannot be granted around the broker", () => {
  it("gives the runtime no way to mint an approval", () => {
    const offenders: string[] = [];
    for (const { file, source } of runtimeSources) {
      const code = codeOf(source);
      for (const pattern of [/createApprovalBroker/, /\.request\(/, /grantApproval/, /autoApprove/]) {
        if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
      }
    }

    // The runtime routes a decision; the control service mints the record and
    // the broker owns it.
    expect(offenders).toEqual([]);
  });

  it("refuses an approval that reaches no session the caller owns", async () => {
    const adapter = createScriptedAdapter({ now: () => T0 });
    const host = createRuntimeHost({
      gate: ALLOWED,
      resolveAdapter: () => adapter,
      now: () => T0,
      runtimeId: "r",
    });

    const answered = await host.execute(
      { id: "account:stranger" },
      { name: "respond_to_approval", approvalId: "anything", decision: "granted" }
    );

    expect(answered.ok).toBe(false);
    expect(adapter.answered("anything")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 7. The desktop build
 * ------------------------------------------------------------------ */

describe("the desktop build", () => {
  it("keeps the transport out of the static export", () => {
    // `pageExtensions: ["tsx"]` is what drops every route handler from the
    // desktop route tree. The control endpoint is a `route.ts`, so it is not
    // in the packaged app — which is why the client reports a disconnect
    // there rather than the app appearing to work.
    const config = readFileSync(path.join(REPO_ROOT, "next.config.ts"), "utf8");
    expect(config).toContain('pageExtensions: ["tsx"]');

    const route = path.join(SRC_DIR, "app/api/agents/control/route.ts");
    expect(readFileSync(route, "utf8").startsWith('import "server-only";')).toBe(true);
  });

  it("grants the desktop shell no new capability", () => {
    // Phase F adds no Tauri command and widens no permission. The manifest is
    // still Tauri's core baseline and nothing else.
    const capabilities = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "src-tauri/capabilities/default.json"), "utf8")
    ) as { permissions: string[] };

    expect(capabilities.permissions).toEqual(["core:default"]);
    for (const permission of capabilities.permissions) {
      expect(permission).not.toMatch(/^(shell|fs|process|opener|http):/);
    }
  });
});
