import { describe, expect, it } from "vitest";
import { normalizeProjectPath, relativePathBasename, toProjectRelative } from "./paths";

const WIN = "C:\\repo\\project";
const POSIX = "/repo/project";

/** Convenience: the relative path, or the rejection reason. */
function rel(root: string, candidate: string): string {
  const result = toProjectRelative(root, candidate);
  return result.ok ? result.relativePath : `REJECTED:${result.reason}`;
}

describe("absolute paths inside the project", () => {
  it("makes a POSIX path relative", () => {
    expect(rel(POSIX, "/repo/project/src/foo.ts")).toBe("src/foo.ts");
  });

  it("makes a Windows path relative", () => {
    expect(rel(WIN, "C:\\repo\\project\\src\\foo.ts")).toBe("src/foo.ts");
  });

  it("handles a file at the project root", () => {
    expect(rel(WIN, "C:\\repo\\project\\package.json")).toBe("package.json");
    expect(rel(POSIX, "/repo/project/package.json")).toBe("package.json");
  });

  it("handles deep nesting", () => {
    expect(rel(POSIX, "/repo/project/src/lib/agents/claude-code/parser.ts")).toBe(
      "src/lib/agents/claude-code/parser.ts"
    );
  });

  it("accepts a root and candidate written with different separators", () => {
    expect(rel("C:/repo/project", "C:\\repo\\project\\src\\foo.ts")).toBe("src/foo.ts");
    expect(rel("C:\\repo\\project", "C:/repo/project/src/foo.ts")).toBe("src/foo.ts");
  });

  it("tolerates a trailing separator on the root", () => {
    expect(rel("C:\\repo\\project\\", "C:\\repo\\project\\src\\foo.ts")).toBe("src/foo.ts");
    expect(rel("/repo/project/", "/repo/project/src/foo.ts")).toBe("src/foo.ts");
  });
});

describe("relative paths", () => {
  it("passes a plain relative path through", () => {
    expect(rel(POSIX, "src/foo.ts")).toBe("src/foo.ts");
  });

  it("normalizes backslashes in a relative path", () => {
    expect(rel(POSIX, "src\\foo\\bar.ts")).toBe("src/foo/bar.ts");
  });

  it("strips a leading dot segment", () => {
    expect(rel(POSIX, "./src/foo.ts")).toBe("src/foo.ts");
    expect(rel(POSIX, ".\\src\\foo.ts")).toBe("src/foo.ts");
  });

  it("resolves interior dot segments", () => {
    expect(rel(POSIX, "src/./lib/foo.ts")).toBe("src/lib/foo.ts");
    expect(rel(POSIX, "src/lib/../foo.ts")).toBe("src/foo.ts");
    expect(rel(POSIX, "src/a/b/../../foo.ts")).toBe("src/foo.ts");
  });

  it("collapses duplicate separators", () => {
    expect(rel(POSIX, "src//lib///foo.ts")).toBe("src/lib/foo.ts");
    expect(rel(POSIX, "src\\\\lib\\foo.ts")).toBe("src/lib/foo.ts");
  });

  it("drops a trailing separator", () => {
    expect(rel(POSIX, "src/lib/")).toBe("src/lib");
  });
});

describe("traversal is refused", () => {
  it("rejects a relative path that climbs out of the project", () => {
    expect(rel(POSIX, "../../secret.txt")).toBe("REJECTED:escapes-root");
    expect(rel(POSIX, "../secret.txt")).toBe("REJECTED:escapes-root");
    expect(rel(WIN, "..\\..\\secret.txt")).toBe("REJECTED:escapes-root");
  });

  it("rejects a path that climbs out after descending", () => {
    expect(rel(POSIX, "src/../../secret.txt")).toBe("REJECTED:escapes-root");
  });

  it("rejects an absolute path whose remainder climbs out", () => {
    expect(rel(POSIX, "/repo/project/../secret.txt")).toBe("REJECTED:escapes-root");
    expect(rel(WIN, "C:\\repo\\project\\..\\secret.txt")).toBe("REJECTED:escapes-root");
  });

  it("allows a climb that stays inside the project", () => {
    expect(rel(POSIX, "/repo/project/src/../package.json")).toBe("package.json");
  });
});

describe("paths outside the project are refused", () => {
  it("rejects an absolute path under a different root", () => {
    expect(rel(WIN, "C:\\other-project\\secret.txt")).toBe("REJECTED:outside-project");
    expect(rel(POSIX, "/repo/other-project/secret.txt")).toBe("REJECTED:outside-project");
    expect(rel(POSIX, "/etc/passwd")).toBe("REJECTED:outside-project");
  });

  it("rejects a path on a different drive", () => {
    expect(rel(WIN, "D:\\repo\\project\\src\\foo.ts")).toBe("REJECTED:outside-project");
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    // The separator check: `project-other` must not read as inside `project`.
    expect(rel(WIN, "C:\\repo\\project-other\\foo.ts")).toBe("REJECTED:outside-project");
    expect(rel(POSIX, "/repo/project-other/foo.ts")).toBe("REJECTED:outside-project");
  });

  it("rejects a UNC path that is not the project", () => {
    expect(rel(WIN, "\\\\server\\share\\foo.ts")).toBe("REJECTED:outside-project");
  });

  it("rejects the project root itself, which names no file", () => {
    expect(rel(WIN, "C:\\repo\\project")).toBe("REJECTED:empty");
    expect(rel(POSIX, "/repo/project")).toBe("REJECTED:empty");
  });
});

describe("unsupported forms", () => {
  it("rejects a drive-relative path, whose meaning depends on invisible state", () => {
    // `C:foo` means "foo relative to the cwd on drive C", which is per-process.
    expect(rel(WIN, "C:foo.ts")).toBe("REJECTED:unsupported-form");
    expect(rel(WIN, "D:src\\foo.ts")).toBe("REJECTED:unsupported-form");
  });

  it("rejects a bare drive", () => {
    expect(rel(WIN, "C:")).toBe("REJECTED:unsupported-form");
    expect(rel(WIN, "C:\\")).toBe("REJECTED:unsupported-form");
  });

  it("rejects empty and whitespace input", () => {
    expect(rel(POSIX, "")).toBe("REJECTED:empty");
    expect(rel(POSIX, "   ")).toBe("REJECTED:empty");
    expect(rel("", "src/foo.ts")).toBe("REJECTED:empty");
  });

  it("rejects a path that resolves to nothing", () => {
    expect(rel(POSIX, ".")).toBe("REJECTED:empty");
    expect(rel(POSIX, "./")).toBe("REJECTED:empty");
  });
});

describe("case handling", () => {
  it("matches a Windows root case-insensitively, as the filesystem does", () => {
    expect(rel("C:\\Repo\\Project", "c:\\repo\\project\\src\\foo.ts")).toBe("src/foo.ts");
    expect(rel("c:/repo/project", "C:/REPO/PROJECT/src/foo.ts")).toBe("src/foo.ts");
  });

  it("matches a POSIX root exactly, because those are different directories", () => {
    expect(rel("/repo/Project", "/repo/project/src/foo.ts")).toBe("REJECTED:outside-project");
  });

  it("preserves the case of the file's own path", () => {
    expect(rel("C:\\repo\\project", "C:\\repo\\project\\src\\App.tsx")).toBe("src/App.tsx");
    expect(rel("C:\\REPO\\PROJECT", "C:\\repo\\project\\src\\MyComponent.tsx")).toBe(
      "src/MyComponent.tsx"
    );
  });
});

describe("normalizeProjectPath", () => {
  it("gives the same key for the same directory spelled differently", () => {
    expect(normalizeProjectPath("C:\\Repo\\Project")).toBe(normalizeProjectPath("c:/repo/project"));
    expect(normalizeProjectPath("/repo/project/")).toBe(normalizeProjectPath("/repo/project"));
  });

  it("keeps different directories apart", () => {
    expect(normalizeProjectPath("/repo/a")).not.toBe(normalizeProjectPath("/repo/b"));
    expect(normalizeProjectPath("/repo/project")).not.toBe(
      normalizeProjectPath("/repo/project-other")
    );
  });
});

describe("relativePathBasename", () => {
  it("takes the last segment", () => {
    expect(relativePathBasename("src/lib/foo.ts")).toBe("foo.ts");
    expect(relativePathBasename("package.json")).toBe("package.json");
  });
});
