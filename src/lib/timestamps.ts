/**
 * The one place TabDump reads the clock for persistent entity metadata.
 *
 * ## Why epoch milliseconds and not ISO-8601
 *
 * Every persistent entity that already carries timestamps — Workspace,
 * Group, Section, Collection, TabDependency — stores them as
 * `number` epoch-ms, and `src/lib/auth/store/schema.sql` states the reason
 * outright for the tables that already exist:
 *
 *   > Epoch milliseconds, matching how every other timestamp in this
 *   > codebase is represented (Workspace.createdAt, …). BIGINT rather than
 *   > TIMESTAMPTZ so there is no conversion layer to get wrong.
 *
 * Switching the client to ISO strings would mean changing four entity types,
 * re-typing every reducer that touches them, and adding a conversion layer
 * at exactly the server boundary the schema was designed to avoid one at.
 * It would also silently reject every export already in the wild:
 * `json-import.ts` validates imported timestamps with `typeof === "number"`
 * in seven places, so an ISO export would load with every timestamp reset to
 * "now".
 *
 * `exportedAt` in the export file header is ISO, and stays that way — it is
 * file metadata a human reads, not entity state anything compares.
 *
 * Sorting and comparison work identically either way, so nothing about the
 * later sync phase is made harder by this; the opposite, in fact.
 */

/**
 * Now, as epoch milliseconds.
 *
 * Call this ONCE per mutation and pass the value down, rather than calling
 * it per entity: a create must produce `createdAt === updatedAt`, and two
 * entities changed by the same user action should agree on when that was.
 */
export function createTimestamp(): number {
  return Date.now();
}

/**
 * Whether a value read back from storage or an import file is usable as a
 * timestamp.
 *
 * Deliberately narrow — finite number only. `NaN` and `Infinity` are
 * excluded because they survive `JSON.parse` as `null`/absent or arrive from
 * a hand-edited file, and either would poison every comparison they touch.
 * Negative values are allowed: they are pre-1970 dates, which are nonsense
 * here but harmless and not worth a second failure mode.
 */
export function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
