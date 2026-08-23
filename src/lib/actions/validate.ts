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

export function requiredInteger(record: Record<string, unknown>, key: string): number | null {
  const v = record[key];
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : null;
}

export function requiredIntegerArray(record: Record<string, unknown>, key: string, max: number = Infinity): number[] | null {
  const v = record[key];
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
  const ints = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && Number.isInteger(x));
  return ints.length === v.length ? ints : null;
}

export function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const v = record[key];
  return typeof v === "boolean" ? v : undefined;
}
