#!/usr/bin/env node
/**
 * Connects Claude Desktop to Hubble's MCP server.
 *
 * Claude Desktop's `claude_desktop_config.json` launches **local stdio** MCP
 * servers. Hubble's MCP server is **remote** (Streamable HTTP at
 * `/api/mcp`), because that is where a signed-in user's synced Hubble data
 * lives. This script is the join: it speaks stdio to Claude Desktop and
 * Streamable HTTP to Hubble, and relays JSON-RPC messages between them
 * unchanged.
 *
 * It is a relay and nothing else. It holds no tools, reads no files, runs no
 * commands, and has no logic that could widen what the server allows — every
 * decision stays on the server. Both transports are the official
 * `@modelcontextprotocol/sdk`'s own.
 *
 * ## Configuration (environment only)
 *
 *   TABDUMP_MCP_TOKEN  required. A token from Hubble → Settings → AI Agent
 *                      Connectors → Claude Desktop. Sent only as an
 *                      `Authorization: Bearer` header to TABDUMP_MCP_URL.
 *   TABDUMP_MCP_URL    optional. Defaults to https://tabsdump.vercel.app/api/mcp.
 *                      Must be https, except for localhost during development.
 *
 * The token is read from the environment rather than an argument so it never
 * appears in a process list. It is never printed: this script's stderr is
 * what Claude Desktop writes to its MCP log, and every message below is a
 * fixed sentence.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_URL = "https://tabsdump.vercel.app/api/mcp";
const TOKEN_PATTERN = /^tdmcp_[A-Za-z0-9_-]{43}$/;

function log(message) {
  process.stderr.write(`[tabdump-mcp] ${message}\n`);
}

function endpoint() {
  let url;
  try {
    url = new URL(process.env.TABDUMP_MCP_URL?.trim() || DEFAULT_URL);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  // A bearer token over plain http to anywhere but this machine would be sent
  // in the clear. Refused rather than warned about.
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  return url;
}

async function main() {
  const token = process.env.TABDUMP_MCP_TOKEN?.trim();
  if (!token || !TOKEN_PATTERN.test(token)) {
    log("TABDUMP_MCP_TOKEN is missing or is not a Hubble MCP token. Create one in Hubble → Settings → AI Agent Connectors.");
    process.exitCode = 1;
    return;
  }

  const url = endpoint();
  if (!url) {
    log("TABDUMP_MCP_URL must be an https URL (http is allowed only for localhost).");
    process.exitCode = 1;
    return;
  }

  const remote = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const local = new StdioServerTransport();

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    await Promise.allSettled([remote.close(), local.close()]);
  }

  local.onmessage = (message) => {
    remote.send(message).catch(() => {
      log(`Hubble did not accept a request (${message.method ?? "response"}). Check the token and the URL.`);
      // A request must get an answer, or Claude Desktop waits forever.
      if (message.id !== undefined && message.method !== undefined) {
        local
          .send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message: "Hubble refused the request or could not be reached. Check your Hubble MCP token.",
            },
          })
          .catch(() => {});
      }
    });
  };

  remote.onmessage = (message) => {
    local.send(message).catch(() => {});
  };

  remote.onerror = () => log("The connection to Hubble reported an error.");
  local.onclose = () => void shutdown();
  remote.onclose = () => void shutdown();

  await remote.start();
  await local.start();
  log(`Relaying to ${url.origin}${url.pathname}.`);
}

main().catch(() => {
  log("Could not start.");
  process.exitCode = 1;
});
