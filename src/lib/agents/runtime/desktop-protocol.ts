import { runtimeFailure } from "./protocol";
import type { DesktopRuntime } from "./desktop";

/**
 * The line protocol between the Tauri shell and the desktop agent runtime.
 *
 * One JSON object per line in, one per line out, correlated by a numeric id
 * the shell assigns. The shell is the only writer — the pipe is the sidecar's
 * own stdin — but every line is still parsed as untrusted, because the
 * webview composes the request inside it.
 *
 * Kept apart from the entry so it can be tested without a process.
 */

/** The same cap the shell enforces before a line is written. */
export const MAX_DESKTOP_LINE_BYTES = 1024 * 1024;

export type DesktopReply = {
  /** The line to write to stdout, or `null` when there is nothing to answer. */
  out: string | null;
  /** The shell asked the runtime to end. */
  shutdown: boolean;
};

export async function handleDesktopLine(
  runtime: Pick<DesktopRuntime, "handle" | "dispose">,
  line: string
): Promise<DesktopReply> {
  if (!line.trim() || line.length > MAX_DESKTOP_LINE_BYTES) return { out: null, shutdown: false };

  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { out: null, shutdown: false };
  }
  if (!message || typeof message !== "object") return { out: null, shutdown: false };

  const record = message as Record<string, unknown>;
  const id = record.id;
  // Without an id there is nobody to answer; the shell never sends one.
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
    return { out: null, shutdown: false };
  }

  if (record.shutdown === true) {
    await runtime.dispose();
    return { out: JSON.stringify({ id, response: { ok: true, value: null } }), shutdown: true };
  }

  let response: unknown;
  try {
    response = await runtime.handle(record.request);
  } catch {
    // A thrown value is never forwarded: its text could carry a path or a
    // provider message. The shell and the webview get a code.
    response = runtimeFailure("provider_error");
  }
  return { out: JSON.stringify({ id, response }), shutdown: false };
}
