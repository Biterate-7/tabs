import type { AgentProviderId, ConnectorErrorCode, ConnectorStatusKind } from "./types";

/**
 * Structured, deliberately incurious connector logging.
 *
 * The thing worth being able to answer while debugging is "what did the
 * pipeline do" — a connector connected, an observation arrived, it was
 * ingested, it reached the workspace. The thing that must never be answerable
 * from a log is "what was in it". Transcripts, prompts, file contents, tokens
 * and URLs are all absent from every record below, and the way that is
 * guaranteed is the shape of `ConnectorLogRecord`: there is no free-text
 * field for a caller to put one in.
 *
 * Counts are the compromise that makes the log useful anyway. "12 observations
 * from claude-code" is exactly as diagnostic as listing them, and carries
 * nothing.
 *
 * Off by default. A local-first app that logged a user's agent activity to
 * their browser console by default would be leaving a trail of what they were
 * working on in a place they did not ask for it.
 */

export type ConnectorLogEvent =
  | "connector.connecting"
  | "connector.connected"
  | "connector.disconnected"
  | "connector.reconnecting"
  | "connector.error"
  | "connector.observations"
  | "connector.ingested";

/**
 * One log line.
 *
 * Every field is an enum, a provider id, or a number. The absence of a
 * message/payload/detail field is the design: there is nowhere to put
 * provider text, so none can arrive.
 */
export type ConnectorLogRecord = {
  event: ConnectorLogEvent;
  provider: AgentProviderId;
  /** Present on status transitions. */
  status?: ConnectorStatusKind;
  /** Present on errors. The code only — never the caught value. */
  error?: ConnectorErrorCode;
  /** How many observations this record is about. Never what they contained. */
  count?: number;
  /** Which attempt this is, for reconnection. */
  attempt?: number;
};

export type ConnectorLogSink = (record: ConnectorLogRecord) => void;

let sink: ConnectorLogSink | null = null;

/**
 * Installs a sink, or removes one with `null`.
 *
 * The only way anything is emitted. Tests install a collecting sink and
 * assert on the records; a developer can install a console sink in a dev
 * build. Production installs none, so the whole path is a null check.
 */
export function setConnectorLogSink(next: ConnectorLogSink | null): void {
  sink = next;
}

export function logConnectorEvent(record: ConnectorLogRecord): void {
  sink?.(record);
}
