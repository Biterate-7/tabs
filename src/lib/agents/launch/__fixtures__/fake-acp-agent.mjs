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
let mcpServers = [];
let nextId = 5000;
const waiting = new Map();

// Like Gemini CLI 0.61.0: `--allowed-mcp-server-names` limits which MCP
// servers the process will use; with it absent, every configured one.
const allowIndex = process.argv.indexOf("--allowed-mcp-server-names");
const allowedServers = allowIndex >= 0 ? [process.argv[allowIndex + 1]] : undefined;

/** One MCP tool call over Streamable HTTP, as an MCP client makes it: initialize, then call. */
async function callMcp(server, tool, args) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
  };
  const post = (body) => fetch(server.url, { method: "POST", headers, body: JSON.stringify(body) });
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-gemini", version: "0" } },
  });
  if (init.status !== 200) return `http:${init.status}`;
  const called = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  if (called.status !== 200) return `http:${called.status}`;
  const body = await called.json();
  return body.result?.content?.[0]?.text ?? JSON.stringify(body.error ?? null);
}

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
          agentCapabilities: { loadSession: false, mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } },
          authMethods: [{ id: "oauth-personal", name: "Sign in with Google" }],
        },
      });
    case "session/new":
      sessionCwd = params.cwd;
      mcpServers = params.mcpServers ?? [];
      // Modes as Gemini CLI reports them: it starts in the one that asks.
      return send({
        id,
        result: {
          sessionId: "fake-acp-session",
          modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "yolo" }] },
        },
      });
    case "session/close":
      return send({ id, result: {} });
    case "session/prompt": {
      const text = params.prompt[0].text;
      const sessionId = params.sessionId;
      if (text.endsWith("yolo")) {
        // An agent moving itself into approving its own actions.
        send({
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "yolo" } },
        });
        return new Promise(() => {});
      }
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
      const context = /context (\w+) (\{.*\})$/s.exec(text);
      if (context) {
        // An MCP tool call the way Gemini CLI 0.61.0 makes one in its default
        // mode: kind "other", a title naming the tool, no server identity, and
        // the option set only its MCP confirmations carry.
        const [, tool, rawArgs] = context;
        const server = mcpServers.find((entry) => !allowedServers || allowedServers.includes(entry.name));
        const say = (reply) =>
          send({
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } },
          });
        if (!server) {
          say("context:no-server");
          return send({ id, result: { stopReason: "end_turn" } });
        }
        const answer = await ask("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: `${tool}-1`, status: "pending", title: `${tool} (${server.name} MCP Server)`, kind: "other", content: [], locations: [] },
          options: [
            { optionId: "proceed_always_server", name: "Allow all server tools for this session", kind: "allow_always" },
            { optionId: "proceed_always_tool", name: "Allow tool for this session", kind: "allow_always" },
            { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
            { optionId: "cancel", name: "Reject", kind: "reject_once" },
          ],
        });
        const chose = answer.result?.outcome?.optionId ?? "cancelled";
        if (chose !== "proceed_once") {
          say(`context:${chose}`);
          return send({ id, result: { stopReason: "end_turn" } });
        }
        const result = await callMcp(server, tool, JSON.parse(rawArgs));
        send({
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: `${tool}-1`, status: "completed", kind: "other" } },
        });
        say(`context:${chose}:${result}`);
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
