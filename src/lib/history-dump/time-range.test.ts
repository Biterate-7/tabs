import { describe, expect, it } from "vitest";
import { resolveTimeRange } from "./time-range";

describe("resolveTimeRange", () => {
  const now = new Date(2026, 0, 31, 15, 30).getTime(); // Jan 31, 2026, 3:30pm

  it("resolves today to the start of the local calendar day through now", () => {
    const { startTime, endTime } = resolveTimeRange("today", now);
    const start = new Date(startTime);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(endTime).toBe(now);
  });

  it("resolves 3d/7d/30d as now minus N days, through now", () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(resolveTimeRange("3d", now)).toEqual({ startTime: now - 3 * DAY, endTime: now });
    expect(resolveTimeRange("7d", now)).toEqual({ startTime: now - 7 * DAY, endTime: now });
    expect(resolveTimeRange("30d", now)).toEqual({ startTime: now - 30 * DAY, endTime: now });
  });

  it("resolves custom to the given range", () => {
    expect(resolveTimeRange("custom", now, { startTime: 1000, endTime: 2000 })).toEqual({ startTime: 1000, endTime: 2000 });
  });

  it("falls back to a 7-day range when custom is missing or invalid", () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(resolveTimeRange("custom", now)).toEqual({ startTime: now - 7 * DAY, endTime: now });
    expect(resolveTimeRange("custom", now, { startTime: 2000, endTime: 1000 })).toEqual({ startTime: now - 7 * DAY, endTime: now });
  });
});
