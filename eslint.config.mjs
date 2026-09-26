import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Rust build output. `cargo`/`tauri build` writes generated JS in here
    // (Tauri's codegen assets and its global API shim), which is machine
    // output, sometimes not even valid UTF-8 — linting it produces parse
    // errors for code nobody wrote. src-tauri/.gitignore already keeps it out
    // of git; this keeps it out of eslint, which does not read that file.
    "src-tauri/target/**",
    "src-tauri/gen/**",
    // The desktop agent runtime sidecar, bundled by `npm run desktop:runtime`
    // (Phase J.1): one generated file of the whole runtime plus its
    // dependencies, gitignored like the Node binary beside it.
    "src-tauri/agent-runtime/**",
    "src-tauri/binaries/**",
  ]),
]);

export default eslintConfig;
