import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { setStorageNamespace } from "@/lib/storage/namespace";
import {
  clearAllSessionCredentials,
  clearSessionCredential,
  describeSessionCredential,
  getSessionCredential,
  hasSessionCredential,
  setSessionCredential,
} from "./session-credentials";
import { connectorError } from "./types";
import { CONNECTOR_STORAGE_KEY, loadConnectorConfig, saveConnectorConfig, setConnectorEnabled } from "./persistence";
import { setConnectorLogSink } from "./observability";
import { createConnectorManager } from "./manager";
import { createTestConnector } from "./__fixtures__/test-connector";
import type { ConnectorLogRecord } from "./observability";

/**
 * The connector layer's structural guards.
 *
 * Phase 17 adds the one thing the agent domain deliberately did not have: a
 * boundary that faces outward. That makes two rules worth enforcing
 * mechanically rather than by review, because both fail silently:
 *
 *   1. **A connector may observe and may do nothing else.** The distance
 *      between "observes an agent" and "drives an agent" is the entire safety
 *      story, and a single `exec` added later to "just stop a stuck run"
 *      would close it.
 *   2. **A secret never reaches storage, an export, or a log.** localStorage
 *      is readable by any script on the origin and survives indefinitely, so
 *      a credential written there is a credential given away.
 */

const CONNECTOR_DIR = path.resolve(__dirname);
const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** Every shipped source file in the connector layer, including provider subdirectories. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Fixtures are test support and necessarily contain what a test asserts about.
      return entry === "__fixtures__" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const sources = walk(CONNECTOR_DIR).map((file) => ({
  file: path.relative(REPO_ROOT, file),
  source: readFileSync(file, "utf8"),
}));

/** Code lines only — prose legitimately discusses what is *not* done. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
  clearAllSessionCredentials();
  setConnectorLogSink(null);
});

afterEach(() => {
  clearAllSessionCredentials();
  setConnectorLogSink(null);
  setStorageNamespace(null);
  window.localStorage.clear();
});

describe("the connector layer cannot execute anything", () => {
  it("finds the files it is supposed to be checking", () => {
    // Guards against the walker silently matching nothing and the whole suite
    // passing vacuously.
    expect(sources.length).toBeGreaterThanOrEqual(10);
    const names = sources.map((entry) => path.basename(entry.file));
    expect(names).toContain("manager.ts");
    expect(names).toContain("claude-code.ts");
    expect(names).toContain("session-credentials.ts");
  });

  it("imports no process, shell or filesystem module", () => {
    const forbidden = [
      "child_process",
      "node:child_process",
      "node:fs",
      "node:fs/promises",
      "fs/promises",
      "node:os",
      "node:net",
      "node:worker_threads",
      "node:vm",
    ];

    const offenders: string[] = [];
    for (const { file, source } of sources) {
      const specifiers = [
        ...source.matchAll(/^\s*import\s[^\n]*?["']([^"']+)["']/gm),
        ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
        ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        if (forbidden.includes(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no execution or filesystem call shape", () => {
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const call of [
        "spawnSync",
        "execFile",
        "execSync",
        "spawn(",
        "exec(",
        "readFileSync",
        "writeFileSync",
        "eval(",
        "new Function(",
      ]) {
        if (codeOf(source).includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never shells out or runs git", () => {
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const pattern of [/\bgit\s+(status|diff|log|commit|rev-parse)\b/, /\bchildProcess\b/]) {
        if (pattern.test(codeOf(source))) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the connector contract offers no control surface", () => {
  it("declares no member that would act on an external agent", () => {
    const contract = readFileSync(path.join(CONNECTOR_DIR, "types.ts"), "utf8");
    const declaration = contract.slice(contract.indexOf("export interface AgentConnector"));
    const members = [...declaration.matchAll(/^\s{2}(?:readonly\s+)?(\w+)[(:]/gm)].map((m) => m[1]);

    expect(members).toContain("subscribe");

    // `connect`/`disconnect` are about TabDump's own observation and are
    // allowed. These would be about the agent, and are not — whatever else
    // the interface grows.
    for (const forbidden of [
      "start",
      "stop",
      "kill",
      "cancel",
      "exec",
      "prompt",
      "sendMessage",
      "write",
      "send",
      "interrupt",
      "resume",
    ]) {
      expect(members).not.toContain(forbidden);
    }
  });

  it("gives an observation nowhere to carry a command", () => {
    const adapter = readFileSync(path.resolve(CONNECTOR_DIR, "../adapter.ts"), "utf8");
    const observation = adapter.slice(
      adapter.indexOf("export type AgentAdapterObservation"),
      adapter.indexOf("export type ObservedWorkItem")
    );

    for (const forbidden of ["command", "argv", "script", "shell", "exec"]) {
      expect(observation.toLowerCase()).not.toContain(`${forbidden}:`);
    }
  });
});

describe("secrets are never persisted", () => {
  it("keeps a session credential entirely out of storage", () => {
    setSessionCredential("gemini", "sk-live-abcdef123456");

    saveConnectorConfig(setConnectorEnabled(loadConnectorConfig(), "gemini", true, 1_700_000_000_000));

    // Everything in localStorage, not merely the connector key: a secret that
    // leaked into any other key would be just as given away.
    const everything = Object.keys(window.localStorage)
      .map((key) => `${key}=${window.localStorage.getItem(key)}`)
      .join("\n");

    expect(everything).not.toContain("sk-live");
    expect(everything).not.toContain("abcdef123456");
  });

  it("does not write to storage at all when a credential is set", () => {
    const before = window.localStorage.length;
    setSessionCredential("grok", "xai-secret-value");
    expect(window.localStorage.length).toBe(before);
  });

  it("has no way to write a secret anywhere", () => {
    // Code lines only: the module's own prose necessarily discusses the
    // storage it refuses to use, and why.
    const code = codeOf(readFileSync(path.join(CONNECTOR_DIR, "session-credentials.ts"), "utf8"));

    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "scopedKey",
      "document.cookie",
      "fetch(",
    ]) {
      expect(code).not.toContain(forbidden);
    }

    // Every import is type-only, so the module has no runtime dependency at
    // all — nothing it could reach to write a value out through.
    const imports = [...code.matchAll(/^\s*import\s[^\n]*/gm)].map((match) => match[0]);
    expect(imports.length).toBeGreaterThan(0);
    for (const statement of imports) expect(statement).toContain("import type");
  });

  it("offers no way to enumerate every secret", () => {
    setSessionCredential("gemini", "one");
    setSessionCredential("grok", "two");

    const surface = { hasSessionCredential, getSessionCredential, describeSessionCredential };

    // A bulk accessor is what an export, a debug dump or a log line would use
    // to sweep secrets up. There is none.
    for (const forbidden of ["list", "entries", "all", "toJSON", "values", "keys"]) {
      expect(surface).not.toHaveProperty(forbidden);
    }
  });

  it("describes a secret by presence and length only", () => {
    setSessionCredential("gemini", "sk-live-abcdef");

    const described = describeSessionCredential("gemini");
    expect(described).toEqual({ present: true, length: 14 });
    // Not even a masked prefix: showing the first characters of a key is a
    // habit borrowed from services that can revoke them.
    expect(JSON.stringify(described)).not.toContain("sk-");
  });

  it("treats an empty value as clearing rather than storing", () => {
    setSessionCredential("gemini", "value");
    setSessionCredential("gemini", "   ");

    expect(hasSessionCredential("gemini")).toBe(false);
  });

  it("clears on request and in bulk", () => {
    setSessionCredential("gemini", "a");
    setSessionCredential("grok", "b");

    clearSessionCredential("gemini");
    expect(hasSessionCredential("gemini")).toBe(false);
    expect(hasSessionCredential("grok")).toBe(true);

    clearAllSessionCredentials();
    expect(hasSessionCredential("grok")).toBe(false);
  });
});

describe("workspace export carries no connector state", () => {
  it("exports neither configuration nor credentials", async () => {
    setSessionCredential("gemini", "sk-live-export-check");
    saveConnectorConfig(
      setConnectorEnabled(loadConnectorConfig(), "gemini", true, 1_700_000_000_000)
    );

    const { buildWorkspaceExport, serializeWorkspaceExport } = await import(
      "@/lib/workspace/json-export"
    );

    const json = serializeWorkspaceExport(
      buildWorkspaceExport([
        {
          id: "w1",
          name: "Work",
          tabs: [],
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        } as unknown as Parameters<typeof buildWorkspaceExport>[0][number],
      ])
    );

    expect(json).not.toContain("sk-live");
    expect(json).not.toContain("connectors");
    expect(json).not.toContain(CONNECTOR_STORAGE_KEY);
  });

  it("has no export path that reads connector state at all", () => {
    // The structural version of the assertion above: the export modules do
    // not import the connector layer, so there is no route by which a future
    // change could start including it without that import appearing here.
    for (const file of ["json-export.ts", "export.ts"]) {
      const source = readFileSync(path.resolve(REPO_ROOT, "src/lib/workspace", file), "utf8");
      expect(source).not.toContain("connectors/");
      expect(source).not.toContain("session-credentials");
    }
  });
});

describe("logging carries no content and no secret", () => {
  it("records counts and codes, never payloads", async () => {
    const records: ConnectorLogRecord[] = [];
    setConnectorLogSink((record) => records.push(record));

    const connector = createTestConnector({ provider: "claude-code" });
    const manager = createConnectorManager({
      registrations: [{ descriptor: connector.descriptor, create: () => connector }],
    });

    await manager.connect("claude-code");
    connector.emit([
      {
        provider: "claude-code",
        externalId: "session-secret-id",
        title: "Rotate the production API key",
        activity: "Edited .env",
      },
    ]);
    connector.fail("permission-denied");

    expect(records.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("Rotate the production");
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("session-secret-id");

    const observed = records.find((record) => record.event === "connector.observations");
    expect(observed?.count).toBe(1);

    const failed = records.find((record) => record.event === "connector.error");
    expect(failed?.error).toBe("permission-denied");

    manager.dispose();
  });

  it("emits nothing at all when no sink is installed", () => {
    // The default: a local-first app must not leave a trail of what someone
    // was working on in a console they did not ask for.
    const connector = createTestConnector({ provider: "claude-code" });
    expect(() => connector.emit([{ provider: "claude-code", externalId: "x" }])).not.toThrow();
  });

  it("has no field a caller could put provider text into", () => {
    const source = readFileSync(path.join(CONNECTOR_DIR, "observability.ts"), "utf8");
    const record = source.slice(
      source.indexOf("export type ConnectorLogRecord"),
      source.indexOf("export type ConnectorLogSink")
    );

    for (const forbidden of ["message:", "detail:", "payload:", "body:", "data:", "raw:"]) {
      expect(record).not.toContain(forbidden);
    }
  });
});

describe("errors are safe by construction", () => {
  it("builds a message from a fixed table rather than from a thrown value", () => {
    const error = connectorError("unreachable");

    expect(error.message).toBe("Could not reach the provider.");
    expect(connectorError("permission-denied").message).not.toBe(error.message);

    // The function takes a code and nothing else, so there is no parameter a
    // provider's own string could arrive through.
    expect(connectorError.length).toBe(1);
  });
});

describe("the layer touches only its own storage key", () => {
  it("names no other tabdump key", () => {
    const keys = new Set<string>();
    for (const { source } of sources) {
      for (const match of source.matchAll(/["'](tabdump:[^"']+)["']/g)) keys.add(match[1]);
    }

    expect([...keys]).toEqual([CONNECTOR_STORAGE_KEY]);
  });

  it("is registered for account scoping", async () => {
    const { SCOPED_STORAGE_KEYS } = await import("@/lib/storage/namespace");
    expect(SCOPED_STORAGE_KEYS).toContain(CONNECTOR_STORAGE_KEY);
  });
});
