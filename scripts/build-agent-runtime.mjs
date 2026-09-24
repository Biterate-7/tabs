// Builds the desktop app's agent runtime sidecar (Phase J.1).
//
// Produces two files the Tauri bundle ships, both gitignored:
//
//   src-tauri/agent-runtime/runtime.mjs
//     src/desktop-runtime/main.ts and everything it imports — the Phase J
//     RuntimeHost, control plane, ACP adapter, launch allowlist and the
//     Claude Agent SDK — as ONE ES module with no node_modules beside it.
//
//   src-tauri/binaries/tabdump-agent-node-<target-triple>[.exe]
//     The Node binary that runs it. Tauri's `externalBin` convention needs the
//     target triple in the name; the bundle installs it beside TabDump.exe
//     without the suffix. Copied from the Node running this script, so the
//     runtime is built and shipped against the same Node version.
//
// Run by `tauri build` before the frontend export (see tauri.conf.json).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "src-tauri", "agent-runtime");
const BIN_DIR = path.join(ROOT, "src-tauri", "binaries");

function targetTriple() {
  const info = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = /^host:\s*(\S+)/m.exec(info);
  if (!host) throw new Error("[desktop:runtime] could not read the Rust host triple from `rustc -vV`");
  return host[1];
}

await build({
  input: path.join(ROOT, "src", "desktop-runtime", "main.ts"),
  platform: "node",
  resolve: {
    alias: {
      "@": path.join(ROOT, "src"),
      // Next swaps `server-only` for a no-op on the server; outside Next it
      // throws by design. The sidecar is server-side code, so it gets the same
      // no-op the test suite uses.
      "server-only": path.join(ROOT, "src", "lib", "titles", "server", "server-only-stub.ts"),
    },
  },
  output: {
    file: path.join(OUT_DIR, "runtime.mjs"),
    format: "esm",
    // One file: the shell starts exactly this, and nothing is resolved at
    // runtime from a directory an attacker could plant a module in.
    codeSplitting: false,
    banner:
      "import { createRequire as __tabdumpCreateRequire } from 'node:module'; const require = __tabdumpCreateRequire(import.meta.url);",
  },
});

const triple = targetTriple();
const extension = process.platform === "win32" ? ".exe" : "";
fs.mkdirSync(BIN_DIR, { recursive: true });
const nodeTarget = path.join(BIN_DIR, `tabdump-agent-node-${triple}${extension}`);
fs.copyFileSync(process.execPath, nodeTarget);

const size = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`[desktop:runtime] ${path.relative(ROOT, path.join(OUT_DIR, "runtime.mjs"))} (${size(path.join(OUT_DIR, "runtime.mjs"))})`);
console.log(`[desktop:runtime] ${path.relative(ROOT, nodeTarget)} (${size(nodeTarget)}, Node ${process.version})`);
