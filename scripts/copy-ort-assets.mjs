// Copies the ONNX Runtime WebAssembly build that on-device semantic matching
// needs (src/lib/conversations/intelligence/embedding.worker.ts) into
// public/ort, so Hubble serves it itself. transformers.js would otherwise
// load it from a third-party CDN; this way no code from another origin runs
// in the app. Only the plain SIMD build is shipped — Hubble runs the model on
// the WASM backend, never WebGPU.
//
// Runs before `dev` and `build` (package.json predev/prebuild), so the copy
// can never drift from the installed onnxruntime-web. public/ort is generated
// and git-ignored.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "public", "ort");
// The copy transformers.js resolves: its own nested one when npm nested it, else the hoisted one.
const source = [path.join(ROOT, "node_modules", "@huggingface", "transformers", "node_modules", "onnxruntime-web", "dist"), path.join(ROOT, "node_modules", "onnxruntime-web", "dist")].find((dir) => existsSync(dir));
if (!source) {
  console.error("[ort-assets] onnxruntime-web is not installed. Run `npm install` first.");
  process.exit(1);
}

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
for (const file of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) copyFileSync(path.join(source, file), path.join(TARGET, file));
console.log("[ort-assets] copied the ONNX Runtime WASM build to public/ort");
