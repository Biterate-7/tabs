import type { ActivityRecord } from "./types"

/**
 * When things happened, as supporting evidence only. Two pages used in the
 * same work session, or a page used while a project was active, are more
 * likely to belong together than the same pages a month apart — but timing
 * never puts unrelated pages together: the engine multiplies a topic score
 * by this, and ignores it below a floor (scoring.ts).
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Local days a record was used on; a record from before days were kept counts its last sighting. */
export function activeDays(record: Pick<ActivityRecord, "days" | "lastSeenAt">): string[] {
  if (record.days.length > 0) return record.days
  const date = new Date(record.lastSeenAt)
  return [`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`]
}

/** 0..1: how much two pages' use overlaps in time. */
export function pairTemporal(a: ActivityRecord, b: ActivityRecord): number {
  const gap = Math.max(0, Math.max(a.firstSeenAt, b.firstSeenAt) - Math.min(a.lastSeenAt, b.lastSeenAt))
  const sharedDays = activeDays(a).filter((day) => activeDays(b).includes(day)).length
  if (gap <= 3 * HOUR) return 1
  if (sharedDays >= 2) return 1
  if (sharedDays === 1) return 0.7
  if (gap <= 3 * DAY) return 0.4
  return 0
}

/** 0..1: whether a page was used while the project itself was being worked on. */
export function projectTemporal(record: ActivityRecord, projectLastAt: number | undefined): number {
  if (!projectLastAt) return 0
  const gap = Math.abs(record.lastSeenAt - projectLastAt)
  if (gap <= 1 * DAY) return 1
  if (gap <= 7 * DAY) return 0.5
  return 0
}

/** Distinct days across a set of pages: "across 3 days" is something a person recognises. */
export function spanDays(records: readonly ActivityRecord[]): number {
  return new Set(records.flatMap((record) => activeDays(record))).size
}
