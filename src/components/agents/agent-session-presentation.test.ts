import { describe, expect, it } from "vitest"
import { formatElapsed, formatTimeAgo } from "./agent-session-presentation"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe("elapsed time in words", () => {
  it("says a day, and days", () => {
    // Agent history shows activity from days ago; "1 days ago" is not English.
    expect(formatTimeAgo(0, DAY + HOUR)).toBe("1 day ago")
    expect(formatTimeAgo(0, 3 * DAY)).toBe("3 days ago")
  })

  it("keeps minutes and hours as they were", () => {
    expect(formatElapsed(30_000)).toBe("under a minute")
    expect(formatElapsed(5 * MIN)).toBe("5 min")
    expect(formatElapsed(2 * HOUR + 5 * MIN)).toBe("2 hr 5 min")
  })

  it("refuses a time in the future", () => {
    expect(formatTimeAgo(10, 0)).toBeNull()
  })
})
