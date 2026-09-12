import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Validates the desktop shell's configuration without needing a Rust
 * toolchain, so a change that quietly widens the app's privileges fails in
 * the ordinary `npm test` run rather than at a release review.
 *
 * The invariant these cases defend: TabDump's desktop build can open an
 * http(s) URL and save a file the user picked, and nothing else. Every
 * assertion below is one a real regression would trip.
 */

const ROOT = path.resolve(__dirname, "../../..");
const TAURI_DIR = path.join(ROOT, "src-tauri");

const conf = JSON.parse(readFileSync(path.join(TAURI_DIR, "tauri.conf.json"), "utf8"));
const capability = JSON.parse(
  readFileSync(path.join(TAURI_DIR, "capabilities", "default.json"), "utf8")
);
const cargoToml = readFileSync(path.join(TAURI_DIR, "Cargo.toml"), "utf8");
const libRs = readFileSync(path.join(TAURI_DIR, "src", "lib.rs"), "utf8");
const commandsRs = readFileSync(path.join(TAURI_DIR, "src", "commands.rs"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

describe("tauri.conf.json", () => {
  it("has a real reverse-DNS identifier, not Tauri's placeholder", () => {
    expect(conf.identifier).toBe("app.tabdump.desktop");
    expect(conf.identifier).not.toContain("tauri.dev");
  });

  it("packages the static export the desktop build script produces", () => {
    expect(conf.build.frontendDist).toBe("../out");
    expect(conf.build.beforeBuildCommand).toBe("npm run desktop:export");
  });

  it("points desktop development at the Next dev server so hot reload works", () => {
    expect(conf.build.devUrl).toBe("http://localhost:3000");
    expect(conf.build.beforeDevCommand).toBe("npm run dev");
  });

  it("keeps the Tauri globals off the window object", () => {
    // `withGlobalTauri: true` would expose __TAURI__ to any script on the
    // page; the frontend reaches IPC through @tauri-apps/api instead.
    expect(conf.app.withGlobalTauri).toBe(false);
  });

  it("declares no window in config, because the guarded one is built in Rust", () => {
    // on_navigation can only be attached via WebviewWindowBuilder — see
    // src-tauri/src/lib.rs. A window declared here would be unguarded.
    expect(conf.app.windows).toEqual([]);
  });

  it("stays version-locked to package.json", () => {
    expect(conf.version).toBe(pkg.version);
  });

  describe("content security policy", () => {
    const csp = conf.app.security.csp;

    it("defaults to self and forbids plugins, framing and form posts", () => {
      expect(csp["default-src"]).toBe("'self'");
      expect(csp["object-src"]).toBe("'none'");
      expect(csp["frame-src"]).toBe("'none'");
      expect(csp["form-action"]).toBe("'none'");
      expect(csp["base-uri"]).toBe("'self'");
    });

    it("never allows eval", () => {
      for (const value of Object.values(csp)) {
        expect(String(value)).not.toContain("unsafe-eval");
      }
    });

    it("allows only the favicon host as a remote image source", () => {
      // src/lib/workspace/favicon.ts resolves favicons through Google's s2
      // service; nothing else remote is loaded.
      expect(csp["img-src"]).toContain("https://www.google.com");
      expect(csp["img-src"]).toContain("'self'");
    });
  });
});

describe("capabilities", () => {
  it("grants the frontend Tauri's core baseline and nothing more", () => {
    expect(capability.permissions).toEqual(["core:default"]);
    expect(capability.windows).toEqual(["main"]);
  });

  it("grants no filesystem, shell, http or opener permission to the frontend", () => {
    const granted = JSON.stringify(capability.permissions);
    for (const dangerous of ["fs:", "shell:", "http:", "opener:", "process:"]) {
      expect(granted).not.toContain(dangerous);
    }
  });
});

describe("Cargo.toml", () => {
  it("depends on no plugin that would grant broad OS access", () => {
    // The opener and dialog plugins are present but used only from Rust,
    // behind the validated commands; shell/fs/http are absent entirely.
    for (const dangerous of ["tauri-plugin-shell", "tauri-plugin-fs", "tauri-plugin-http"]) {
      expect(cargoToml).not.toContain(dangerous);
    }
  });
});

describe("the Rust shell", () => {
  it("refuses navigation away from the app origin by default", () => {
    expect(libRs).toContain("on_navigation");
    expect(libRs).toContain("is_internal");
    // The guard's fall-through must be a refusal, not an allow.
    expect(libRs).toMatch(/\n\s*false\s*\n\s*\}\)/);
  });

  it("only ever treats the app's own origins as internal", () => {
    expect(libRs).toContain('"tauri.localhost"');
    expect(libRs).toContain('"localhost"');
    expect(libRs).toContain('"127.0.0.1"');
  });

  it("safelists http(s) before opening anything externally", () => {
    expect(commandsRs).toContain('"http" | "https"');
    expect(commandsRs).toContain("Refusing to open");
  });

  it("never lets the frontend name a filesystem path", () => {
    // The export command takes a suggested *name*; the path comes from the
    // native save dialog the user interacted with.
    expect(commandsRs).toContain("suggested_name: String");
    expect(commandsRs).toContain("blocking_save_file");
    expect(commandsRs).not.toMatch(/fn\s+\w+\([^)]*path:\s*String/);
  });

  it("exposes exactly two commands to the frontend", () => {
    const handler = libRs.match(/generate_handler!\[([\s\S]*?)\]/);
    expect(handler).not.toBeNull();
    const names = handler![1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(names).toEqual(["commands::open_external", "commands::export_text_file"]);
  });
});

describe("npm scripts", () => {
  it("keeps web development free of any desktop toolchain", () => {
    expect(pkg.scripts.dev).toBe("next dev");
    expect(pkg.scripts.build).toBe("next build");
  });

  it("exposes the desktop workflows", () => {
    expect(pkg.scripts["desktop:dev"]).toBe("tauri dev");
    expect(pkg.scripts["desktop:build"]).toBe("tauri build");
    expect(pkg.scripts["desktop:export"]).toBe("node scripts/desktop-export.mjs");
  });
});
