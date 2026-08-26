import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, checkAiRateLimit, __clearRateLimitsForTests } from "./rate-limit";

function requestFrom(ip: string | null): Request {
  return new Request("https://tabdump.example/api/ai/embed", ip ? { headers: { "x-forwarded-for": ip } } : {});
}

afterEach(() => {
  __clearRateLimitsForTests();
  vi.useRealTimers();
});

describe("checkRateLimit", () => {
  it("allows requests under the limit", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("ip-a", { limit: 5, windowMs: 60_000 }).allowed).toBe(true);
    }
  });

  it("blocks a request once the limit is reached within the window", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("ip-b", { limit: 3, windowMs: 60_000 });
    const result = checkRateLimit("ip-b", { limit: 3, windowMs: 60_000 });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks separate keys independently — one user's limit doesn't affect another's", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("ip-c", { limit: 3, windowMs: 60_000 });
    expect(checkRateLimit("ip-c", { limit: 3, windowMs: 60_000 }).allowed).toBe(false);
    expect(checkRateLimit("ip-d", { limit: 3, windowMs: 60_000 }).allowed).toBe(true);
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 2; i++) checkRateLimit("ip-e", { limit: 2, windowMs: 1000 });
    expect(checkRateLimit("ip-e", { limit: 2, windowMs: 1000 }).allowed).toBe(false);

    vi.advanceTimersByTime(1001);

    expect(checkRateLimit("ip-e", { limit: 2, windowMs: 1000 }).allowed).toBe(true);
  });
});

describe("checkAiRateLimit", () => {
  it("rate-limits a request with a real client IP normally", () => {
    for (let i = 0; i < 3; i++) {
      expect(checkAiRateLimit(requestFrom("203.0.113.1"), "embed", { limit: 3, windowMs: 60_000 }).allowed).toBe(true);
    }
    expect(checkAiRateLimit(requestFrom("203.0.113.1"), "embed", { limit: 3, windowMs: 60_000 }).allowed).toBe(false);
  });

  it("does not let a request from one IP affect a different IP's limit", () => {
    for (let i = 0; i < 3; i++) checkAiRateLimit(requestFrom("203.0.113.2"), "embed", { limit: 3, windowMs: 60_000 });
    expect(checkAiRateLimit(requestFrom("203.0.113.2"), "embed", { limit: 3, windowMs: 60_000 }).allowed).toBe(false);
    expect(checkAiRateLimit(requestFrom("203.0.113.3"), "embed", { limit: 3, windowMs: 60_000 }).allowed).toBe(true);
  });

  /**
   * Local dev (no reverse proxy in front) and any production deployment
   * without one both resolve to the same "unknown" client IP — rate
   * limiting that case would either lock out a developer's own testing, or
   * silently pool every real visitor of a proxy-less deployment into one
   * shared bucket (the opposite of "one user can't burn the whole quota").
   * Both are worse than skipping the limit for that specific case.
   */
  it("never blocks a request with no identifiable client IP, however many are made", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 100; i++) {
      expect(checkAiRateLimit(requestFrom(null), "embed", { limit: 3, windowMs: 60_000 }).allowed).toBe(true);
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps distinct buckets per keyPrefix so the embed and ask limits don't share quota", () => {
    for (let i = 0; i < 3; i++) checkAiRateLimit(requestFrom("203.0.113.4"), "embed", { limit: 3, windowMs: 60_000 });
    expect(checkAiRateLimit(requestFrom("203.0.113.4"), "embed", { limit: 3, windowMs: 60_000 }).allowed).toBe(false);
    expect(checkAiRateLimit(requestFrom("203.0.113.4"), "ask", { limit: 3, windowMs: 60_000 }).allowed).toBe(true);
  });
});
