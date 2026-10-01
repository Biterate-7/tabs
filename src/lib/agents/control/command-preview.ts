/**
 * The complete command a `run_command` approval is for.
 *
 * ## Why an approval now carries a command line
 *
 * An approval used to name a command only by its tool ("Bash"), and that was
 * enough for an agent whose approved command is described by the agent itself.
 * It is not enough for an agent Hubble drives whose approved command runs with
 * the user's own operating-system permissions and nothing narrower — a Codex
 * session on Windows (docs/codex-app-server.md). There the approval is the
 * whole boundary, so the person must see exactly what would run: the program,
 * every argument, every path, and where it runs.
 *
 * So this is the command **as the agent will run it**, not a summary of it and
 * not a name. It lives here, in its own module, because both the broker
 * (./approvals.ts) and the adapter-facing detail (./approval-details.ts) carry
 * it, and a provider adapter may import the one but never the other.
 *
 * ## Shown whole, or not asked at all
 *
 * A command longer than `MAX_COMMAND_LINE_LENGTH` is not truncated for
 * display: `readCommandPreview` refuses it, and an approval that cannot be
 * shown is denied (the service's rule for an approval it cannot describe).
 * Truncating would put "yes" to a command the person never saw the end of.
 *
 * Characters that would make the displayed text differ from the executed text
 * — control characters and bidirectional overrides — are replaced by a visible
 * `\u{…}` escape rather than removed, so nothing can hide inside the line.
 * Line breaks and tabs are kept: a multi-line script is shown as lines.
 */

/** Longest command line an approval will put in front of a person. */
export const MAX_COMMAND_LINE_LENGTH = 8_000;

/** Longest working directory shown. Longer is refused, like the command. */
export const MAX_WORKING_DIRECTORY_LENGTH = 1_024;

export type ApprovalCommandPreview = {
  /** The exact command line, program and arguments, as the agent will run it. */
  commandLine: string;
  /**
   * Where it runs. Project-relative (`.` for the project root) when it runs
   * inside the authorized project; the full path when it does not, because a
   * command running elsewhere is precisely the thing a person must notice.
   */
  workingDirectory: string;
  /** False when the command runs outside the authorized project. */
  insideProject: boolean;
  /** A network destination the agent said the command needs, when it said. */
  network?: { host: string; protocol: string };
};

// Every C0/C1 control except tab and line breaks, DEL, the zero-width
// characters, and the bidirectional embedding/override/isolate marks that
// reorder how text is displayed.
const HIDDEN_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Makes every hidden character visible. Line breaks become `\n`; tabs stay. */
export function visibleCommandText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(HIDDEN_CHARACTERS, (character) => `\\u{${character.codePointAt(0)?.toString(16) ?? "?"}}`);
}

function readShortText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = visibleCommandText(value).trim();
  if (!text || text.length > max) return undefined;
  return text;
}

/**
 * Reads a command preview strictly, or refuses it.
 *
 * Used where one is minted (the adapter) and wherever one crosses a boundary
 * (the broker, the client), so a malformed or oversized preview never reaches
 * a screen. Refusal is `undefined`; the caller then has no command to show and
 * must not ask.
 */
export function readCommandPreview(value: unknown): ApprovalCommandPreview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const commandLine = readShortText(raw.commandLine, MAX_COMMAND_LINE_LENGTH);
  const workingDirectory = readShortText(raw.workingDirectory, MAX_WORKING_DIRECTORY_LENGTH);
  if (!commandLine || !workingDirectory || typeof raw.insideProject !== "boolean") return undefined;

  const preview: ApprovalCommandPreview = { commandLine, workingDirectory, insideProject: raw.insideProject };

  if (raw.network !== undefined) {
    if (!raw.network || typeof raw.network !== "object") return undefined;
    const network = raw.network as Record<string, unknown>;
    const host = readShortText(network.host, 253);
    const protocol = readShortText(network.protocol, 16);
    if (!host || !protocol) return undefined;
    preview.network = { host, protocol };
  }

  return preview;
}
