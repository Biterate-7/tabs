// @vitest-environment node
/**
 * The desktop build carries no sync API.
 *
 * Desktop is intentionally local-only (docs/desktop-architecture.md): the
 * bundle is a static export loaded from `tauri://localhost`, with no server
 * behind it and no session cookie that could authenticate one. The exclusion
 * is structural rather than a runtime check — `pageExtensions: ["tsx"]` in
 * next.config.ts means only `.tsx` pages and layouts enter the desktop build
 * tree, and every route handler is a `route.ts`.
 *
 * That is a quiet mechanism: nothing fails loudly if a future sync route is
 * ever added as `route.tsx`, or if `pageExtensions` is widened. It would
 * simply start shipping server code into a bundle that has no server. So the
 * invariant is asserted here instead.
 *
 * This is STRUCTURAL verification, not a built-artifact check: it reads the
 * config and the route filenames rather than inspecting `out/`. Building the
 * desktop bundle needs the Rust/Cargo toolchain, which this machine's
 * Application Control blocks.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const API_DIR = path.join(REPO_ROOT, "src", "app", "api");

/** Every route handler file under src/app/api, repo-relative. */
function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...routeFiles(full));
    } else if (/^route\.[jt]sx?$/.test(entry)) {
      found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
    }
  }
  return found;
}

it("keeps every sync route handler out of the desktop page tree", () => {
  const routes = routeFiles(API_DIR);
  const syncRoutes = routes.filter((file) => file.startsWith("src/app/api/sync/"));

  // The routes exist for the web build...
  expect(syncRoutes.length).toBeGreaterThan(0);
  // ...and every one of them is a `.ts`, which pageExtensions excludes.
  for (const route of syncRoutes) {
    expect(route, `${route} would be included in the desktop export`).toMatch(/\.ts$/);
  }
});

it("keeps the desktop build's pageExtensions to tsx only", () => {
  const config = readFileSync(path.join(REPO_ROOT, "next.config.ts"), "utf8");
  // Widening this — or dropping it — would pull every route.ts into the
  // static export, which cannot represent a route handler at all.
  expect(config).toMatch(/pageExtensions:\s*\["tsx"\]/);
  expect(config).toMatch(/output:\s*"export"/);
});

it("has no sync route that reaches for a database outside the web build", () => {
  // A desktop bundle has no POSTGRES_URL and no session. Nothing under
  // src/lib/sync that the CLIENT imports may pull in the server store; the
  // server-only modules are the boundary, and they are marked as such.
  for (const file of ["store.ts", "service.ts", "repository.ts", "http.ts"]) {
    const source = readFileSync(path.join(REPO_ROOT, "src", "lib", "sync", file), "utf8");
    expect(source.startsWith('import "server-only";'), `${file} is missing its server-only marker`).toBe(true);
  }
});
