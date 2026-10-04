import { describe, expect, it } from "vitest"
import { formatElapsed, formatTimeAgo } from "./agent-session-presentation"
import { formatRelativeTime } from "@/lib/time-format"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Noon, so whole days back never cross a midnight by accident. */
const NOW = new Date(2026, 9, 4, 12, 0).getTime()

describe("elapsed time in words", () => {
  it("says a day, and days", () => {
    // Agent history shows activity from days ago; "1 days ago" is not English.
    expect(formatTimeAgo(NOW - DAY - HOUR, NOW)).toBe("Yesterday")
    expect(formatTimeAgo(NOW - 3 * DAY, NOW)).toBe("3 days ago")
    expect(formatTimeAgo(NOW - 3 * DAY, NOW)).not.toMatch(/\b1 days\b/)
  })

  it("is the canonical relative time, not a second convention", () => {
    for (const at of [NOW - 30_000, NOW - 5 * MIN, NOW - 2 * HOUR, NOW - DAY, NOW - 3 * DAY, NOW - 30 * DAY]) {
      expect(formatTimeAgo(at, NOW)).toBe(formatRelativeTime(at, NOW))
    }
  })

  it("keeps durations in the coarsest useful unit, without a trailing zero", () => {
    expect(formatElapsed(30_000)).toBe("under a minute")
    expect(formatElapsed(5 * MIN)).toBe("5 min")
    expect(formatElapsed(2 * HOUR + 5 * MIN)).toBe("2 hr 5 min")
    expect(formatElapsed(2 * HOUR)).toBe("2 hr")
    expect(formatElapsed(DAY)).toBe("1 day")
  })

  it("reads a record a little ahead of the clock as just now, never as a blank", () => {
    expect(formatTimeAgo(NOW + 10_000, NOW)).toBe("Just now")
  })
})
