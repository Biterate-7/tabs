// `npm run desktop:dev`'s frontend: the Next dev server serving the DESKTOP
// page set (src/app/page.desktop.tsx — the app), not the website's launch
// page. next.config.ts picks the page set from TABDUMP_BUILD_TARGET; this
// sets it in Node so the same command works under cmd.exe on Windows.
//
// API routes are not part of the desktop page set (they never are in the
// packaged app either), so account calls go where the packaged app sends
// them: Rust's account origin (production, or HUBBLE_ACCOUNT_ORIGIN in a
// debug build). Run `npm run dev` separately on another port for a local
// website/API.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const child = spawn("npm", ["run", "dev"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, TABDUMP_BUILD_TARGET: "desktop" },
  shell: process.platform === "win32",
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error("[desktop:dev] failed to start the dev server:", error.message);
  process.exit(1);
});
