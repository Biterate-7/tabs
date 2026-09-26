import { describe, expect, it } from "vitest";
import { detectProviders } from "./detect";
import { agentEnvironment } from "./env";
import { isOnPath, resolveExecutable } from "./resolve";
import type { ResolverFs } from "./resolve";

/** An in-memory filesystem: a set of files and their contents. */
function memoryFs(files: Record<string, string>): ResolverFs {
  const normal = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const table = new Map(Object.entries(files).map(([file, text]) => [normal(file), text]));
  return {
    isFile: (candidate) => table.has(normal(candidate)),
    readText: (candidate) => table.get(normal(candidate)),
  };
}

const WIN_ENV = {
  PATH: "C:\\Tools;C:\\Users\\alice\\AppData\\Roaming\\npm;relative\\dir",
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.PS1",
};

describe("resolving an allowlisted executable", () => {
  it("finds a native executable on PATH", () => {
    const fs = memoryFs({ "C:\\Tools\\grok.exe": "" });
    expect(resolveExecutable("grok", { env: WIN_ENV, platform: "win32", fs })).toEqual({
      kind: "native",
      file: "C:\\Tools\\grok.exe",
    });
  });

  it("follows an npm shim to the allowlisted package's own script, never through a shell", () => {
    const npm = "C:\\Users\\alice\\AppData\\Roaming\\npm";
    const fs = memoryFs({
      [`${npm}\\gemini.cmd`]: "@node ...",
      [`${npm}\\node_modules\\@google\\gemini-cli\\package.json`]: JSON.stringify({
        bin: { gemini: "dist/index.js" },
      }),
      [`${npm}\\node_modules\\@google\\gemini-cli\\dist\\index.js`]: "",
    });

    expect(
      resolveExecutable("gemini", {
        env: WIN_ENV,
        platform: "win32",
        fs,
        npmPackages: ["@google/gemini-cli"],
      })
    ).toEqual({
      kind: "node-script",
      script: `${npm}\\node_modules\\@google\\gemini-cli\\dist\\index.js`,
    });
  });

  it("will not launch a shim whose package is not allowlisted", () => {
    const npm = "C:\\Users\\alice\\AppData\\Roaming\\npm";
    const fs = memoryFs({
      [`${npm}\\gemini.cmd`]: "@node ...",
      [`${npm}\\node_modules\\evil-gemini\\package.json`]: JSON.stringify({ bin: "x.js" }),
      [`${npm}\\node_modules\\evil-gemini\\x.js`]: "",
    });
    expect(
      resolveExecutable("gemini", { env: WIN_ENV, platform: "win32", fs, npmPackages: ["@google/gemini-cli"] })
    ).toBeUndefined();
  });

  it("refuses a package entry that escapes its own package", () => {
    const npm = "C:\\Users\\alice\\AppData\\Roaming\\npm";
    const fs = memoryFs({
      [`${npm}\\gemini.cmd`]: "",
      [`${npm}\\node_modules\\@google\\gemini-cli\\package.json`]: JSON.stringify({
        bin: { gemini: "../../../../evil.js" },
      }),
      [`${npm}\\evil.js`]: "",
    });
    expect(
      resolveExecutable("gemini", { env: WIN_ENV, platform: "win32", fs, npmPackages: ["@google/gemini-cli"] })
    ).toBeUndefined();
  });

  it("ignores relative PATH entries and never considers PowerShell or VBScript", () => {
    const fs = memoryFs({ "relative\\dir\\grok.exe": "", "C:\\Tools\\grok.ps1": "", "C:\\Tools\\grok.vbs": "" });
    expect(resolveExecutable("grok", { env: WIN_ENV, platform: "win32", fs })).toBeUndefined();
  });

  it("accepts a name and nothing that looks like a path or an argument", () => {
    const fs = memoryFs({ "C:\\Tools\\grok.exe": "" });
    for (const name of ["..\\grok", "C:\\Tools\\grok", "grok --yolo", "grok;calc", ""]) {
      expect(resolveExecutable(name, { env: WIN_ENV, platform: "win32", fs })).toBeUndefined();
      expect(isOnPath(name, { env: WIN_ENV, platform: "win32", fs })).toBe(false);
    }
  });

  it("resolves on POSIX without extensions", () => {
    const fs = memoryFs({ "/usr/local/bin/gemini": "" });
    expect(
      resolveExecutable("gemini", { env: { PATH: "/usr/bin:/usr/local/bin" }, platform: "linux", fs })
    ).toEqual({ kind: "native", file: "/usr/local/bin/gemini" });
  });
});

describe("detecting installed agents", () => {
  it("reports installation and launchability — and no path, and nothing about sign-in", () => {
    const fs = memoryFs({
      "/usr/local/bin/claude": "",
      "/usr/local/bin/gemini": "",
      "/usr/local/bin/codex": "",
      "/home/alice/.gemini/oauth_creds.json": "{\"refresh_token\":\"never-read\"}",
    });

    const detections = detectProviders({
      env: { PATH: "/usr/local/bin" },
      platform: "linux",
      fs,
    });

    expect(detections).toEqual([
      { provider: "claude-code", installed: true, transport: "sdk", launchable: false },
      { provider: "gemini", installed: true, transport: "acp", launchable: true },
      // Codex is installed but its ACP adapter is not, so it cannot be driven yet.
      { provider: "openai-codex", installed: true, transport: "acp", launchable: false },
      { provider: "grok", installed: false, transport: "acp", launchable: false },
    ]);

    const serialized = JSON.stringify(detections);
    expect(serialized).not.toContain("/usr/local");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("never-read");
  });

  it("never looks in the home directory: a login file is not evidence of a sign-in (Phase J.2)", () => {
    const looked: string[] = [];
    const base = memoryFs({ "/usr/local/bin/gemini": "" });
    detectProviders({
      env: { PATH: "/usr/local/bin" },
      platform: "linux",
      fs: {
        isFile: (candidate) => (looked.push(candidate), base.isFile(candidate)),
        readText: (candidate) => (looked.push(candidate), base.readText(candidate)),
      },
    });
    expect(looked.every((candidate) => candidate.startsWith("/usr/local/bin/"))).toBe(true);
  });
});

describe("the agent's environment", () => {
  it("is an allowlist: no provider key, no Hubble secret, no NODE_ENV", () => {
    const env = agentEnvironment({
      PATH: "C:\\Tools",
      USERPROFILE: "C:\\Users\\alice",
      APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-openai-secret",
      GEMINI_API_KEY: "gemini-secret",
      XAI_API_KEY: "xai-secret",
      CODEX_API_KEY: "codex-secret",
      POSTGRES_URL: "postgres://user:pw@db/tabdump",
      TABDUMP_CREDENTIAL_KEY: "k",
      TABDUMP_LOCAL_AGENT_RUNTIME: "opt-in",
      NODE_ENV: "development",
    });

    expect(Object.keys(env).sort()).toEqual(["APPDATA", "NO_COLOR", "PATH", "USERPROFILE"]);
    expect(JSON.stringify(env)).not.toMatch(/secret|postgres|opt-in/);
  });
});
