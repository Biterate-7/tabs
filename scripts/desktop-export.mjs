// Produces the static frontend bundle that Tauri packages (`out/`).
//
// This exists instead of an inline `TABDUMP_BUILD_TARGET=desktop next build`
// in package.json for two reasons:
//
//   1. npm runs scripts through cmd.exe on Windows, where `VAR=value cmd`
//      is not valid syntax — and this repo's primary desktop target IS
//      Windows. Setting the variable in Node keeps one script working on
//      every platform without adding a cross-env dependency.
//   2. It delegates to `npm run build` rather than calling `next build`
//      directly, so the existing `prebuild` step (which packages
//      extension/ into public/hubble-extension.zip) still runs. Skipping
//      it would ship a desktop bundle whose extension-download link 404s.
//
//   3. It builds with webpack, not Turbopack. Google Fonts sometimes serves
//      a family's files as `fonts.gstatic.com/l/font?kit=…&skey=…`, and
//      Turbopack's next/font can't turn an address with its own query into
//      an import ("next/font/google queries have exactly one entry") — it
//      failed the macOS installer build on 2026-11-22 for Merriweather
//      (src/app/layout.tsx) while the same commit built on Windows and Linux.
//      webpack's next/font downloads any address, so the export no longer
//      depends on which form Google happens to answer with. The website's
//      own build (Vercel) is unchanged.
//
// next.config.ts reads TABDUMP_BUILD_TARGET and switches to
// `output: "export"` — see the comment there for why that is sound for this
// particular app.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Where `output: "export"` writes, and where src-tauri/tauri.conf.json's
// `frontendDist` expects to find it. Checked after the build rather than
// assumed: setting `distDir` silently relocates the whole export (Next 16
// puts it *in* distDir), which would otherwise surface much later as Tauri
// failing on a missing directory — or, worse, packaging a stale one.
const OUT_DIR = path.join(ROOT, "out");
const ENTRY = path.join(OUT_DIR, "index.html");

const MISPLACED_EXPORT = [
  `[desktop:export] build succeeded but ${ENTRY} is missing.`,
  "The static export did not land where src-tauri/tauri.conf.json's",
  'frontendDist ("../out") expects it. Check that next.config.ts\'s desktop',
  'branch sets output: "export" and does NOT override distDir.',
].join("\n");

const child = spawn("npm", ["run", "build", "--", "--webpack"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, TABDUMP_BUILD_TARGET: "desktop" },
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);

  if (!fs.existsSync(ENTRY)) {
    console.error(MISPLACED_EXPORT);
    process.exit(1);
  }

  console.log(`[desktop:export] static frontend ready at ${OUT_DIR}`);
});

child.on("error", (error) => {
  console.error("[desktop:export] failed to start the web build:", error.message);
  process.exit(1);
});
