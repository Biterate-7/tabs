/**
 * migrate:integrations must never pick its database by accident.
 *
 * A `vercel env pull` writes the Development database into .env.local, so a
 * script that read it would migrate whatever that file names. These tests run
 * the real script as a child process, the way an operator does, and check that
 * the target has to be supplied in the environment and confirmed with
 * --expect-host before anything connects — and that no output ever carries a
 * credential. None of them needs a database.
 */
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "..", "..", "..", "scripts", "migrate-integrations.mjs");
const SECRET = "s3cret-Pa55word";

/** The developer's own database variables never reach the child. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "POSTGRES_URL" && key !== "DATABASE_URL") env[key] = value;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

async function migrate(script: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { env, timeout: 20_000 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: (failure.stdout ?? "") + (failure.stderr ?? "") };
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrate:integrations target safety", () => {
  it("ignores .env.local and .env beside it, so a pulled Development database is never the target", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hubble-migrate-"));
    temps.push(root);
    mkdirSync(path.join(root, "scripts"));
    const script = path.join(root, "scripts", "migrate-integrations.mjs");
    copyFileSync(SCRIPT, script);
    writeFileSync(path.join(root, ".env.local"), `POSTGRES_URL=postgresql://dev:${SECRET}@127.0.0.1:1/devdb\n`);
    writeFileSync(path.join(root, ".env"), `DATABASE_URL=postgresql://dev:${SECRET}@127.0.0.1:1/devdb\n`);

    const result = await migrate(script, ["--expect-host=127.0.0.1"], cleanEnv());
    expect(result.code).toBe(1);
    expect(result.out).toContain("No database configured");
    expect(result.out).not.toContain("Target");
    expect(result.out).not.toContain(SECRET);
  });

  it("refuses to run without --expect-host, naming the host but no credential", async () => {
    const result = await migrate(SCRIPT, [], cleanEnv({ POSTGRES_URL: `postgresql://owner:${SECRET}@ep-prod-main-pooler.example.invalid/neondb` }));
    expect(result.code).toBe(1);
    expect(result.out).toContain("host ep-prod-main-pooler.example.invalid, database neondb");
    expect(result.out).toContain("Refusing to run without --expect-host");
    expect(result.out).not.toContain(SECRET);
    expect(result.out).not.toContain("owner");
  });

  it("refuses a host that is not the one expected, before connecting", async () => {
    const result = await migrate(
      SCRIPT,
      ["--expect-host=ep-prod-main"],
      cleanEnv({ POSTGRES_URL: `postgresql://owner:${SECRET}@ep-dev-branch-pooler.example.invalid/neondb` })
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain("Refusing to run: --expect-host is ep-prod-main");
    expect(result.out).toContain("Nothing was changed");
    expect(result.out).not.toContain("Migration failed");
    expect(result.out).not.toContain(SECRET);
  });

  it("checks the host the driver will dial, so a host= parameter cannot redirect a matching URL", async () => {
    const result = await migrate(
      SCRIPT,
      ["--expect-host=ep-prod-main"],
      cleanEnv({ POSTGRES_URL: `postgresql://owner:${SECRET}@ep-prod-main-pooler.example.invalid/neondb?host=ep-dev-branch.example.invalid` })
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain("the driver would not connect to the host in POSTGRES_URL");
    expect(result.out).toContain("Nothing was changed");
    expect(result.out).not.toContain("Migration failed");
    expect(result.out).not.toContain(SECRET);
  });

  it("accepts the endpoint label with or without -pooler, then connects — and redacts the driver's error", async () => {
    for (const expected of ["ep-prod-main", "ep-prod-main-pooler", "--expect-host"]) {
      const args = expected === "--expect-host" ? ["--expect-host", "ep-prod-main-pooler.example.invalid"] : [`--expect-host=${expected}`];
      const result = await migrate(SCRIPT, args, cleanEnv({ DATABASE_URL: `postgresql://owner:${SECRET}@ep-prod-main-pooler.example.invalid/neondb` }));
      // Past the guard: the only failure left is that .invalid never resolves.
      expect(result.code, expected).toBe(1);
      expect(result.out, expected).toContain("Target (via DATABASE_URL)");
      expect(result.out, expected).toContain("Migration failed:");
      expect(result.out, expected).not.toContain("Refusing");
      expect(result.out, expected).not.toContain(SECRET);
    }
  });
});
