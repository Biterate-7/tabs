import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A structural guard, not a behavioural one.
 *
 * The web bundle must never contain a *static* `@tauri-apps` import. One
 * would not merely be dead weight in the browser: Tauri's modules expect
 * their injected runtime globals, so a static import can fail at module
 * evaluation time — breaking the deployed website on a machine that has
 * never heard of the desktop app.
 *
 * The rule this enforces: exactly one shipped module may mention
 * `@tauri-apps` at all, and it must reach it through `await import(...)` so
 * the bundler splits it into a chunk the web build never fetches.
 *
 * Test files are excluded because they are not shipped — index.test.ts
 * legitimately names the module in order to `vi.mock` it.
 */

const SRC = path.resolve(__dirname, "../..");
const DESKTOP_ADAPTER = path.join("lib", "platform", "desktop.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const shippedFiles = walk(SRC);

describe("Tauri never leaks into the web execution path", () => {
  it("finds source files to check (guards against the walker silently matching nothing)", () => {
    expect(shippedFiles.length).toBeGreaterThan(200);
  });

  it("mentions @tauri-apps in exactly one shipped module: the desktop adapter", () => {
    const mentioning = shippedFiles
      .filter((file) => readFileSync(file, "utf8").includes("@tauri-apps"))
      .map((file) => path.relative(SRC, file));

    expect(mentioning).toEqual([DESKTOP_ADAPTER]);
  });

  it("imports Tauri only dynamically, so the web bundle never evaluates it", () => {
    const source = readFileSync(path.join(SRC, DESKTOP_ADAPTER), "utf8");

    // No top-level `import ... from "@tauri-apps/..."`, and no bare
    // side-effect import of one either.
    expect(/^\s*import\s[^\n]*["']@tauri-apps\//m.test(source)).toBe(false);

    // Every Tauri module it does reach is reached through `import(...)`.
    const dynamic = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    const tauriDynamic = dynamic.filter((spec) => spec.startsWith("@tauri-apps/"));
    expect(tauriDynamic.length).toBeGreaterThan(0);

    // …and nothing reaches one any other way: every import *statement* in
    // the file is non-Tauri.
    const statements = [...source.matchAll(/^\s*import\s[^\n]*?["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(statements.filter((spec) => spec.startsWith("@tauri-apps/"))).toEqual([]);
  });

  it("keeps the shared entry point free of Tauri, so importing it costs the web nothing", () => {
    const index = readFileSync(path.join(SRC, "lib", "platform", "index.ts"), "utf8");
    expect(index).not.toContain("@tauri-apps");
  });
});
