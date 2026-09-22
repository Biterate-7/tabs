import {
  REMOTE_CONTROL_ROOT,
  REMOTE_EVENT_LOG,
  REMOTE_INBOX_DIR,
  REMOTE_LIMITS,
  REMOTE_WORKSPACE_ROOT,
} from "./types";

/**
 * The program that runs inside the sandbox.
 *
 * ## Why this is a string constant and not a file
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * A serverless bundle only contains files the tracer can see being imported.
 * A loose `.mjs` read from disk at runtime is exactly the shape that works
 * locally and is missing in production, and the failure mode — "the agent
 * starts and immediately exits" — would be diagnosed slowly.
 *
 * More importantly: **the bridge's source must be a constant, because the
 * bridge is the one thing this system executes.** As a string defined here,
 * with the interpolations below being three numbers and three paths that are
 * themselves constants, it is provable by inspection that nothing a user
 * supplies ever becomes code. Had it been a file assembled at runtime, that
 * property would depend on every future edit to the assembling code.
 * `security.test.ts` asserts the source contains no template hole other than
 * the ones below.
 *
 * ## The protocol it speaks
 *
 * One direction each, and neither is a network.
 *
 *   inbox   ← the control plane writes small JSON files
 *   log     → the bridge appends NDJSON, one event per line
 *
 * That choice is forced by the platform and turns out to be the right one
 * anyway: the sandbox SDK offers no stdin to a detached process, so there is
 * no stream to write into. A file-based channel needs no inbound network to
 * the microVM, no callback URL, and no credential inside the sandbox that
 * could reach back into this deployment — which is what lets the egress
 * policy be "Anthropic and nothing else".
 *
 * ## What it does not do
 *
 * It does not decide an approval. `canUseTool` writes a request and then
 * *blocks*, polling for a decision file, and denies on timeout. There is no
 * branch in which the sandbox grants itself a tool, and the fail-closed
 * direction is the only one it can fall into.
 */

/**
 * The bridge, as it will exist inside the microVM.
 *
 * Plain ESM against Node's standard library plus one SDK import. It is
 * written to run on the Node the sandbox image ships and is deliberately
 * unclever: no build step, no TypeScript, no dependencies beyond the agent
 * SDK, because anything else would be a second toolchain to keep working
 * inside a machine nobody can attach a debugger to.
 */
export const AGENT_BRIDGE_SOURCE = `
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

const CONTROL = ${JSON.stringify(REMOTE_CONTROL_ROOT)};
const INBOX = ${JSON.stringify(REMOTE_INBOX_DIR)};
const LOG = ${JSON.stringify(REMOTE_EVENT_LOG)};
const WORKSPACE = ${JSON.stringify(REMOTE_WORKSPACE_ROOT)};
const APPROVAL_TIMEOUT_MS = ${REMOTE_LIMITS.approvalTimeoutMs};
const POLL_MS = 250;

mkdirSync(INBOX, { recursive: true });

/**
 * Appends one event. Single process, single append, newline-terminated, so
 * the control plane's byte cursor can never land mid-record.
 */
function emit(event) {
  try {
    appendFileSync(LOG, JSON.stringify(event) + "\\n");
  } catch {
    // A log that cannot be written is not a reason to kill a running agent.
    // The control plane sees a stalled cursor and reports the session as
    // disconnected, which is the honest outcome.
  }
}

/** Reads and removes every inbox file, oldest first. */
function takeInbox() {
  let names;
  try {
    names = readdirSync(INBOX).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }

  const out = [];
  for (const name of names) {
    const file = INBOX + "/" + name;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      out.push(parsed);
    } catch {
      // A half-written file: the control plane is mid-write. Leave it and
      // pick it up next poll rather than deleting something unread.
      continue;
    }
    try {
      unlinkSync(file);
    } catch {
      // Already gone. Nothing to do.
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Decisions that have arrived but whose approval is still being awaited. */
const decisions = new Map();
/** Turns the user has sent that the SDK has not yet consumed. */
const pending = [];
let waiter = null;
let interrupted = false;
let closed = false;

function pump() {
  for (const item of takeInbox()) {
    if (!item || typeof item !== "object") continue;

    if (item.kind === "message" && typeof item.text === "string") {
      pending.push(item.text);
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve();
      }
      continue;
    }

    if (item.kind === "approval" && typeof item.id === "string") {
      decisions.set(item.id, item.decision === "granted");
      continue;
    }

    if (item.kind === "interrupt") {
      interrupted = true;
      continue;
    }

    if (item.kind === "close") {
      closed = true;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve();
      }
    }
  }
}

setInterval(pump, POLL_MS).unref?.();

/** The SDK's streaming input: one process, one conversation, many turns. */
async function* turns() {
  for (;;) {
    pump();
    if (pending.length > 0) {
      const text = pending.shift();
      yield {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: config.sessionId,
      };
      continue;
    }
    if (closed) return;
    await new Promise((resolve) => {
      waiter = resolve;
      setTimeout(() => {
        if (waiter === resolve) {
          waiter = null;
          resolve();
        }
      }, POLL_MS);
    });
  }
}

const config = JSON.parse(readFileSync(CONTROL + "/config.json", "utf8"));

/**
 * The permission callback.
 *
 * Writes the request, then waits for a decision file. It never defaults to
 * allow, and the timeout path denies — an approval nobody answered must not
 * become one nobody had to.
 */
async function canUseTool(toolName, input, meta) {
  const id = "ra-" + Math.random().toString(36).slice(2) + "-" + Date.now();

  emit({
    t: "permission",
    id,
    toolName,
    toolUseId: typeof meta?.toolUseID === "string" ? meta.toolUseID : "",
    requestId: typeof meta?.requestId === "string" ? meta.requestId : "",
    title: typeof meta?.title === "string" ? meta.title : undefined,
    displayName: typeof meta?.displayName === "string" ? meta.displayName : undefined,
    description: typeof meta?.description === "string" ? meta.description : undefined,
    decisionReason: typeof meta?.decisionReason === "string" ? meta.decisionReason : undefined,
    blockedPath: typeof meta?.blockedPath === "string" ? meta.blockedPath : undefined,
    input: input && typeof input === "object" ? input : {},
  });

  // Every exit from the wait below emits \`permission_resolved\` first, and
  // that line is load-bearing rather than informational. The control plane
  // does not advance its cursor past an *unresolved* permission, because a
  // serverless reader has no memory between requests and re-reading the
  // pending request is how it reconstructs an approval it must still be able
  // to answer. This line is the signal that it may move on.
  const settle = (granted, reason) => {
    emit({ t: "permission_resolved", id, granted, reason });
    return granted
      ? { behavior: "allow" }
      : { behavior: "deny", message: reason };
  };

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  for (;;) {
    pump();
    if (decisions.has(id)) {
      const granted = decisions.get(id);
      decisions.delete(id);
      return settle(granted, granted ? "Allowed." : "You denied this action.");
    }
    if (interrupted) {
      return settle(false, "The run was cancelled.");
    }
    if (Date.now() > deadline) {
      return settle(false, "No decision was made in time.");
    }
    await sleep(POLL_MS);
  }
}

async function main() {
  emit({ t: "ready" });

  const run = query({
    prompt: turns(),
    options: {
      cwd: WORKSPACE,
      permissionMode: config.permissionMode,
      allowedTools: config.allowedTools,
      disallowedTools: config.disallowedTools,
      // TabDump configures no MCP servers, and says so explicitly rather than
      // by omission: strictMcpConfig makes the runner ignore every server it
      // would otherwise inherit, so a session cannot silently gain tools
      // TabDump never authorized.
      mcpServers: {},
      strictMcpConfig: true,
      ...(config.resume ? { resume: config.resume } : {}),
      canUseTool,
    },
  });

  // Interrupt is polled rather than pushed, for the same reason everything
  // else here is: there is no channel into this process except the inbox.
  const interruptWatch = setInterval(() => {
    if (!interrupted) return;
    clearInterval(interruptWatch);
    Promise.resolve(run.interrupt?.()).catch(() => {});
  }, POLL_MS);

  try {
    for await (const message of run) {
      emit({ t: "message", payload: message });
    }
    emit({ t: "exit" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const lowered = detail.toLowerCase();
    // Classified here so the control plane never has to read provider text to
    // decide what happened. The raw string rides along as detail and is used
    // for diagnosis only; it is never rendered.
    const code =
      interrupted
        ? "cancelled"
        : lowered.includes("authentication") ||
          lowered.includes("unauthorized") ||
          lowered.includes("api key") ||
          lowered.includes("credit")
        ? "authentication"
        : lowered.includes("enoent") || lowered.includes("not found")
        ? "not-installed"
        : "process-failed";
    emit({ t: "exit", error: { code, detail } });
  } finally {
    clearInterval(interruptWatch);
  }
}

main().catch((error) => {
  emit({
    t: "exit",
    error: { code: "process-failed", detail: String(error && error.message ? error.message : error) },
  });
});
`;

/**
 * What the bridge is configured with.
 *
 * Derived server-side from the project and the grant, exactly as the local
 * adapter's start options are, and written into the sandbox as a file the
 * browser cannot address. Note what is absent: no `cwd` (it is a constant in
 * the bridge), no command, no flags, and no credential — the Anthropic key
 * travels in the process environment, not in a file that would survive a
 * snapshot.
 */
export type BridgeConfig = {
  sessionId: string;
  permissionMode: "default" | "dontAsk";
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  resume?: string;
};

/* ------------------------------------------------------------------ *
 * The log's line format
 * ------------------------------------------------------------------ */

/**
 * One line of the bridge's event log, after parsing.
 *
 * A closed union, parsed defensively: the bridge and the control plane are
 * deployed together, but a sandbox resumed from a snapshot can be running an
 * *older* bridge than the code reading it. A line this does not recognise is
 * dropped rather than guessed at.
 */
export type BridgeLine =
  | { t: "ready" }
  | { t: "message"; payload: Record<string, unknown> }
  | { t: "permission"; id: string; toolName: string; [key: string]: unknown }
  | { t: "permission_resolved"; id: string; granted: boolean; reason?: string }
  | { t: "exit"; error?: { code: string; detail?: string } };

export function parseBridgeLine(line: string): BridgeLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  switch (record.t) {
    case "ready":
      return { t: "ready" };

    case "message":
      return record.payload && typeof record.payload === "object"
        ? { t: "message", payload: record.payload as Record<string, unknown> }
        : null;

    case "permission":
      return typeof record.id === "string" && typeof record.toolName === "string"
        ? (record as BridgeLine)
        : null;

    case "permission_resolved":
      return typeof record.id === "string"
        ? {
            t: "permission_resolved",
            id: record.id,
            granted: record.granted === true,
            ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
          }
        : null;

    case "exit": {
      const error = record.error;
      if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
        const shaped = error as { code: string; detail?: unknown };
        return {
          t: "exit",
          error: {
            code: shaped.code,
            ...(typeof shaped.detail === "string" ? { detail: shaped.detail } : {}),
          },
        };
      }
      return { t: "exit" };
    }

    default:
      return null;
  }
}
