import { describe, expect, it } from "vitest";
import { decodeAgentSessionAddress, encodeAgentSessionAddress } from "./address";

/**
 * The session address.
 *
 * Two concerns, and the second is the important one: it round-trips, and it
 * cannot be made to carry content. Every "refuses" test below is a value
 * that would put a title, a path or a delimiter into something a user is
 * invited to copy.
 */

describe("encode / decode", () => {
  it("round-trips a run", () => {
    const encoded = encodeAgentSessionAddress({ runId: "run-1" });
    expect(encoded).toBe("run:run-1");
    expect(decodeAgentSessionAddress(encoded as string)).toEqual({ runId: "run-1" });
  });

  it("round-trips a run with a selected work item", () => {
    const encoded = encodeAgentSessionAddress({ runId: "run-1", workItemId: "wi-2" });
    expect(encoded).toBe("run:run-1/item:wi-2");
    expect(decodeAgentSessionAddress(encoded as string)).toEqual({
      runId: "run-1",
      workItemId: "wi-2",
    });
  });

  it("round-trips a real uuid, which is what the domain actually mints", () => {
    const runId = "58d6fec1-1077-45b2-866a-758f3b2e4a90";
    const encoded = encodeAgentSessionAddress({ runId });
    expect(encoded).not.toBeNull();
    expect(decodeAgentSessionAddress(encoded as string)).toEqual({ runId });
  });
});

describe("an address can only contain ids", () => {
  /*
    Each of these is a value that would leak content if the encoder were
    permissive. They are refused at the encoder rather than escaped, because
    an address is built from ids and an id never looks like any of them.
  */
  it.each([
    ["a project path", "/Users/someone/projects/secret"],
    ["a windows path", "C:\\Users\\someone\\project"],
    ["an artifact id", "wa-w1::/projects/demo::src/a.ts"],
    ["a url", "https://example.com/page?q=1"],
    ["a title", "Fix the parser import handling"],
    ["a delimiter", "run-1/item:other"],
    ["an empty id", ""],
  ])("refuses %s as a run id", (_label, runId) => {
    expect(encodeAgentSessionAddress({ runId })).toBeNull();
  });

  it("refuses an unusable work item id rather than dropping it silently", () => {
    // Dropping it would produce a valid address for the wrong thing: the
    // run, with no task selected. Null says "not linkable" instead.
    expect(
      encodeAgentSessionAddress({ runId: "run-1", workItemId: "src/a.ts" })
    ).toBeNull();
  });

  it("caps length, so an id cannot become a payload", () => {
    expect(encodeAgentSessionAddress({ runId: "a".repeat(129) })).toBeNull();
    expect(encodeAgentSessionAddress({ runId: "a".repeat(128) })).not.toBeNull();
  });
});

describe("decoding is total", () => {
  it.each([
    ["empty", ""],
    ["no scheme", "run-1"],
    ["wrong scheme", "session:run-1"],
    ["a bare path", "/projects/demo/src/a.ts"],
    ["a url", "https://example.com"],
    ["an unknown tail", "run:run-1/artifact:wa-1"],
    ["a trailing slash", "run:run-1/"],
    ["a path in the tail", "run:run-1/item:../../etc"],
  ])("returns null for %s rather than guessing", (_label, value) => {
    expect(decodeAgentSessionAddress(value)).toBeNull();
  });

  it("never yields a filesystem path as a navigation target", () => {
    for (const attempt of [
      "run:../../../etc/passwd",
      "run:C:/Windows",
      "run:run-1/item:/etc/shadow",
    ]) {
      expect(decodeAgentSessionAddress(attempt)).toBeNull();
    }
  });
});
