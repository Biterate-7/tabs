import type { PlatformSurfaceId } from "./platforms";

/**
 * The exact text a person pastes into an AI client, per product.
 *
 * Built from this deployment's origin — never a hard-coded or placeholder
 * host — and, for token modes, the token Hubble just minted. The token is
 * only ever passed in from the one response that carries it; this module
 * stores nothing.
 *
 * Each snippet follows the vendor's documented format (see the `docs` link
 * on its row in ./platforms.ts). OAuth products need only the URL: the
 * client discovers everything else from Hubble's metadata.
 */

export function mcpServerUrl(origin: string): string {
  return `${origin}/api/mcp`;
}

/** The read tools, for products that let a person allowlist tools (xAI's allowed_tools, Gemini CLI's includeTools). */
export const READ_TOOL_ALLOWLIST = [
  "get_connection_info",
  "list_workspaces",
  "get_workspace",
  "list_collections",
  "get_collection",
  "search_workspace",
  "get_resource",
  "get_tabs",
  "get_tab_graph",
  "get_project_context",
  "get_recent_activity",
] as const;

export type SetupSnippet = { label: string; language: "bash" | "json" | "python" | "text"; text: string; where: string };

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function setupSnippets(surface: PlatformSurfaceId, origin: string, token?: string): SetupSnippet[] {
  const url = mcpServerUrl(origin);
  const bearer = token ? `Bearer ${token}` : "Bearer <your Hubble token>";
  switch (surface) {
    case "chatgpt":
    case "claude-connector":
    case "gemini-app":
    case "grok-app":
      return [{ label: "MCP server URL", language: "text", text: url, where: "Paste this where the app asks for the server URL." }];
    case "claude-code":
      return [
        {
          label: "Claude Code",
          language: "bash",
          text: `claude mcp add --transport http hubble ${url} --header "Authorization: ${bearer}"`,
          where: "Run in a terminal. Add --scope user to use it in every project.",
        },
        {
          label: "Or an MCP config file (claude --mcp-config, or .mcp.json in a project)",
          language: "json",
          text: json({ mcpServers: { hubble: { type: "http", url, headers: { Authorization: bearer } } } }),
          where: "The form tested with Claude Code 2.1.229.",
        },
      ];
    case "claude-desktop-config":
      return [
        {
          label: "claude_desktop_config.json",
          language: "json",
          text: json({
            mcpServers: {
              hubble: {
                command: "node",
                args: ["<path to Hubble>/scripts/tabdump-mcp-bridge.mjs"],
                env: { TABDUMP_MCP_TOKEN: token ?? "<your Hubble token>", TABDUMP_MCP_URL: url },
              },
            },
          }),
          where: "Claude Desktop → Settings → Developer → Edit Config. Merge with any servers already there.",
        },
      ];
    case "gemini-cli":
      return [
        {
          label: "Gemini CLI",
          language: "bash",
          text: `gemini mcp add --transport http hubble ${url} --header "Authorization: ${bearer}"`,
          where: "Run in a terminal, then /mcp inside Gemini CLI to check.",
        },
        {
          label: "~/.gemini/settings.json",
          language: "json",
          text: json({ mcpServers: { hubble: { httpUrl: url, headers: { Authorization: bearer } } } }),
          where: "Or merge this into Gemini CLI's settings file.",
        },
      ];
    case "antigravity":
      return [
        {
          label: "mcp_config.json",
          language: "json",
          text: json({ mcpServers: { hubble: { serverUrl: url, headers: { Authorization: bearer } } } }),
          where: "Antigravity → MCP settings → edit the raw config. Antigravity reads serverUrl, not url.",
        },
      ];
    case "grok-cli":
      return [
        {
          label: "Grok CLI",
          language: "bash",
          text: `grok mcp add hubble ${url} -H "Authorization: ${bearer}"`,
          where: "Adds Hubble for every project (--scope project for one folder, which Grok must trust). Check it with grok mcp doctor.",
        },
      ];
    case "grok-api":
      return [
        {
          label: "xAI Responses API (Python)",
          language: "python",
          text: [
            "from openai import OpenAI",
            "",
            'client = OpenAI(api_key=XAI_API_KEY, base_url="https://api.x.ai/v1")',
            "response = client.responses.create(",
            '    model="grok-4.7",',
            '    input="What did I save for my Physics project?",',
            "    tools=[{",
            '        "type": "mcp",',
            `        "server_url": "${url}",`,
            '        "server_label": "hubble",',
            `        "authorization": "${token ?? "<your Hubble token>"}",`,
            `        "allowed_tools": ${JSON.stringify([...READ_TOOL_ALLOWLIST])},`,
            "    }],",
            ")",
          ].join("\n"),
          where: "allowed_tools keeps the model to Hubble's read tools; remove it only if your code should be able to save.",
        },
      ];
  }
}
