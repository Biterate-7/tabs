import { describe, expect, it } from "vitest";
import { jsonWithCookies, readCookie, serializeCookie } from "./cookies";

function withCookieHeader(header: string): Request {
  return new Request("https://tabdump.example/api/auth/me", { headers: { cookie: header } });
}

describe("readCookie", () => {
  it("finds a cookie among several", () => {
    const request = withCookieHeader("a=1; tabdump_session=abc123; b=2");
    expect(readCookie(request, "tabdump_session")).toBe("abc123");
  });

  it("returns null when the cookie or the header is absent", () => {
    expect(readCookie(withCookieHeader("a=1"), "tabdump_session")).toBeNull();
    expect(readCookie(new Request("https://tabdump.example/"), "tabdump_session")).toBeNull();
  });

  it("does not match a cookie whose name merely ends with the one asked for", () => {
    // "not_tabdump_session" must not answer a request for
    // "tabdump_session" — a substring match here would let any other
    // cookie stand in for the session.
    const request = withCookieHeader("not_tabdump_session=evil");
    expect(readCookie(request, "tabdump_session")).toBeNull();
  });

  it("decodes percent-encoded values", () => {
    expect(readCookie(withCookieHeader("x=a%20b"), "x")).toBe("a b");
  });

  it("treats an undecodable value as absent rather than returning it raw", () => {
    expect(readCookie(withCookieHeader("x=%E0%A4%A"), "x")).toBeNull();
  });
});

describe("serializeCookie", () => {
  it("sets the security attributes a session cookie needs", () => {
    const cookie = serializeCookie("tabdump_session", "tok", {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 3600,
    });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("omits Secure when it isn't asked for, and never HttpOnly by accident", () => {
    const cookie = serializeCookie("x", "1", {});
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain("HttpOnly");
  });

  it("expresses deletion as both Max-Age=0 and a past Expires", () => {
    const cookie = serializeCookie("tabdump_session", "", { maxAge: 0 });
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("encodes the value so a token can never break out of the header", () => {
    expect(serializeCookie("x", "a; Domain=evil.example")).toContain("x=a%3B%20Domain%3Devil.example");
  });
});

describe("jsonWithCookies", () => {
  it("emits every cookie as its own Set-Cookie header", async () => {
    const response = jsonWithCookies({ ok: true }, { cookies: ["a=1; Path=/", "b=2; Path=/"] });
    // getSetCookie is what distinguishes two Set-Cookie headers from one
    // comma-joined string — a single joined header would set only one.
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("defaults to 200 and JSON, and honours an explicit status", () => {
    expect(jsonWithCookies({}).status).toBe(200);
    expect(jsonWithCookies({}).headers.get("content-type")).toBe("application/json");
    expect(jsonWithCookies({}, { status: 401 }).status).toBe(401);
  });

  it("forbids any intermediary from storing the response", () => {
    // A shared cache that held one browser's signed-in /api/auth/me and
    // replayed it to the next would be a cross-account identity leak.
    const cacheControl = jsonWithCookies({ user: "someone" }).headers.get("cache-control");
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).toContain("private");
  });
});
