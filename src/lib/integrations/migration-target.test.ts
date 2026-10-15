/**
 * No database script may pick its database by accident.
 *
 * A `vercel env pull` writes a real database into .env.local — for this
 * project it has been the production one — so a script that read it would
 * migrate whatever that file names. These tests run the real scripts as child
 * processes, the way an operator does, and check that the target has to be
 * supplied in the environment and confirmed with --expect-host before anything
 * connects — and that no output ever carries a credential. None of them needs
 * a database.
 */
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPTS_DIR = path.resolve(__dirname, "..", "..", "..", "scripts");
const SCRIPT = path.join(SCRIPTS_DIR, "migrate-integrations.mjs");
/** Every script that opens a database connection. */
const DATABASE_SCRIPTS = ["migrate-auth", "migrate-sync", "migrate-mcp", "migrate-downloads", "migrate-integrations", "report-downloads"];
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
    copyFileSync(path.join(SCRIPTS_DIR, "db-target.mjs"), path.join(root, "scripts", "db-target.mjs"));
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

describe.each(DATABASE_SCRIPTS)("%s target safety", (name) => {
  const original = path.join(SCRIPTS_DIR, `${name}.mjs`);

  it("reads no .env.local or .env, so a pulled database is never the target", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hubble-dbscript-"));
    temps.push(root);
    mkdirSync(path.join(root, "scripts"));
    const script = path.join(root, "scripts", `${name}.mjs`);
    copyFileSync(original, script);
    copyFileSync(path.join(SCRIPTS_DIR, "db-target.mjs"), path.join(root, "scripts", "db-target.mjs"));
    writeFileSync(path.join(root, ".env.local"), `POSTGRES_URL=postgresql://dev:${SECRET}@127.0.0.1:1/devdb
`);
    writeFileSync(path.join(root, ".env"), `DATABASE_URL=postgresql://dev:${SECRET}@127.0.0.1:1/devdb
`);

    const result = await migrate(script, ["--expect-host=127.0.0.1"], cleanEnv());
    expect(result.code).toBe(1);
    expect(result.out).toContain("No database configured");
    expect(result.out).toContain(`scripts/${name}.mjs`);
    expect(result.out).not.toContain(SECRET);
  });

  it("refuses to run without --expect-host, or with the wrong one, before connecting", async () => {
    const env = cleanEnv({ POSTGRES_URL: `postgresql://owner:${SECRET}@ep-prod-main-pooler.example.invalid/neondb` });
    const missing = await migrate(original, [], env);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("Refusing to run without --expect-host");

    const wrong = await migrate(original, ["--expect-host=ep-dev-branch"], env);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain("Refusing to run: --expect-host is ep-dev-branch");
    for (const out of [missing.out, wrong.out]) {
      expect(out).not.toMatch(/failed:/);
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("owner");
    }
  });

  it("opens no connection until --expect-host matches, then dials exactly that host", async () => {
    // A TCP listener standing in for a database: it counts connection attempts and hangs up.
    let attempts = 0;
    const server = createServer((socket) => {
      attempts++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const env = cleanEnv({ POSTGRES_URL: `postgresql://owner:${SECRET}@127.0.0.1:${port}/neondb` });
      for (const args of [[], ["--expect-host="], ["--expect-host"], ["--expect-host=ep-prod-main"], ["--expect-host=127.0.0.2"]]) {
        const refused = await migrate(original, args, env);
        expect(refused.code, args.join(" ")).toBe(1);
        expect(refused.out, args.join(" ")).toContain("Refusing to run");
        expect(attempts, args.join(" ")).toBe(0);
      }
      const matched = await migrate(original, ["--expect-host=127.0.0.1"], env);
      expect(matched.code).toBe(1);
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(matched.out).not.toContain(SECRET);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("names neither the user nor the password, even when the URL has no database", async () => {
    const result = await migrate(original, [], cleanEnv({ POSTGRES_URL: `postgresql://someowner:${SECRET}@ep-prod-main-pooler.example.invalid` }));
    expect(result.code).toBe(1);
    expect(result.out).toContain("host ep-prod-main-pooler.example.invalid, database (default)");
    expect(result.out).not.toContain("someowner");
    expect(result.out).not.toContain(SECRET);
  });

  it("refuses a value that is not a connection URL without echoing it", async () => {
    const malformed = await migrate(original, ["--expect-host=x"], cleanEnv({ DATABASE_URL: `postgresql://owner:${SECRET}@bad host.example/db` }));
    expect(malformed.code).toBe(1);
    expect(malformed.out).toContain("DATABASE_URL is not a valid connection URL");
    expect(malformed.out).not.toContain(SECRET);
    // Parses as a URL with no host, so the driver would dial a default: refused as a host mismatch.
    const hostless = await migrate(original, ["--expect-host=x"], cleanEnv({ DATABASE_URL: `owner:${SECRET} not a url` }));
    expect(hostless.code).toBe(1);
    expect(hostless.out).toContain("Refusing to run");
    expect(hostless.out).not.toContain(SECRET);
  });

  it("redacts the driver's error once past the guard", async () => {
    const result = await migrate(original, ["--expect-host=ep-prod-main"], cleanEnv({ POSTGRES_URL: `postgresql://owner:${SECRET}@ep-prod-main-pooler.example.invalid/neondb` }));
    // Past the guard: the only failure left is that .invalid never resolves.
    expect(result.code).toBe(1);
    expect(result.out).toContain("Target (via POSTGRES_URL)");
    expect(result.out).toMatch(/failed:/);
    expect(result.out).not.toContain(SECRET);
  });
});
