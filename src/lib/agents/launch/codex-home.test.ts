import { describe, expect, it } from "vitest";
import { CODEX_HOME_CONFIG, hubbleCodexHome, prepareCodexHome } from "./codex-home";
import type { CodexHomeFs } from "./codex-home";

function memoryFs(files: Record<string, string> = {}, directories: Record<string, string[]> = {}) {
  const written: Record<string, string> = {};
  const fs: CodexHomeFs & { written: typeof written } = {
    written,
    makeDirectory: () => {},
    readText: (file) => written[file] ?? files[file],
    writeText: (file, text) => {
      written[file] = text;
    },
    list: (directory) => directories[directory],
  };
  return fs;
}

describe("Hubble's Codex folder", () => {
  it("lives in the per-user application-data folder, never ~/.codex", () => {
    expect(hubbleCodexHome({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", CODEX_HOME: "C:\\Users\\me\\.codex" }, "win32")).toBe(
      "C:\\Users\\me\\AppData\\Local\\Hubble\\codex"
    );
    expect(hubbleCodexHome({ HOME: "/Users/me" }, "darwin")).toBe("/Users/me/Library/Application Support/Hubble/codex");
    expect(hubbleCodexHome({ HOME: "/home/me" }, "linux")).toBe("/home/me/.local/state/hubble/codex");
    expect(hubbleCodexHome({ HOME: "/home/me", XDG_STATE_HOME: "/state" }, "linux")).toBe("/state/hubble/codex");
    // Nothing to go on, or a relative path: refused rather than guessed.
    expect(hubbleCodexHome({}, "win32")).toBeUndefined();
    expect(hubbleCodexHome({ LOCALAPPDATA: "AppData" }, "win32")).toBeUndefined();
  });

  it("rewrites config.toml with Hubble's own settings, discarding whatever was added", () => {
    const home = "C:\\h";
    const fs = memoryFs({
      "C:\\h\\config.toml": '[mcp_servers.mine]\ncommand = "evil.exe"\n[windows]\nsandbox = "elevated"\napproval_policy = "never"\n',
    });
    expect(prepareCodexHome(home, fs, "win32")).toEqual({ ok: true });
    expect(fs.written["C:\\h\\config.toml"]).toBe(CODEX_HOME_CONFIG);
    expect(CODEX_HOME_CONFIG).not.toMatch(/^\s*[a-z_]+\s*=|^\s*\[/m);
  });

  it("refuses to launch when an approval rule is present — one could run commands unasked", () => {
    const fs = memoryFs({}, { "C:\\h\\rules": ["default.rules"] });
    expect(prepareCodexHome("C:\\h", fs, "win32")).toEqual({ ok: false, reason: "has-rules" });
    expect(prepareCodexHome("C:\\h", memoryFs({}, { "C:\\h\\rules": [] }), "win32")).toEqual({ ok: true });
  });

  it("refuses when the folder cannot be written", () => {
    const fs = memoryFs();
    fs.writeText = () => {
      throw new Error("EACCES");
    };
    expect(prepareCodexHome("C:\\h", fs, "win32")).toEqual({ ok: false, reason: "unwritable" });
  });
});
