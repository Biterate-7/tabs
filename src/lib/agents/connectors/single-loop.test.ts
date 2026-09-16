import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { defaultConnectorCatalog } from "./catalog";
import { createConnectorManager } from "./manager";

/**
 * One poll loop against the user's machine, enforced mechanically.
 *
 * Several files claim this in prose — the observer hook says "one
 * subscription, one loop", GraphView says "THE observer", AppShell says "THE
 * connector restore" — and until now nothing checked it. That is exactly the
 * kind of invariant that holds until someone adds a second surface which
 * needs connector state and reasonably mounts the same hook.
 *
 * Phase 17 made that likelier rather than less likely: there are now three
 * `useAgentConnectors` call sites, and the difference between the one that
 * starts observation and the two that merely display it is a single option.
 *
 * Duplicate polling is not a cosmetic problem. Two loops means two cursors
 * over the same transcripts, the same observation ingested twice, and twice
 * the reads of someone's machine — all of it silent, because the app would
 * look like it was working.
 */

const SRC = path.resolve(__dirname, "../../..");

/** Every shipped source file (no tests, no fixtures). */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__fixtures__" || entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const sources = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).replace(/\\/g, "/"),
  source: readFileSync(file, "utf8"),
}));

/** Call sites of `name(`, excluding the file that defines it. */
function callSites(name: string, definedIn: string): string[] {
  return sources
    .filter((entry) => entry.file !== definedIn)
    .filter((entry) => new RegExp(`\\b${name}\\s*\\(`).test(entry.source))
    .map((entry) => entry.file);
}

describe("the scan is looking at the right tree", () => {
  it("finds the files it is supposed to be checking", () => {
    expect(sources.length).toBeGreaterThan(100);
    const names = sources.map((entry) => entry.file);
    expect(names).toContain("components/app-shell.tsx");
    expect(names).toContain("components/graph/graph-view.tsx");
    expect(names).toContain("hooks/use-claude-code-observer.ts");
  });
});

describe("exactly one thing starts observation", () => {
  it("has a single `restore: true` in the whole app", () => {
    const offenders = sources
      .filter((entry) => /restore:\s*true/.test(entry.source))
      .map((entry) => entry.file);

    // A second restoring mount would connect the same connectors again.
    // Connecting is idempotent in the manager, but the invariant is cheap to
    // state and the alternative is relying on that forever.
    expect(offenders).toEqual(["components/app-shell.tsx"]);
  });

  it("mounts the Claude observer in exactly one place", () => {
    expect(callSites("useClaudeCodeObserver", "hooks/use-claude-code-observer.ts")).toEqual([
      "components/graph/graph-view.tsx",
    ]);
  });
});

describe("exactly one Claude adapter can exist", () => {
  it("constructs the adapter in only two places, one of which is a guarded fallback", () => {
    const sites = callSites("createClaudeCodeAdapter", "lib/agents/claude-code/adapter.ts");

    expect(sites.sort()).toEqual([
      "hooks/use-claude-code-observer.ts",
      "lib/agents/connectors/providers/claude-code.ts",
    ]);
  });

  it("skips the hook's own adapter whenever a connector was supplied", () => {
    const hook = sources.find((entry) => entry.file === "hooks/use-claude-code-observer.ts")!;

    // The guard that makes the second construction site unreachable in
    // production: GraphView always passes the manager's connector, so the
    // hook never builds one of its own. Written as a ternary on `connector`
    // so this assertion can see it.
    expect(hook.source).toMatch(/connector\s*\?\s*null\s*:\s*createClaudeCodeAdapter/);
  });

  it("gives the production app a Claude connector to pass, so the fallback never fires", () => {
    // The other half of the guard above: the fallback is unreachable only
    // because the catalog always registers claude-code. If that ever stopped
    // being true, the hook would quietly start its own loop.
    const manager = createConnectorManager({ registrations: defaultConnectorCatalog() });

    expect(manager.connector("claude-code")).toBeDefined();

    manager.dispose();
  });
});

describe("the poll loop belongs to the adapter alone", () => {
  it("runs no timer of its own in the connector layer", () => {
    const connectorDir = path.resolve(__dirname);
    const offenders: string[] = [];

    for (const entry of sources) {
      const abs = path.resolve(SRC, entry.file);
      if (!abs.startsWith(connectorDir)) continue;

      const code = entry.source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");

      // setTimeout is legitimate — the manager's bounded reconnect backoff
      // uses it. A repeating timer is not: polling is the adapter's job, and
      // a second scheduler here would be a second loop by another name.
      for (const forbidden of ["setInterval", "requestAnimationFrame"]) {
        if (code.includes(forbidden)) offenders.push(`${entry.file}: ${forbidden}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the one interval constant in the provider that owns it", () => {
    const declarations = sources.filter((entry) =>
      /CLAUDE_POLL_INTERVAL_MS\s*=/.test(entry.source)
    );

    expect(declarations.map((entry) => entry.file)).toEqual(["lib/agents/claude-code/types.ts"]);
  });
});
