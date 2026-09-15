import { describe, expect, it } from "vitest";
import { basename, parseTranscriptLine, splitCompleteLines } from "./parser";

/**
 * Fixtures mirror the structures observed live on Claude Code 2.1.270, but
 * carry no real content: every prompt, command, file body and tool result is
 * invented and inert. The point of a fixture here is the shape.
 */

function assistantWithTools(tools: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-09-15T08:00:00.000Z",
    gitBranch: "main",
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    message: { content: tools },
    ...extra,
  });
}

describe("record parsing", () => {
  it("parses an assistant record and keeps only allowlisted fields", () => {
    const parsed = parseTranscriptLine(assistantWithTools([]));

    expect(parsed).toEqual({
      type: "assistant",
      uuid: "11111111-1111-4111-8111-111111111111",
      timestamp: Date.parse("2026-09-15T08:00:00.000Z"),
      gitBranch: "main",
      tools: [],
      tasks: [],
    });
    // sessionId and message are not carried forward.
    expect(parsed).not.toHaveProperty("sessionId");
    expect(parsed).not.toHaveProperty("message");
  });

  it("recognises every observed record type without extracting anything from them", () => {
    const observed = [
      "user",
      "system",
      "attachment",
      "bridge-session",
      "queue-operation",
      "last-prompt",
      "custom-title",
      "file-history-snapshot",
      "file-history-delta",
      "atis-latch",
    ];

    for (const type of observed) {
      const parsed = parseTranscriptLine(JSON.stringify({ type, uuid: "u", secret: "no" }));
      expect(parsed?.type).toBe(type);
      expect(parsed?.tools).toEqual([]);
      expect(parsed).not.toHaveProperty("secret");
    }
  });

  it("tolerates a record type it has never seen", () => {
    const parsed = parseTranscriptLine(JSON.stringify({ type: "some-future-record", uuid: "u" }));

    expect(parsed?.type).toBe("some-future-record");
    expect(parsed?.tools).toEqual([]);
  });

  it("returns null for blank lines, bad JSON, non-objects and typeless records", () => {
    for (const line of ["", "   ", "{not json", "[1,2,3]", '"a string"', "null", "{}"]) {
      expect(parseTranscriptLine(line)).toBeNull();
    }
  });

  it("accepts an epoch timestamp as well as ISO, and drops an unusable one", () => {
    expect(parseTranscriptLine(JSON.stringify({ type: "user", timestamp: 1_700_000 }))?.timestamp).toBe(
      1_700_000
    );
    expect(
      parseTranscriptLine(JSON.stringify({ type: "user", timestamp: "not a date" }))?.timestamp
    ).toBeUndefined();
    expect(
      parseTranscriptLine(JSON.stringify({ type: "user", timestamp: Number.NaN }))?.timestamp
    ).toBeUndefined();
  });
});

describe("tool extraction", () => {
  it("extracts id, name and basename from a file tool", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Edit",
          input: {
            file_path: "C:\\Users\\someone\\project\\src\\app-sidebar.tsx",
            old_string: "SECRET CONTENT",
            new_string: "MORE SECRET CONTENT",
            replace_all: false,
          },
        },
      ])
    );

    expect(parsed?.tools).toEqual([
      {
        id: "toolu_01",
        name: "Edit",
        fileName: "app-sidebar.tsx",
        // The raw path is kept for the normalizer to express relative to the
        // project root. It is consumed there and never reaches the browser.
        filePaths: ["C:\\Users\\someone\\project\\src\\app-sidebar.tsx"],
      },
    ]);
  });

  it("collects every structurally named path, not just the first", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        {
          type: "tool_use",
          id: "toolu_multi",
          name: "Grep",
          input: { pattern: "needle", path: "src/lib", file_path: "src/app/page.tsx" },
        },
      ])
    );

    expect(parsed?.tools[0].filePaths).toEqual(["src/app/page.tsx", "src/lib"]);
  });

  it("takes no path from a tool that structurally names none", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "x", description: "d" } },
      ])
    );

    expect(parsed?.tools[0].filePaths).toBeUndefined();
    expect(parsed?.tools[0].fileName).toBeUndefined();
  });

  it("never carries file contents out of an Edit or Write", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.ts", content: "SECRET" } },
      ])
    );

    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  it("takes a shell tool's description and never its command", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        {
          type: "tool_use",
          id: "toolu_02",
          name: "Bash",
          input: { command: "curl -H 'Authorization: Bearer sk-secret' https://x", description: "Fetch the thing" },
        },
      ])
    );

    expect(parsed?.tools[0]).toEqual({
      id: "toolu_02",
      name: "Bash",
      description: "Fetch the thing",
    });
    expect(JSON.stringify(parsed)).not.toContain("sk-secret");
    expect(JSON.stringify(parsed)).not.toContain("curl");
  });

  it("treats PowerShell the same way as Bash", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        {
          type: "tool_use",
          id: "t1",
          name: "PowerShell",
          input: { command: "Remove-Item -Recurse secret", description: "List files" },
        },
      ])
    );

    expect(parsed?.tools[0].description).toBe("List files");
    expect(JSON.stringify(parsed)).not.toContain("Remove-Item");
  });

  it("never extracts thinking or text blocks", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        { type: "thinking", thinking: "PRIVATE REASONING" },
        { type: "text", text: "VISIBLE PROSE" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.ts" } },
      ])
    );

    expect(parsed?.tools).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE REASONING");
    expect(JSON.stringify(parsed)).not.toContain("VISIBLE PROSE");
  });

  it("keeps an http(s) url for later exact-match linking", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        {
          type: "tool_use",
          id: "t1",
          name: "mcp__Claude_Browser__navigate",
          input: { url: "https://example.com/docs", tabId: "x" },
        },
      ])
    );

    expect(parsed?.tools[0].url).toBe("https://example.com/docs");
  });

  it("refuses a non-http url scheme", () => {
    for (const url of ["file:///etc/passwd", "data:text/html,x", "javascript:alert(1)", "nonsense"]) {
      const parsed = parseTranscriptLine(
        assistantWithTools([{ type: "tool_use", id: "t1", name: "x", input: { url } }])
      );
      expect(parsed?.tools[0].url).toBeUndefined();
    }
  });

  it("keeps an unknown tool's name but nothing from its input", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        {
          type: "tool_use",
          id: "t1",
          name: "mcp__something__unheard_of",
          input: { apiKey: "SECRET", payload: "SECRET" },
        },
      ])
    );

    expect(parsed?.tools[0]).toEqual({ id: "t1", name: "mcp__something__unheard_of" });
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  it("skips tool blocks with no id or no name", () => {
    const parsed = parseTranscriptLine(
      assistantWithTools([
        { type: "tool_use", name: "Edit", input: {} },
        { type: "tool_use", id: "t1", input: {} },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "ok.ts" } },
      ])
    );

    expect(parsed?.tools.map((t) => t.id)).toEqual(["t2"]);
  });

  it("ignores a message with no content array", () => {
    expect(parseTranscriptLine(JSON.stringify({ type: "assistant", message: {} }))?.tools).toEqual([]);
    expect(parseTranscriptLine(JSON.stringify({ type: "assistant" }))?.tools).toEqual([]);
  });
});

describe("basename", () => {
  it("takes the last segment of either separator", () => {
    expect(basename("C:\\a\\b\\c.tsx")).toBe("c.tsx");
    expect(basename("/a/b/c.tsx")).toBe("c.tsx");
    expect(basename("c.tsx")).toBe("c.tsx");
    expect(basename("/a/b/")).toBe("b");
  });
});

describe("splitCompleteLines", () => {
  it("returns only lines terminated by a newline", () => {
    const { lines, consumed } = splitCompleteLines('{"a":1}\n{"b":2}\n{"partial"');

    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(consumed).toBe('{"a":1}\n{"b":2}\n'.length);
  });

  it("consumes nothing when no line is complete", () => {
    expect(splitCompleteLines('{"partial"')).toEqual({ lines: [], consumed: 0 });
  });

  it("handles an empty chunk", () => {
    expect(splitCompleteLines("")).toEqual({ lines: [], consumed: 0 });
  });
});
