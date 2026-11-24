// Puts the on-device embedding model (src/lib/conversations/intelligence/
// semantic.ts EMBEDDING_MODEL) in public/models, so Hubble loads it from
// itself: no request to a third party at run time (the worker turns remote
// model loading off), and the desktop app works offline from the first
// launch. Tauri bundles public/ via the static export.
//
// The files are pinned to one revision of the model repository and checked
// against their SHA-256 before use — a file that differs is refused, never
// served. They are downloaded once into node_modules/.cache/hubble-models and
// copied from there on every dev/build.
//
// The website build (the launch site) skips it entirely. Offline with no
// cache: a dev run warns and leaves the model out (Hubble then reports meaning comparison as unavailable, with why, and
// links by words). The desktop export sets HUBBLE_REQUIRE_MODEL=1, which
// makes that an error instead — a desktop bundle without its model would be
// a quietly degraded app.
//
// Runs before `dev` and `build` (package.json predev/prebuild). public/models
// is generated and git-ignored.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "Xenova/all-MiniLM-L6-v2";
const REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const FILES = {
  "config.json": "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
  "tokenizer.json": "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  "onnx/model_quantized.onnx": "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
};
const CACHE = path.join(ROOT, "node_modules", ".cache", "hubble-models", MODEL, REVISION);
const TARGET = path.join(ROOT, "public", "models", MODEL);
const required = process.env.HUBBLE_REQUIRE_MODEL === "1";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function ensure(file, expected) {
  const cached = path.join(CACHE, file);
  if (existsSync(cached) && sha256(readFileSync(cached)) === expected) return cached;
  const url = `https://huggingface.co/${MODEL}/resolve/${REVISION}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${file} does not match its pinned hash (got ${actual})`);
  mkdirSync(path.dirname(cached), { recursive: true });
  writeFileSync(cached, bytes);
  return cached;
}

rmSync(path.join(ROOT, "public", "models"), { recursive: true, force: true });
// The website build (Vercel) is the launch site and never runs the app: it gets no model. Dev and the desktop export do.
if (process.env.npm_lifecycle_event === "prebuild" && process.env.TABDUMP_BUILD_TARGET !== "desktop") {
  console.log("[embedding-model] website build: the on-device model is only bundled into Hubble Desktop");
  process.exit(0);
}
try {
  const sources = {};
  for (const [file, expected] of Object.entries(FILES)) sources[file] = await ensure(file, expected);
  for (const [file, source] of Object.entries(sources)) {
    mkdirSync(path.dirname(path.join(TARGET, file)), { recursive: true });
    copyFileSync(source, path.join(TARGET, file));
  }
  console.log(`[embedding-model] ${MODEL}@${REVISION.slice(0, 7)} verified and copied to public/models`);
} catch (error) {
  if (required) {
    console.error(`[embedding-model] the desktop bundle needs the on-device model, and it isn't available: ${error.message}`);
    process.exit(1);
  }
  console.warn(`[embedding-model] model not available (${error.message}); meaning comparison will report itself unavailable.`);
}
