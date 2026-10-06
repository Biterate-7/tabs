import { describe, expect, it } from "vitest";
import { createGrant } from "@/lib/agents/control/permissions";
import { projectCapabilitiesOf, readProjectCapabilities } from "./capabilities";
import {
  checksFromProject,
  gitCountsLine,
  isSafeScriptName,
  parseGitStatusPorcelain,
  scriptForCheck,
  verificationDetail,
  verificationTitle,
} from "./checks";
import { lineDiff, splitLines } from "./diff";
import { commitFromPackedRefs, detectProjectType, parseGitDirPointer, parseGitHead, readProjectInspection } from "./inspection";
import { isSecretLikePath } from "./secrets";
import { projectChangeDetail, projectChangeResult, projectChangeTitle, PROJECT_UNDO_UNAVAILABLE, undoRefusalText } from "./changes";

describe("secret-like files (Hubble 1.6)", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    "apps/web/.env",
    "certs/server.pem",
    "keys/deploy.key",
    "credentials.json",
    "config/secrets.yaml",
    ".ssh/config",
    "home/.aws/credentials",
    "id_ed25519",
    ".npmrc",
    "infra/terraform.tfstate",
    "store.p12",
  ])("refuses %s", (path) => expect(isSecretLikePath(path)).toBe(true));

  it.each(["src/app/api/auth.ts", "README.md", ".env.example", ".env.sample", "src/keys.ts", "docs/secret-santa.md", "environment.ts"])(
    "allows %s",
    (path) => expect(isSecretLikePath(path)).toBe(false)
  );

  it("is case-insensitive and reads Windows separators", () => {
    expect(isSecretLikePath("Config\\SECRETS.json")).toBe(true);
    expect(isSecretLikePath(".ENV")).toBe(true);
  });
});

describe("project capabilities", () => {
  const grant = createGrant(["read_project", "write_project", "run_commands"], 1, "p1")!;

  it("are exactly what the grant allows, plus what the local runtime does itself", () => {
    expect(projectCapabilitiesOf({ grant, projectId: "p1", local: true, checks: true })).toEqual([
      "read_files",
      "write_files",
      "run_commands",
      "inspect_repository",
      "run_checks",
    ]);
  });

  it("never offers checks without run_commands, nor anything local off the machine", () => {
    const readOnly = createGrant(["read_project"], 1, "p1")!;
    expect(projectCapabilitiesOf({ grant: readOnly, projectId: "p1", local: true, checks: true })).toEqual(["read_files", "inspect_repository"]);
    expect(projectCapabilitiesOf({ grant, projectId: "p1", local: false, checks: true })).toEqual(["read_files", "write_files", "run_commands"]);
  });

  it("intersects with what the agent itself can do", () => {
    expect(projectCapabilitiesOf({ grant, projectId: "p1", local: true, providerCapabilities: ["read_files"] })).toEqual(["read_files", "inspect_repository"]);
  });

  it("denies a grant for a different project", () => {
    expect(projectCapabilitiesOf({ grant, projectId: "other", local: false })).toEqual([]);
  });

  it("reads back only known values, in order", () => {
    expect(readProjectCapabilities(["run_checks", "bogus", "read_files", "read_files"])).toEqual(["read_files", "run_checks"]);
    expect(readProjectCapabilities("read_files")).toEqual([]);
  });
});

describe("project checks", () => {
  const manifest = {
    scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", build: "next build" },
  };

  it("are the project's own scripts, plus Git status in a repository", () => {
    expect(checksFromProject({ manifest, git: true })).toEqual([
      { id: "typecheck", command: "npm run typecheck — tsc --noEmit" },
      { id: "lint", command: "npm run lint — eslint ." },
      { id: "test", command: "npm run test — vitest run" },
      { id: "build", command: "npm run build — next build" },
      { id: "git_status", command: "git status" },
    ]);
  });

  it("ignores npm's placeholder test script and unsafe names", () => {
    expect(scriptForCheck({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }, "test")).toBeUndefined();
    expect(isSafeScriptName("test; rm -rf /")).toBe(false);
    expect(isSafeScriptName("test:unit")).toBe(true);
  });

  it("falls back across typecheck spellings", () => {
    expect(scriptForCheck({ scripts: { "type-check": "tsc" } }, "typecheck")?.name).toBe("type-check");
  });

  it("scrubs credentials out of the command it shows", () => {
    const [check] = checksFromProject({ manifest: { scripts: { test: "API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 vitest" } }, git: false });
    expect(check!.command).not.toContain("sk-ant-api03");
  });

  it("separates the project's answer from Hubble's", () => {
    expect(verificationTitle("typecheck", "passed")).toBe("Typecheck passed");
    expect(verificationTitle("test", "failed")).toBe("Tests failed");
    expect(verificationTitle("test", "unavailable")).toBe("Tests aren't available here");
    expect(verificationTitle("build", "timed_out")).toBe("Build took too long and was stopped");
    expect(verificationDetail({ outcome: "failed", exitCode: 1, durationMs: 12_000 })).toBe("Exit code 1 · 12s");
  });

  it("counts Git status without keeping names", () => {
    const counts = parseGitStatusPorcelain(" M src/a.ts\nM  src/b.ts\n?? new.ts\nA  added.ts\n D gone.ts\nR  old -> new\n");
    expect(counts).toEqual({ modified: 2, added: 1, deleted: 1, untracked: 1, renamed: 1 });
    expect(gitCountsLine(counts)).toBe("2 modified · 1 added · 1 deleted · 1 rename · 1 untracked");
    expect(gitCountsLine({ modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0 })).toBe("No uncommitted changes");
  });
});

describe("project inspection", () => {
  it("detects the most specific type from marker files", () => {
    expect(detectProjectType({ manifest: { dependencies: { next: "16" } }, markers: new Set() })).toBe("nextjs");
    expect(detectProjectType({ manifest: { devDependencies: { vite: "7" } }, markers: new Set() })).toBe("vite");
    expect(detectProjectType({ manifest: {}, markers: new Set() })).toBe("node");
    expect(detectProjectType({ markers: new Set(["Cargo.toml"]) })).toBe("rust");
    expect(detectProjectType({ markers: new Set() })).toBeUndefined();
  });

  it("reads HEAD, worktree pointers and packed refs", () => {
    expect(parseGitHead("ref: refs/heads/main\n")).toEqual({ branch: "main", ref: "refs/heads/main" });
    expect(parseGitHead("0123456789abcdef0123456789abcdef01234567")).toEqual({ head: "0123456789ab", detached: true });
    expect(parseGitHead("ref: refs/heads/../../etc")).toBeUndefined();
    expect(parseGitDirPointer("gitdir: C:/repo/.git/worktrees/x\n")).toBe("C:/repo/.git/worktrees/x");
    expect(commitFromPackedRefs("# pack-refs\nabcdefabcdefabcdefabcdefabcdefabcdefabcd refs/heads/main\n", "refs/heads/main")).toBe("abcdefabcdef");
  });

  it("reads an inspection strictly, and never reports a secret file as readable", () => {
    const read = readProjectInspection({
      projectId: "p1",
      state: "ready",
      type: "nextjs",
      repository: { kind: "git", branch: "main", head: "0123456789abcdef" },
      checks: [{ id: "typecheck", command: "npm run typecheck — tsc" }, { id: "rm", command: "rm -rf" }],
      files: [
        { path: "src/a.ts", state: "present", hash: "0123456789ab" },
        { path: ".env", state: "present", hash: "0123456789ab" },
        { path: "../escape", state: "present" },
      ],
      inspectedAt: 5,
      path: "C:/should/not/survive",
    });
    expect(read).toEqual({
      projectId: "p1",
      state: "ready",
      type: "nextjs",
      repository: { kind: "git", branch: "main", head: "0123456789ab" },
      checks: [{ id: "typecheck", command: "npm run typecheck — tsc" }],
      files: [
        { path: "src/a.ts", state: "present", hash: "0123456789ab" },
        { path: ".env", state: "sensitive" },
      ],
      inspectedAt: 5,
    });
    expect(readProjectInspection({ projectId: "p1", state: "on-fire", inspectedAt: 1 })).toBeNull();
  });
});

describe("line diff", () => {
  it("measures added and removed lines exactly", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1, exact: true });
    expect(lineDiff("", "one\ntwo\n")).toEqual({ added: 2, removed: 0, exact: true });
    expect(lineDiff("one\ntwo\n", "")).toEqual({ added: 0, removed: 2, exact: true });
    expect(lineDiff("same\n", "same\n")).toEqual({ added: 0, removed: 0, exact: true });
  });

  it("produces hunks with context and real line numbers", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const diff = lineDiff(before, after, { hunks: true });
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks![0]!.oldStart).toBe(7);
    expect(diff.hunks![0]!.lines.map((line) => line.sign).join("")).toBe("   -+   ");
  });

  it("agrees with a brute-force count on random edits", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
      const b = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
      // Longest common subsequence by dynamic programming: removed + added must equal the edit distance it implies.
      const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      const lcs = dp[0]![0]!;
      const diff = lineDiff(a.join("\n"), b.join("\n"), { hunks: true });
      expect(diff.removed).toBe(a.length - lcs);
      expect(diff.added).toBe(b.length - lcs);
    }
  });

  it("falls back to honest totals for a wholesale rewrite", () => {
    const before = Array.from({ length: 4000 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 4000 }, (_, index) => `new ${index}`).join("\n");
    const diff = lineDiff(before, after, { hunks: true });
    expect(diff).toEqual({ added: 4000, removed: 4000, exact: false });
  });

  it("does not count a trailing newline as a line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
  });
});

describe("project change wording", () => {
  const files = [
    { path: "src/app/api/auth.ts", change: "modified" as const, added: 30, removed: 10 },
    { path: "src/lib/session.ts", change: "modified" as const, added: 4, removed: 2 },
  ];

  it("titles and details a measured change", () => {
    expect(projectChangeTitle({ files, outcome: "applied" })).toBe("Changed 2 files");
    expect(projectChangeDetail({ files, outcome: "applied" })).toBe("+34 −12");
    expect(projectChangeTitle({ files: [{ path: "src/new.ts", change: "created", added: 3, removed: 0 }], outcome: "applied" })).toBe("Created src/new.ts");
  });

  it("never claims an application that did not happen", () => {
    const none = [{ path: "src/a.ts", change: "unchanged" as const }];
    expect(projectChangeTitle({ files: none, outcome: "not_applied" })).toBe("No files were changed");
    expect(projectChangeResult({ files: none, outcome: "not_applied" }).tone).toBe("failure");
    const partial = [files[0]!, { path: "src/b.ts", change: "unchanged" as const }];
    expect(projectChangeResult({ files: partial, outcome: "partial" }).text).toContain("Partly applied");
  });

  it("explains every undo refusal", () => {
    expect(undoRefusalText("changed")).toBe("This change can't be undone because the project has changed since it was made.");
    for (const text of Object.values(PROJECT_UNDO_UNAVAILABLE)) expect(text).toMatch(/^This change can't be undone because /);
  });
});
