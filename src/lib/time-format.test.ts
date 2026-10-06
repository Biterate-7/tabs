import { describe, expect, it } from "vitest";
import {
  calendarDaysBetween,
  formatClockTime,
  formatCompactTime,
  formatDate,
  formatDayLabel,
  formatRelativeTime,
  formatTimestamp,
} from "./time-format";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 4 October 2026, 12:00 local — noon, so whole days back never straddle a midnight. */
const NOW = new Date(2026, 9, 4, 12, 0).getTime();

describe("relative time", () => {
  it("says now, minutes and hours the same way everywhere", () => {
    expect(formatRelativeTime(NOW, NOW)).toBe("Just now");
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe("Just now");
    expect(formatRelativeTime(NOW - MIN, NOW)).toBe("1 min ago");
    expect(formatRelativeTime(NOW - 5 * MIN, NOW)).toBe("5 min ago");
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe("1 hr ago");
    expect(formatRelativeTime(NOW - 3 * HOUR - 20 * MIN, NOW)).toBe("3 hr ago");
  });

  it("uses calendar days: yesterday, then days, then the date", () => {
    expect(formatRelativeTime(NOW - DAY, NOW)).toBe("Yesterday");
    expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toBe("2 days ago");
    expect(formatRelativeTime(NOW - 6 * DAY, NOW)).toBe("6 days ago");
    expect(formatRelativeTime(NOW - 30 * DAY, NOW)).toBe(formatDate(NOW - 30 * DAY, NOW));
  });

  it("never says '1 days ago' or any other unpluralised count", () => {
    for (let days = 0; days < 10; days++) {
      for (const offset of [0, 3 * HOUR, 11 * HOUR]) {
        const words = formatRelativeTime(NOW - days * DAY - offset, NOW) ?? "";
        expect(words).not.toMatch(/\b1 (days|hrs|mins)\b/);
        expect(words).not.toMatch(/\b([02-9]|\d{2,}) day ago\b/);
      }
    }
  });

  it("calls late last night 'Yesterday' only once it is a while ago", () => {
    const justAfterMidnight = new Date(2026, 9, 4, 0, 30).getTime();
    expect(formatRelativeTime(new Date(2026, 9, 3, 23, 50).getTime(), justAfterMidnight)).toBe("40 min ago");
    const early = new Date(2026, 9, 4, 4, 0).getTime();
    expect(formatRelativeTime(new Date(2026, 9, 3, 23, 50).getTime(), early)).toBe("4 hr ago");
    const morning = new Date(2026, 9, 4, 9, 0).getTime();
    expect(formatRelativeTime(new Date(2026, 9, 3, 23, 50).getTime(), morning)).toBe("Yesterday");
  });

  it("reads a little clock skew as just now, and a far-future record as the moment it claims", () => {
    expect(formatRelativeTime(NOW + 30_000, NOW)).toBe("Just now");
    expect(formatRelativeTime(NOW + 4 * MIN, NOW)).toBe("Just now");
    expect(formatRelativeTime(NOW + 2 * DAY, NOW)).toBe(formatTimestamp(NOW + 2 * DAY, NOW));
  });

  it("returns nothing for a timestamp that was never recorded — never 1 January 1970", () => {
    expect(formatRelativeTime(0, NOW)).toBeNull();
    expect(formatRelativeTime(undefined, NOW)).toBeNull();
    expect(formatRelativeTime(Number.NaN, NOW)).toBeNull();
    expect(formatTimestamp(0, NOW)).toBeNull();
    expect(formatCompactTime(0, NOW)).toBeNull();
  });
});

describe("compact time, for a list column", () => {
  it("is the same moment in fewer characters", () => {
    expect(formatCompactTime(NOW - 10_000, NOW)).toBe("now");
    expect(formatCompactTime(NOW - 5 * MIN, NOW)).toBe("5m");
    expect(formatCompactTime(NOW - 2 * HOUR, NOW)).toBe("2h");
    expect(formatCompactTime(NOW - 3 * DAY, NOW)).toBe("3d");
    expect(formatCompactTime(NOW - 30 * DAY, NOW)).toBe(formatDate(NOW - 30 * DAY, NOW));
    expect(formatCompactTime(NOW + MIN, NOW)).toBe("now");
  });
});

describe("day labels and fixed timestamps", () => {
  it("heads a day's rows with Today, Yesterday or the date", () => {
    expect(formatDayLabel(NOW - HOUR, NOW)).toBe("Today");
    expect(formatDayLabel(NOW - DAY, NOW)).toBe("Yesterday");
    expect(formatDayLabel(NOW - 3 * DAY, NOW)).not.toMatch(/Today|Yesterday/);
    // A future day is the clock's mistake, not tomorrow.
    expect(formatDayLabel(NOW + DAY, NOW)).toBe("Today");
  });

  it("puts the day before the clock", () => {
    expect(formatTimestamp(NOW - HOUR, NOW)).toBe(`Today ${formatClockTime(NOW - HOUR)}`);
    expect(formatTimestamp(NOW - DAY, NOW)).toBe(`Yesterday ${formatClockTime(NOW - DAY)}`);
  });

  it("adds the year only when it is not this year", () => {
    const lastYear = new Date(2025, 9, 4, 12, 0).getTime();
    expect(formatDate(lastYear, NOW)).toContain("2025");
    expect(formatDate(NOW - 30 * DAY, NOW)).not.toContain("2026");
  });

  it("counts calendar days", () => {
    expect(calendarDaysBetween(NOW, NOW)).toBe(0);
    expect(calendarDaysBetween(NOW - DAY, NOW)).toBe(1);
    expect(calendarDaysBetween(NOW + DAY, NOW)).toBe(-1);
  });
});
