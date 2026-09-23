// A minimal, real ACP agent process for the launch integration test.
//
// Speaks newline-delimited JSON-RPC 2.0 on stdio, exactly as Gemini CLI does
// with `--acp`. It reports back — as ordinary reply text — the facts the test
// needs to check about how it was started: its argv, its working directory
// and the *names* of the environment variables it received. It never touches
// the filesystem and never runs anything.

import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let sessionCwd = "";
let nextId = 5000;
const waiting = new Map();

function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } },
          authMethods: [{ id: "oauth-personal", name: "Sign in with Google" }],
        },
      });
    case "session/new":
      sessionCwd = params.cwd;
      return send({ id, result: { sessionId: "fake-acp-session" } });
    case "session/prompt": {
      const text = params.prompt[0].text;
      const sessionId = params.sessionId;
      if (text.endsWith("report")) {
        const facts = {
          argv: process.argv.slice(2),
          cwd: process.cwd(),
          sessionCwd,
          envKeys: Object.keys(process.env).sort(),
        };
        send({
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(facts) } },
          },
        });
        return send({ id, result: { stopReason: "end_turn" } });
      }
      if (text.endsWith("edit")) {
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-1",
              title: "WriteFile notes.md",
              kind: "edit",
              status: "pending",
              locations: [{ path: `${sessionCwd}/notes.md` }],
            },
          },
        });
        const answer = await ask("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "call-1", kind: "edit" },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        });
        const chose = answer.result?.outcome?.optionId ?? "cancelled";
        send({
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission:${chose}` } },
          },
        });
        return send({ id, result: { stopReason: "end_turn" } });
      }
      return send({ id, result: { stopReason: "end_turn" } });
    }
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found" } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method) void handle(message);
  else if (waiting.has(message.id)) {
    waiting.get(message.id)(message);
    waiting.delete(message.id);
  }
});
