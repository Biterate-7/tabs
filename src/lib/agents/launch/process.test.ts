import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createGrant } from "@/lib/agents/control/permissions";
import { createProject } from "@/lib/agents/control/projects";
import { createAcpProcessLauncher } from "./process";
import type { AgentControlEvent } from "@/lib/agents/control/events";

/**
 * The launcher against a real process.
 *
 * A scripted ACP agent (./__fixtures__/fake-acp-agent.mjs) is installed into a
 * temporary directory exactly as `npm install -g @google/gemini-cli` would
 * install Gemini — a `gemini.cmd` shim beside `node_modules/@google/gemini-cli`
 * on Windows, an executable on POSIX — and that directory is the whole PATH.
 * Then the real launcher, the real stdio transport and the real adapter drive
 * it. What the agent reports about how it was started is what is asserted.
 */

const FIXTURE = path.resolve(__dirname, "__fixtures__/fake-acp-agent.mjs");
const SECRET = "sk-should-never-reach-the-agent";

let root: string;
let bin: string;
let projectDir: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "tabdump-launch-test-")));
  bin = path.join(root, "bin");
  projectDir = path.join(root, "work", "research");
  mkdirSync(bin, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const pkg = path.join(bin, "node_modules", "@google", "gemini-cli");
  mkdirSync(path.join(pkg, "dist"), { recursive: true });
  copyFileSync(FIXTURE, path.join(pkg, "dist", "index.mjs"));
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@google/gemini-cli", bin: { gemini: "dist/index.mjs" } }));

  if (process.platform === "win32") {
    // Its contents are never executed: TabDump follows it to the package.
    writeFileSync(path.join(bin, "gemini.cmd"), "@echo off\r\nexit 1\r\n");
  } else {
    const launcher = path.join(bin, "gemini");
    writeFileSync(launcher, `#!${process.execPath}\nimport(${JSON.stringify(path.join(pkg, "dist", "index.mjs"))})\n`);
    chmodSync(launcher, 0o755);
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function environment(): Record<string, string | undefined> {
  return {
    PATH: bin,
    PATHEXT: ".EXE;.CMD",
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    ANTHROPIC_API_KEY: SECRET,
    GEMINI_API_KEY: SECRET,
    POSTGRES_URL: `postgres://tabdump:${SECRET}@db/tabdump`,
  };
}

async function until(predicate: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function project() {
  const grant = createGrant(["read_project", "write_project"], 1, "p1");
  const made = createProject(
    { id: "p1", name: "Research", path: projectDir, providers: ["gemini"], permissions: grant! },
    1
  );
  if (!made.ok) throw new Error(`project fixture failed: ${made.reason}`);
  return made.project;
}

describe("launching a real ACP agent", () => {
  it("starts the allowlisted agent in the project, with its fixed arguments and none of the server's secrets", async () => {
    const adapter = createAcpControlAdapter({
      provider: "gemini",
      launch: createAcpProcessLauncher({ provider: "gemini", env: environment() }),
    });
    const events: AgentControlEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));

    const p = project();
    const created = await adapter.createSession({ sessionId: "s1", project: p, permissions: p.permissions, attachments: [] });
    expect(created.ok).toBe(true);

    await adapter.sendMessage({ sessionId: "s1", text: "report", context: { attachments: [] } });
    await until(() => events.some((event) => event.kind === "run_completed"));

    const reply = events.find((event) => event.kind === "message_received")!;
    const facts = JSON.parse(reply.text!) as { argv: string[]; cwd: string; sessionCwd: string; envKeys: string[] };

    expect(facts.argv).toEqual(["--acp"]);
    expect(path.resolve(facts.cwd).toLowerCase()).toBe(path.resolve(projectDir).toLowerCase());
    expect(path.resolve(facts.sessionCwd).toLowerCase()).toBe(path.resolve(projectDir).toLowerCase());
    expect(facts.envKeys).not.toContain("ANTHROPIC_API_KEY");
    expect(facts.envKeys).not.toContain("GEMINI_API_KEY");
    expect(facts.envKeys).not.toContain("POSTGRES_URL");
    expect(JSON.stringify(events)).not.toContain(SECRET);

    adapter.dispose();
  }, 30_000);

  it("carries a real approval round trip over stdio", async () => {
    const adapter = createAcpControlAdapter({
      provider: "gemini",
      launch: createAcpProcessLauncher({ provider: "gemini", env: environment() }),
    });
    const events: AgentControlEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));

    const p = project();
    await adapter.createSession({ sessionId: "s2", project: p, permissions: p.permissions, attachments: [] });
    await adapter.sendMessage({ sessionId: "s2", text: "edit", context: { attachments: [] } });

    await until(() => events.some((event) => event.kind === "approval_requested"));
    const requested = events.find((event) => event.kind === "approval_requested")!;
    expect(adapter.takeApprovalDetails(requested.approvalId!)).toMatchObject({
      action: "modify_files",
      targets: ["notes.md"],
    });

    await adapter.respondToApproval(requested.approvalId!, "denied");
    await until(() => events.some((event) => event.kind === "run_completed"));

    expect(events.find((event) => event.kind === "message_received")?.text).toBe("permission:no");
    adapter.dispose();
  }, 30_000);

  it("reports an agent that is not on PATH as not installed", async () => {
    const launch = createAcpProcessLauncher({ provider: "grok", env: environment() });
    expect(await launch({})).toEqual({ ok: false, reason: "not-installed" });
  });

  it("refuses a working directory the project validator refuses", async () => {
    const launch = createAcpProcessLauncher({ provider: "gemini", env: environment() });
    expect(await launch({ projectPath: path.parse(root).root })).toEqual({ ok: false, reason: "failed" });
  });

  it("gives a session with no project an empty private directory and removes it", async () => {
    const launch = createAcpProcessLauncher({ provider: "gemini", env: environment() });
    const launched = await launch({});
    if (!launched.ok) throw new Error("launch failed");

    expect(launched.cwd).toContain("tabdump-agent-");
    launched.transport.close();
    launched.release();

    // Removed once the agent has actually exited — Windows will not delete a
    // directory a live process is standing in.
    const { existsSync } = await import("node:fs");
    await until(() => !existsSync(launched.cwd));
    expect(existsSync(launched.cwd)).toBe(false);
  });
});
