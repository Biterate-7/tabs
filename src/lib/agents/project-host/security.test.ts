import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The guard suite for Hubble's own project access (Hubble 1.6), by reading
 * the source: who can reach it, what it can start, and how.
 */

const HERE = path.resolve(__dirname);
const SRC = path.resolve(__dirname, "../../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const codeOf = (source: string) =>
  source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

const sources = walk(HERE).map((file) => ({ name: path.basename(file), code: codeOf(readFileSync(file, "utf8")), raw: readFileSync(file, "utf8") }));

describe("Hubble's project access", () => {
  it("is server-only, every module of it", () => {
    for (const source of sources) expect(source.raw.startsWith('import "server-only";'), source.name).toBe(true);
  });

  it("is reached only by the local and desktop runtime wiring", () => {
    const importers: string[] = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(HERE)) continue;
      if (/from\s+["'][^"']*agents\/project-host/.test(codeOf(readFileSync(file, "utf8")))) importers.push(path.relative(SRC, file).replace(/\\/g, "/"));
    }
    expect(importers.sort()).toEqual(["lib/agents/runtime/desktop.ts", "lib/agents/runtime/server.ts"]);
  });

  it("starts processes in one module, never through a shell, with literal programs", () => {
    const spawning = sources.filter((source) => /\bspawn\s*\(/.test(source.code));
    expect(spawning.map((source) => source.name)).toEqual(["checks.ts"]);
    const code = spawning[0]!.code;
    expect(code).not.toMatch(/shell:\s*true/);
    expect(code.match(/shell: false/g)?.length).toBe((code.match(/\bspawn\s*\(/g) ?? []).length - 1 + 1);
    for (const forbidden of ["exec(", "execSync", "execFile", "spawnSync", "eval(", "new Function("]) expect(code).not.toContain(forbidden);
    for (const call of code.match(/\bspawn\s*\([^,]*,/g) ?? []) expect(call).toMatch(/^spawn\(\/\*turbopackIgnore: true\*\/ [\w.]+,$/);
  });

  it("runs only npm's CLI with `run <script>` and Git with read-only status arguments", () => {
    const code = sources.find((source) => source.name === "checks.ts")!.code;
    expect(code).toContain('args: [npm.script, "run", script.name]');
    expect(code).toContain('"--no-optional-locks", "status", "--porcelain=v1"');
    expect(code).toContain('"core.fsmonitor=false"');
    // The script name is re-read from the project, never taken from a request.
    expect(code).toContain("scriptForCheck(readManifest(root), check)");
  });

  it("gives a check the agents' stripped environment, never Hubble's own", () => {
    const code = sources.find((source) => source.name === "checks.ts")!.code;
    expect(code).toContain("agentEnvironment(options.env)");
    expect(code).not.toContain("process.env");
  });

  it("never lists or walks a directory", () => {
    for (const source of sources) {
      expect(source.code).not.toMatch(/\breaddir\b|\bopendir\b|\bglob\b/);
    }
  });
});
