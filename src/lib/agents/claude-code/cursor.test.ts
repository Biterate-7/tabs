import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, isValidSessionId, resolveReadStart } from "./cursor";

const SESSION = "b70abc10-f01a-48de-8d41-8ac936e8eff8";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("session id validation", () => {
  it("accepts a UUID", () => {
    expect(isValidSessionId(SESSION)).toBe(true);
  });

  it("refuses anything that could name a file", () => {
    const hostile = [
      "../../../etc/passwd",
      "..\\..\\windows\\system32",
      "C:\\Users\\someone\\.claude\\projects\\x.jsonl",
      "/etc/passwd",
      `${SESSION}/../../x`,
      `${SESSION}.jsonl`,
      "",
      null,
      undefined,
      42,
      {},
    ];

    for (const value of hostile) {
      expect(isValidSessionId(value)).toBe(false);
    }
  });
});

describe("cursor round trip", () => {
  it("survives encode and decode", () => {
    const entries = [
      { sessionId: SESSION, offset: 1234, size: 9999, taskOrdinal: 0 },
      { sessionId: OTHER, offset: 0, size: 0, taskOrdinal: 0 },
    ];

    expect(decodeCursor(encodeCursor(entries))).toEqual(entries);
  });

  it("carries no filesystem path in the encoded form", () => {
    const encoded = encodeCursor([{ sessionId: SESSION, offset: 10, size: 20, taskOrdinal: 0 }]);
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");

    expect(decoded).not.toContain("/");
    expect(decoded).not.toContain("\\");
    expect(decoded).not.toContain(".claude");
    expect(decoded).not.toContain("jsonl");
  });

  it("treats a missing or unusable cursor as 'start fresh'", () => {
    for (const value of ["", null, undefined, 42, {}, "not-base64!!", Buffer.from("{}").toString("base64url")]) {
      expect(decodeCursor(value)).toEqual([]);
    }
  });

  it("ignores a cursor from a different version wholesale", () => {
    const foreign = Buffer.from(JSON.stringify({ v: 99, e: [{ s: SESSION, o: 1, z: 2 }] })).toString(
      "base64url"
    );

    expect(decodeCursor(foreign)).toEqual([]);
  });
});

describe("hostile cursors", () => {
  function forge(entries: unknown[]): string {
    return Buffer.from(JSON.stringify({ v: 1, e: entries }), "utf8").toString("base64url");
  }

  it("drops an entry whose session id is not a UUID", () => {
    const forged = forge([
      { s: "../../../../etc/passwd", o: 0, z: 0 },
      { s: SESSION, o: 5, z: 10 },
    ]);

    expect(decodeCursor(forged)).toEqual([{ sessionId: SESSION, offset: 5, size: 10, taskOrdinal: 0 }]);
  });

  it("drops entries with impossible offsets or sizes", () => {
    const forged = forge([
      { s: SESSION, o: -1, z: 10 },
      { s: SESSION, o: Number.NaN, z: 10 },
      { s: SESSION, o: 1, z: -5 },
      { s: OTHER, o: 1, z: 2 },
    ]);

    expect(decodeCursor(forged)).toEqual([{ sessionId: OTHER, offset: 1, size: 2, taskOrdinal: 0 }]);
  });

  it("caps how many sessions a forged cursor can fan out to", () => {
    const many = Array.from({ length: 500 }, () => ({ s: SESSION, o: 0, z: 0 }));

    expect(decodeCursor(forge(many)).length).toBeLessThanOrEqual(64);
  });

  it("floors fractional offsets rather than seeking mid-byte", () => {
    expect(decodeCursor(forge([{ s: SESSION, o: 10.7, z: 20.9 }]))).toEqual([
      { sessionId: SESSION, offset: 10, size: 20, taskOrdinal: 0 },
    ]);
  });
});

describe("resolveReadStart", () => {
  const TAIL = 1000;

  it("starts near the end of a transcript seen for the first time", () => {
    expect(resolveReadStart(undefined, 50_000, TAIL)).toEqual({
      offset: 49_000,
      reset: false,
      firstSight: true,
    });
  });

  it("starts at zero for a small transcript seen for the first time", () => {
    expect(resolveReadStart(undefined, 200, TAIL)).toEqual({
      offset: 0,
      reset: false,
      firstSight: true,
    });
  });

  it("resumes at the stored offset when the file has grown", () => {
    const previous = { sessionId: SESSION, offset: 500, size: 500, taskOrdinal: 0 };

    expect(resolveReadStart(previous, 900, TAIL)).toEqual({
      offset: 500,
      reset: false,
      firstSight: false,
    });
  });

  it("resumes at the stored offset when nothing changed", () => {
    const previous = { sessionId: SESSION, offset: 500, size: 500, taskOrdinal: 0 };

    expect(resolveReadStart(previous, 500, TAIL).offset).toBe(500);
  });

  it("restarts from zero when the file shrank, which means it is a different file", () => {
    const previous = { sessionId: SESSION, offset: 5_000, size: 5_000, taskOrdinal: 0 };

    expect(resolveReadStart(previous, 120, TAIL)).toEqual({
      offset: 0,
      reset: true,
      firstSight: false,
    });
  });

  it("restarts from zero when the file was emptied", () => {
    const previous = { sessionId: SESSION, offset: 5_000, size: 5_000, taskOrdinal: 0 };

    expect(resolveReadStart(previous, 0, TAIL).reset).toBe(true);
  });
});
