/** Small hand-rolled argument validators — mirrors the isContextArray/isHistoryArray style already used in the ask route, kept dependency-free (no zod in this project). */

export function asRecord(args: unknown): Record<string, unknown> | null {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
}

export function requiredString(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function requiredStringArray(record: Record<string, unknown>, key: string): string[] | null {
  const v = record[key];
  if (!Array.isArray(v) || v.length === 0) return null;
  const strings = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return strings.length === v.length ? strings : null;
}

export function optionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const v = record[key];
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : undefined;
}
