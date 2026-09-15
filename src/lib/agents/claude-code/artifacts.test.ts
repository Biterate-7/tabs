import { describe, expect, it } from "vitest";
import { ARTIFACT_OBSERVATION_ALLOWLIST, normalizeSession } from "./normalizer";
import { parseTranscriptLine } from "./parser";
import type { ClaudeDiscoveredSession, ClaudeParsedRecord } from "./types";

/**
 * Claude Code tool invocations becoming safe artifact observations.
 *
 * Fixtures mirror the live 2.1.270 input shapes (`Edit` with
 * `old_string`/`new_string`, `Write` with `content`, `Grep` with
 * `pattern`/`path`) and carry no real content.
 */

const T0 = Date.parse("2026-09-15T08:00:00.000Z");
const SESSION_ID = "b70abc10-f01a-48de-8d41-8ac936e8eff8";
const PROJECT = "C:\\Users\\someone\\project";

function session(projectPath = PROJECT): ClaudeDiscoveredSession {
  return { externalId: SESSION_ID, projectPath, lastObservedAt: T0, status: "working" };
}

function toolRecord(name: string, input: Record<string, unknown>, id = "toolu_1"): ClaudeParsedRecord {
  const line = JSON.stringify({
    type: "assistant",
    uuid: "u1",
    timestamp: new Date(T0).toISOString(),
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const parsed = parseTranscriptLine(line);
  if (!parsed) throw new Error("fixture failed to parse");
  return parsed;
}

/** All artifact observations produced for one tool invocation. */
function artifactsFor(name: string, input: Record<string, unknown>, projectPath = PROJECT) {
  const observations = normalizeSession({
    session: session(projectPath),
    records: [toolRecord(name, input)],
    now: T0,
  });
  return observations.flatMap((observation) => observation.artifacts ?? []);
}

describe("role mapping", () => {
  it("maps Read to inspected", () => {
    const artifacts = artifactsFor("Read", { file_path: `${PROJECT}\\src\\auth.ts` });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].role).toBe("inspected");
    expect(artifacts[0].relativePath).toBe("src/auth.ts");
  });

  it("maps Grep to inspected", () => {
    const artifacts = artifactsFor("Grep", {
      pattern: "needle",
      path: `${PROJECT}\\src\\lib`,
      output_mode: "content",
    });

    expect(artifacts[0].role).toBe("inspected");
    expect(artifacts[0].relativePath).toBe("src/lib");
  });

  it("maps Edit to edited", () => {
    const artifacts = artifactsFor("Edit", {
      file_path: `${PROJECT}\\src\\app.tsx`,
      old_string: "SECRET-BEFORE",
      new_string: "SECRET-AFTER",
      replace_all: false,
    });

    expect(artifacts[0].role).toBe("edited");
    expect(artifacts[0].relativePath).toBe("src/app.tsx");
  });

  it("maps Write to edited, which under-claims rather than inventing a creation", () => {
    // Claude Code's Write input says nothing about whether the file existed,
    // and this phase will not stat the filesystem to find out. "edited" is
    // true of both cases; "created" would be a false claim about history.
    const artifacts = artifactsFor("Write", {
      file_path: `${PROJECT}\\src\\new.ts`,
      content: "SECRET-BODY",
    });

    expect(artifacts[0].role).toBe("edited");
  });

  it("maps notebook tools", () => {
    expect(artifactsFor("NotebookEdit", { notebook_path: `${PROJECT}\\a.ipynb` })[0].role).toBe(
      "edited"
    );
    expect(artifactsFor("NotebookRead", { notebook_path: `${PROJECT}\\a.ipynb` })[0].role).toBe(
      "inspected"
    );
  });

  it("produces no artifact for an unknown tool, even one naming a path", () => {
    expect(artifactsFor("mcp__something__unheard_of", { file_path: `${PROJECT}\\a.ts` })).toEqual([]);
    expect(artifactsFor("SomeFutureTool", { path: `${PROJECT}\\a.ts` })).toEqual([]);
  });

  it("produces no artifact for a shell tool", () => {
    expect(artifactsFor("Bash", { command: "rm -rf /", description: "Clean up" })).toEqual([]);
    expect(artifactsFor("PowerShell", { command: "x", description: "y" })).toEqual([]);
  });
});

describe("path handling", () => {
  it("normalizes a Windows absolute path to project-relative", () => {
    const artifacts = artifactsFor("Edit", {
      file_path: "C:\\Users\\someone\\project\\src\\components\\sidebar.tsx",
    });

    expect(artifacts[0].relativePath).toBe("src/components/sidebar.tsx");
  });

  it("normalizes a POSIX absolute path to project-relative", () => {
    const artifacts = artifactsFor(
      "Edit",
      { file_path: "/repo/project/src/foo.ts" },
      "/repo/project"
    );

    expect(artifacts[0].relativePath).toBe("src/foo.ts");
  });

  it("accepts a path already relative to the project", () => {
    expect(artifactsFor("Edit", { file_path: "src/foo.ts" })[0].relativePath).toBe("src/foo.ts");
    expect(artifactsFor("Edit", { file_path: ".\\src\\foo.ts" })[0].relativePath).toBe("src/foo.ts");
  });

  it("handles a file at the project root", () => {
    expect(artifactsFor("Edit", { file_path: `${PROJECT}\\package.json` })[0].relativePath).toBe(
      "package.json"
    );
  });

  it("discards a path outside the project rather than exposing it", () => {
    const artifacts = artifactsFor("Read", { file_path: "C:\\Users\\someone\\.ssh\\id_rsa" });

    expect(artifacts).toEqual([]);
  });

  it("discards a traversal attempt", () => {
    expect(artifactsFor("Edit", { file_path: "../../secret.txt" })).toEqual([]);
    expect(artifactsFor("Edit", { file_path: `${PROJECT}\\..\\secret.txt` })).toEqual([]);
  });

  it("discards a malformed or drive-relative path", () => {
    expect(artifactsFor("Edit", { file_path: "C:relative.txt" })).toEqual([]);
    expect(artifactsFor("Edit", { file_path: "   " })).toEqual([]);
  });

  it("produces no artifact when the tool names no path", () => {
    expect(artifactsFor("Edit", { old_string: "a", new_string: "b" })).toEqual([]);
    expect(artifactsFor("Read", {})).toEqual([]);
  });
});

describe("multiple files", () => {
  it("produces one artifact per structurally named path", () => {
    const artifacts = artifactsFor("Grep", {
      pattern: "x",
      path: `${PROJECT}\\src\\lib`,
      file_path: `${PROJECT}\\src\\app.tsx`,
    });

    expect(artifacts.map((a) => a.relativePath).sort()).toEqual(["src/app.tsx", "src/lib"]);
    // One tool invocation, so one source id shared by both.
    expect(new Set(artifacts.map((a) => a.sourceId)).size).toBe(1);
  });

  it("collapses two spellings of the same file", () => {
    const artifacts = artifactsFor("Grep", {
      path: `${PROJECT}\\src\\foo.ts`,
      file_path: "src/foo.ts",
    });

    expect(artifacts).toHaveLength(1);
  });

  it("keeps the good paths when one of several is unsafe", () => {
    const artifacts = artifactsFor("Grep", {
      file_path: `${PROJECT}\\src\\ok.ts`,
      path: "..\\..\\secret.txt",
    });

    expect(artifacts.map((a) => a.relativePath)).toEqual(["src/ok.ts"]);
  });
});

describe("observation shape", () => {
  it("carries the tool's own id as the source id", () => {
    const artifacts = artifactsFor("Edit", { file_path: "src/foo.ts" });

    expect(artifacts[0].sourceId).toBe("toolu_1");
  });

  it("emits only allowlisted artifact fields", () => {
    const artifacts = artifactsFor("Edit", {
      file_path: "src/foo.ts",
      old_string: "SECRET",
      new_string: "SECRET",
    });

    for (const artifact of artifacts) {
      for (const key of Object.keys(artifact)) {
        expect(ARTIFACT_OBSERVATION_ALLOWLIST).toContain(key);
      }
    }
  });

  it("puts no absolute path in the relative field", () => {
    const artifacts = artifactsFor("Edit", { file_path: `${PROJECT}\\src\\foo.ts` });

    expect(artifacts[0].relativePath).not.toContain("C:");
    expect(artifacts[0].relativePath).not.toContain("\\");
    expect(artifacts[0].relativePath).not.toContain("Users");
  });

  it("still produces the safe activity summary alongside the artifact", () => {
    const observations = normalizeSession({
      session: session(),
      records: [toolRecord("Edit", { file_path: `${PROJECT}\\src\\sidebar.tsx` })],
      now: T0,
    });

    const activity = observations.find((o) => o.activity);
    expect(activity?.activity).toBe("Edited sidebar.tsx");
    expect(activity?.artifacts?.[0].relativePath).toBe("src/sidebar.tsx");
  });

  it("leaks no file contents into the artifact observation", () => {
    const observations = normalizeSession({
      session: session(),
      records: [
        toolRecord("Write", { file_path: `${PROJECT}\\.env`, content: "AWS_SECRET=SECRET-VALUE" }),
      ],
      now: T0,
    });

    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain("SECRET-VALUE");
    expect(serialized).not.toContain("AWS_SECRET");
    // The file itself is still recorded, by name only.
    expect(serialized).toContain(".env");
  });
});
