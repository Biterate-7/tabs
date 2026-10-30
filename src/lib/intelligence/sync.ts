import { upsertRecords } from "./records"
import type { ActivityPull } from "./bridge"
import type { ContextState } from "./types"

/**
 * One pull from the extension, folded into the stored state. Pure, and safe
 * to repeat: the same pull applied twice changes nothing the second time, so
 * a retry after a lost answer, or two Hubble tabs pulling at once, never
 * duplicates a page.
 *
 *   same epoch  records that changed are merged, records the extension
 *               removed (retention, an exclusion, "forget") go
 *   new epoch   the extension's activity was cleared or reinstalled: the
 *               stored pages are replaced by what it has now. The person's
 *               decisions (associations, rejections) and the suggestions'
 *               history are kept; pages they name that are gone simply no
 *               longer appear.
 *
 * Whether each page is open in Chrome now comes from the pull's own list of
 * open tabs, so a page closed since the last pull stops counting as open.
 */
export function applyPull(state: ContextState, pull: ActivityPull): ContextState {
  const sameEpoch = state.cursor?.epoch === pull.epoch && !pull.reset
  const removed = new Set(sameEpoch ? pull.removed : [])
  const base = sameEpoch ? state.records.filter((record) => !removed.has(record.key)) : []
  const merged = upsertRecords(base, pull.records)
  const open = new Set(pull.openKeys)
  let changed = merged !== state.records || !sameEpoch || removed.size > 0
  const records = merged.map((record) => {
    const isOpen = open.has(record.key)
    if (record.open === isOpen) return record
    changed = true
    return { ...record, open: isOpen }
  })
  const cursorChanged = state.cursor?.epoch !== pull.epoch || state.cursor?.seq !== pull.seq
  if (!changed && !cursorChanged) return state
  return { ...state, records: changed ? records : state.records, cursor: { epoch: pull.epoch, seq: pull.seq } }
}

/** Everything detection kept goes; the person's projects are not touched (they are not in this state). */
export function clearContext(state: ContextState): ContextState {
  return {
    ...state,
    records: [],
    associations: [],
    rejections: [],
    suggestions: [],
    checkpoints: [],
    resume: {},
    cursor: undefined,
  }
}
