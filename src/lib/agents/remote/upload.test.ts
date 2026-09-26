import { describe, expect, it } from "vitest";
import { isExcludedPath, normalizeUploadPath, validateUpload } from "./upload";
import { REMOTE_LIMITS } from "./types";
import type { UploadEntry } from "./upload";

/**
 * The upload validator.
 *
 * This is the one place in the remote plane where a user-chosen string
 * becomes a path on a filesystem, so it gets the archive-extraction treatment:
 * every classic escape, every encoding trick, and the boring limits that stop
 * a pathological upload from being a denial of service.
 */

function file(path: string, bytes = 8): UploadEntry {
  return { path, content: new Uint8Array(bytes) };
}

describe("path normalization", () => {
  it("accepts an ordinary relative path and rebuilds it", () => {
    expect(normalizeUploadPath("src/lib/index.ts")).toEqual({
      ok: true,
      path: "src/lib/index.ts",
    });
  });

  it("collapses the formatting artefacts a browser produces", () => {
    // Doubled separators and a `./` prefix are how directory pickers spell
    // things, not attempts at anything. Skipped rather than refused.
    expect(normalizeUploadPath("./src//lib/index.ts")).toEqual({
      ok: true,
      path: "src/lib/index.ts",
    });
    expect(normalizeUploadPath("src/lib/")).toEqual({ ok: true, path: "src/lib" });
  });

  it("normalizes Windows separators, because the sandbox is always Linux", () => {
    expect(normalizeUploadPath("src\\lib\\index.ts")).toEqual({
      ok: true,
      path: "src/lib/index.ts",
    });
  });

  for (const traversal of [
    "../secrets",
    "../../etc/passwd",
    "src/../../etc/passwd",
    "a/b/../../../c",
    "..",
    "src/..",
  ]) {
    it(`refuses traversal: ${traversal}`, () => {
      // Every `..` refuses, including ones that would resolve back inside the
      // root. Resolving them would make the rule depend on an off-by-one.
      expect(normalizeUploadPath(traversal)).toEqual({ ok: false, reason: "traversal" });
    });
  }

  for (const absolute of ["/etc/passwd", "/workspace/.tabdump/agent-bridge.mjs", "//server/share"]) {
    it(`refuses absolute: ${absolute}`, () => {
      expect(normalizeUploadPath(absolute)).toEqual({ ok: false, reason: "absolute-path" });
    });
  }

  for (const drive of ["C:/Windows/System32", "c:temp/x", "D:\\data\\x"]) {
    it(`refuses drive-qualified: ${drive}`, () => {
      expect(normalizeUploadPath(drive)).toEqual({ ok: false, reason: "drive-relative" });
    });
  }

  it("refuses a NUL byte, which truncates a string in a lower layer", () => {
    // `a.txt\0../../etc/passwd` validates as `a.txt` to anything that stops at
    // the NUL, and means something else to anything that does not.
    expect(normalizeUploadPath("a.txt\u0000../../etc/passwd")).toEqual({
      ok: false,
      reason: "unsupported-character",
    });
  });

  it("refuses other control characters", () => {
    expect(normalizeUploadPath("src/in\u001bdex.ts")).toEqual({
      ok: false,
      reason: "unsupported-character",
    });
    expect(normalizeUploadPath("src/in\ndex.ts")).toEqual({
      ok: false,
      reason: "unsupported-character",
    });
  });

  it("refuses an empty or whitespace-only path", () => {
    expect(normalizeUploadPath("")).toEqual({ ok: false, reason: "empty-path" });
    expect(normalizeUploadPath("   ")).toEqual({ ok: false, reason: "empty-path" });
    expect(normalizeUploadPath("///")).toEqual({ ok: false, reason: "absolute-path" });
    expect(normalizeUploadPath("./")).toEqual({ ok: false, reason: "empty-path" });
  });

  it("refuses paths that are too deep or too long", () => {
    expect(normalizeUploadPath(`${"a/".repeat(40)}b`)).toEqual({ ok: false, reason: "too-deep" });
    expect(normalizeUploadPath(`${"a".repeat(300)}.ts`)).toEqual({ ok: false, reason: "too-long" });
    expect(normalizeUploadPath(`${"ab/".repeat(400)}x`)).toEqual({ ok: false, reason: "too-long" });
  });

  it("does not decode percent-escapes into separators", () => {
    // `%2e%2e%2f` is `../` only after a decode this never performs. Treating
    // it as an ordinary file name is correct: nothing downstream decodes it
    // either, so it names a file with an odd name and escapes nothing.
    expect(normalizeUploadPath("%2e%2e%2fetc/passwd")).toEqual({
      ok: true,
      path: "%2e%2e%2fetc/passwd",
    });
  });
});

describe("exclusions", () => {
  for (const excluded of [
    ".git/config",
    "src/.git/hooks/pre-commit",
    ".env",
    "api/.env.local",
    "node_modules/left-pad/index.js",
    ".ssh/id_rsa",
    ".aws/credentials",
    ".npmrc",
  ]) {
    it(`excludes ${excluded}`, () => {
      expect(isExcludedPath(excluded)).toBe(true);
    });
  }

  it("does not exclude a file that merely resembles one", () => {
    expect(isExcludedPath("src/environment.ts")).toBe(false);
    expect(isExcludedPath("docs/git-workflow.md")).toBe(false);
    expect(isExcludedPath("src/env/index.ts")).toBe(false);
  });

  it("reports what it dropped rather than dropping it silently", () => {
    const result = validateUpload([file("src/index.ts"), file(".env"), file(".git/config")]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.files.map((entry) => entry.path)).toEqual(["src/index.ts"]);
    // The user is told, so they do not discover the omission when the agent
    // reasons about a project that is missing something they thought they sent.
    expect(result.excluded).toEqual([".env", ".git/config"]);
  });
});

describe("whole uploads", () => {
  it("refuses the entire upload when one path is bad", () => {
    // Deliberately not "drop the bad file": a project missing a file the user
    // believed they sent is one the agent will reason about wrongly, and they
    // would have no way of knowing.
    expect(validateUpload([file("src/index.ts"), file("../escape")])).toEqual({
      ok: false,
      reason: "traversal",
    });
  });

  it("refuses two entries that normalize to the same path", () => {
    // Write a benign file, then overwrite it. Last-wins would make which one
    // survives a question about ordering.
    expect(validateUpload([file("src/a.ts"), file("./src//a.ts")])).toEqual({
      ok: false,
      reason: "duplicate-path",
    });
  });

  it("refuses an empty upload, and one that is empty after exclusions", () => {
    expect(validateUpload([])).toEqual({ ok: false, reason: "no-files" });
    expect(validateUpload([file(".env"), file("node_modules/x.js")])).toEqual({
      ok: false,
      reason: "no-files",
    });
  });

  it("enforces the per-file, total and count limits", () => {
    expect(validateUpload([file("big.bin", REMOTE_LIMITS.maxUploadFileBytes + 1)])).toEqual({
      ok: false,
      reason: "file-too-large",
    });

    const chunk = REMOTE_LIMITS.maxUploadFileBytes;
    const many = Array.from({ length: 8 }, (_, index) => file(`f${index}.bin`, chunk));
    expect(validateUpload(many)).toEqual({ ok: false, reason: "upload-too-large" });

    const tooMany = Array.from({ length: REMOTE_LIMITS.maxUploadFiles + 1 }, (_, index) =>
      file(`f${index}.ts`, 1)
    );
    expect(validateUpload(tooMany)).toEqual({ ok: false, reason: "too-many-files" });
  });

  it("never returns a path that could escape a workspace root when joined", () => {
    // The property the sandbox service relies on when it does
    // `${ROOT}/${file.path}` without a second thought.
    const result = validateUpload([
      file("src/index.ts"),
      file("./deep/nested/file.txt"),
      file("weird name with spaces.md"),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const entry of result.files) {
      expect(entry.path.startsWith("/")).toBe(false);
      expect(entry.path.split("/")).not.toContain("..");
      expect(entry.path).not.toMatch(/^[A-Za-z]:/);
      expect(entry.path).not.toContain("\0");
      expect(entry.path).not.toContain("\\");
    }
  });
});
