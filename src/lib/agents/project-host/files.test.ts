import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createProjectFileSystem } = await import("./files");
const { createProjectCheckRunner } = await import("./checks");

/**
 * The project seam on a real disk (Hubble 1.6): every escape the brief names
 * — `../`, absolute paths, links out of the project — and the secret-file and
 * exact-restore rules, against real files rather than a model of them.
 */

let base: string;
let root: string;
let outside: string;
const fs = createProjectFileSystem();
const slash = (value: string) => value.replace(/\\/g, "/");

beforeAll(() => {
  base = mkdtempSync(nodePath.join(tmpdir(), "hubble-project-"));
  root = nodePath.join(base, "hubble");
  outside = nodePath.join(base, "outside");
  mkdirSync(nodePath.join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(nodePath.join(root, "src", "auth.ts"), "export const a = 1\n");
  writeFileSync(nodePath.join(root, ".env"), "SECRET=hunter2\n");
  writeFileSync(nodePath.join(outside, "victim.txt"), "do not touch\n");
  writeFileSync(
    nodePath.join(root, "package.json"),
    JSON.stringify({ dependencies: { next: "16" }, scripts: { test: "node -e \"process.exit(0)\"", lint: "node -e \"process.exit(3)\"" } })
  );
  mkdirSync(nodePath.join(root, ".git", "refs", "heads", "feature"), { recursive: true });
  writeFileSync(nodePath.join(root, ".git", "HEAD"), "ref: refs/heads/feature/auth\n");
  writeFileSync(nodePath.join(root, ".git", "refs", "heads", "feature", "auth"), "0123456789abcdef0123456789abcdef01234567\n");
});

// A stopped check's process tree takes a moment to release its working folder on Windows.
afterAll(() => {
  // The link first, so removing the tree never follows it out of the project.
  rmSync(nodePath.join(root, "linked"), { force: true, recursive: false });
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe("containment", () => {
  it.each(["../outside/victim.txt", "../../etc/passwd", "src/../../outside/victim.txt", "/etc/passwd", "C:/Windows/win.ini", "src\\..\\..\\x", ""])(
    "refuses %j without reading it",
    async (path) => {
      const snapshot = await fs.snapshot(slash(root), path);
      expect(["unsafe", "unreadable"]).toContain(snapshot.kind);
    }
  );

  it("refuses a directory link that leads out of the project", async () => {
    const link = nodePath.join(root, "linked");
    try {
      // A junction needs no privilege on Windows; elsewhere a plain directory link.
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // Links unavailable here; the file-link case below still runs where it can.
    }
    expect((await fs.snapshot(slash(root), "linked/victim.txt")).kind).toBe("unsafe");
    expect(await fs.restore(slash(root), "linked/victim.txt", { kind: "absent" }, { kind: "absent" })).toBe("unsafe");
    expect(readFileSync(nodePath.join(outside, "victim.txt"), "utf8")).toBe("do not touch\n");
  });

  it("refuses a file link, even to a file inside the project", async () => {
    const link = nodePath.join(root, "src", "alias.ts");
    try {
      symlinkSync(nodePath.join(outside, "victim.txt"), link, "file");
    } catch {
      return; // Creating file links needs a privilege this machine may not grant.
    }
    expect((await fs.snapshot(slash(root), "src/alias.ts")).kind).toBe("unsafe");
  });

  it("never reads a secret-like file", async () => {
    expect(await fs.snapshot(slash(root), ".env")).toEqual({ kind: "sensitive" });
    const inspected = await fs.inspect(slash(root), [".env", "src/auth.ts"]);
    expect(inspected.files[0]).toEqual({ path: ".env", state: "sensitive" });
    expect(JSON.stringify(inspected)).not.toContain("hunter2");
  });
});

describe("inspection", () => {
  it("reads the type, the branch and the checks", async () => {
    const inspected = await fs.inspect(slash(root), ["src/auth.ts", "src/missing.ts"]);
    expect(inspected).toMatchObject({
      state: "ready",
      type: "nextjs",
      repository: { kind: "git", branch: "feature/auth", head: "0123456789ab" },
      checks: [{ id: "lint" }, { id: "test" }, { id: "git_status" }],
      files: [{ path: "src/auth.ts", state: "present" }, { path: "src/missing.ts", state: "missing" }],
    });
  });

  it("says when a project is missing, or not a folder", async () => {
    expect(await fs.access(slash(nodePath.join(base, "gone")))).toBe("missing");
    expect(await fs.access(slash(nodePath.join(root, "package.json")))).toBe("not_a_directory");
    expect(await fs.access("C:/")).toBe("unavailable");
  });
});

describe("restore", () => {
  it("writes the copy back only over exactly what the agent left", async () => {
    const before = await fs.snapshot(slash(root), "src/auth.ts");
    writeFileSync(nodePath.join(root, "src", "auth.ts"), "agent wrote this\n");
    const after = await fs.snapshot(slash(root), "src/auth.ts");

    writeFileSync(nodePath.join(root, "src", "auth.ts"), "a person edited it\n");
    expect(await fs.restore(slash(root), "src/auth.ts", before, after)).toBe("changed");
    expect(readFileSync(nodePath.join(root, "src", "auth.ts"), "utf8")).toBe("a person edited it\n");

    writeFileSync(nodePath.join(root, "src", "auth.ts"), "agent wrote this\n");
    expect(await fs.restore(slash(root), "src/auth.ts", before, after)).toBe("restored");
    expect(readFileSync(nodePath.join(root, "src", "auth.ts"), "utf8")).toBe("export const a = 1\n");
  });

  it("removes a created file only if it is unchanged", async () => {
    writeFileSync(nodePath.join(root, "src", "new.ts"), "created\n");
    const after = await fs.snapshot(slash(root), "src/new.ts");
    expect(await fs.restore(slash(root), "src/new.ts", { kind: "absent" }, after)).toBe("restored");
    expect(existsSync(nodePath.join(root, "src", "new.ts"))).toBe(false);
  });
});

describe("checks on a real project", () => {
  const runner = createProjectCheckRunner({ env: process.env });

  it("runs the project's own script and reports its exit", async () => {
    expect(await runner.run(slash(root), "test")).toMatchObject({ outcome: "passed", exitCode: 0 });
    expect(await runner.run(slash(root), "lint")).toMatchObject({ outcome: "failed", exitCode: 3 });
  }, 60_000);

  it("is unavailable for a check the project does not define", async () => {
    expect(await runner.run(slash(root), "build")).toMatchObject({ outcome: "unavailable" });
  });

  it("stops a check that runs too long", async () => {
    writeFileSync(
      nodePath.join(root, "package.json"),
      JSON.stringify({ scripts: { build: "node -e \"setTimeout(() => {}, 60000)\"" } })
    );
    const result = await runner.run(slash(root), "build", { timeoutMs: 1500 });
    expect(result.outcome).toBe("timed_out");
  }, 30_000);
});
