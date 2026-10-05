/**
 * How much a file changed, line by line (Hubble 1.6).
 *
 * Hubble measures an agent's change itself — from the copy it took before
 * approving the write and the file as the agent left it — so "+34 −12" is a
 * measurement, never the agent's claim. This is that measurement.
 *
 * Myers' algorithm on the lines between the common prefix and suffix, which is
 * where nearly every real edit is. Its memory is bounded by the number of
 * edits squared; past `MAX_EDITS` it stops and falls back to counting lines
 * that appear more or fewer times (`exact: false`), which still gives honest
 * totals for a file that was rewritten wholesale, just no hunks.
 */

export type DiffLine = { sign: " " | "+" | "-"; text: string };

export type DiffHunk = {
  /** 1-based first line in the old file, and in the new. */
  oldStart: number;
  newStart: number;
  lines: readonly DiffLine[];
};

export type LineDiff = {
  added: number;
  removed: number;
  /** False when the edit was too large to align and the totals were counted instead. */
  exact: boolean;
  /** Present when asked for and `exact`: the changed regions with context, bounded. */
  hunks?: readonly DiffHunk[];
  /** Hunks were cut to stay within `MAX_HUNK_LINES`. */
  truncated?: boolean;
};

export const MAX_EDITS = 1500;
export const MAX_HUNK_LINES = 400;
export const MAX_LINE_TEXT = 400;
const CONTEXT_LINES = 3;

/** Lines of a text file. A trailing newline does not make an extra empty line. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { kind: "=" | "-" | "+"; oldIndex: number; newIndex: number };

/**
 * The edit script between `a` and `b`, or `null` past `maxEdits`.
 *
 * `trace[d]` keeps only the diagonals `-(d+1)..d+1` that the backtrack can
 * read for step `d`, which is what bounds memory by edits rather than size.
 */
function myers(a: readonly string[], b: readonly string[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const row = trace[d]!;
    const at = (k: number) => row[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "=", oldIndex: x - 1, newIndex: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "+", oldIndex: x, newIndex: y - 1 });
      else ops.push({ kind: "-", oldIndex: x - 1, newIndex: y });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Totals when the edit is too large to align: lines that appear more, or fewer, times. */
function countedDiff(a: readonly string[], b: readonly string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of b) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}

function clip(text: string): string {
  return text.length > MAX_LINE_TEXT ? `${text.slice(0, MAX_LINE_TEXT - 1)}…` : text;
}

function hunksOf(ops: readonly Op[], a: readonly string[], b: readonly string[]): { hunks: DiffHunk[]; truncated: boolean } {
  const hunks: DiffHunk[] = [];
  let total = 0;
  let truncated = false;
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === "=") {
      index += 1;
      continue;
    }
    // A changed region, widened by context and merged with any change within reach of it.
    const start = Math.max(0, index - CONTEXT_LINES);
    let end = index;
    while (end < ops.length) {
      if (ops[end]!.kind !== "=") {
        end += 1;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run]!.kind === "=") run += 1;
      if (end + run >= ops.length || run > CONTEXT_LINES * 2) {
        end = Math.min(ops.length, end + CONTEXT_LINES);
        break;
      }
      end += run;
    }
    const slice = ops.slice(start, end);
    const first = slice[0]!;
    const lines: DiffLine[] = slice.map((op) =>
      op.kind === "=" ? { sign: " ", text: clip(a[op.oldIndex]!) } : op.kind === "-" ? { sign: "-", text: clip(a[op.oldIndex]!) } : { sign: "+", text: clip(b[op.newIndex]!) }
    );
    if (total + lines.length > MAX_HUNK_LINES) {
      truncated = true;
      break;
    }
    total += lines.length;
    hunks.push({ oldStart: first.oldIndex + 1, newStart: first.newIndex + 1, lines });
    index = end;
  }
  return { hunks, truncated };
}

/** The difference between two texts. Pass `hunks: true` for the changed regions as well as the totals. */
export function lineDiff(before: string, after: string, options: { hunks?: boolean } = {}): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);

  // The common prefix and suffix never need aligning.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);

  const middle = myers(middleA, middleB, MAX_EDITS);
  if (!middle) return { ...countedDiff(middleA, middleB), exact: false };

  let added = 0;
  let removed = 0;
  for (const op of middle) {
    if (op.kind === "+") added += 1;
    else if (op.kind === "-") removed += 1;
  }
  if (!options.hunks) return { added, removed, exact: true };

  // Re-based onto the whole file, so hunk line numbers and context are real.
  const ops: Op[] = [];
  for (let index = 0; index < prefix; index++) ops.push({ kind: "=", oldIndex: index, newIndex: index });
  for (const op of middle) ops.push({ kind: op.kind, oldIndex: op.oldIndex + prefix, newIndex: op.newIndex + prefix });
  for (let index = 0; index < suffix; index++) {
    ops.push({ kind: "=", oldIndex: a.length - suffix + index, newIndex: b.length - suffix + index });
  }
  const { hunks, truncated } = hunksOf(ops, a, b);
  return { added, removed, exact: true, hunks, ...(truncated ? { truncated } : {}) };
}
