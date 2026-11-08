// Bundles the on-device embedding worker (src/lib/conversations/intelligence/
// embedding.worker.ts, with transformers.js) into public/workers, so the web
// app and the desktop export load it by a plain URL. Turbopack copies a
// `new Worker(new URL(...))` target as a raw asset without compiling it,
// which works for a prebuilt worker (pdf.js) but not for a TypeScript one
// that imports the app's own modules — so this worker is built here, with
// the rolldown that ships with the test toolchain (vitest → vite).
//
// Runs before `dev` and `build` (package.json predev/prebuild). The output is
// generated and git-ignored.
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "public", "workers");
const OUTPUT = path.join(TARGET, "embedding.worker.js");

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
await build({
  input: path.join(ROOT, "src", "lib", "conversations", "intelligence", "embedding.worker.ts"),
  platform: "browser",
  resolve: { alias: { "@": path.join(ROOT, "src") }, conditionNames: ["browser", "import", "default"] },
  transform: { define: { "process.env.NODE_ENV": JSON.stringify("production") } },
  logLevel: "warn",
  output: { file: OUTPUT, format: "esm", minify: true, codeSplitting: false },
});
console.log(`[embedding-worker] built public/workers/embedding.worker.js (${Math.round(statSync(OUTPUT).size / 1024)} KB)`);
