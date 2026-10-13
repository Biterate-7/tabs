// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Structural guards for the AI integration layer: what the code *can*
 * reach, read as source, in the style of the MCP and control-plane guards.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, entry).replaceAll("\\", "/");
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !rel.includes("__fixtures__")) out.push(rel);
  }
  return out;
}

const LIB = walk("src/lib/integrations");
const ROUTES = [...walk("src/app/api/oauth"), ...walk("src/app/api/integrations"), ...walk("src/app/.well-known")];
const importsOf = (code: string) => [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

describe("the integration layer cannot execute, read files or reach a provider credential", () => {
  const FORBIDDEN = [/^node:child_process$/, /^child_process$/, /^node:fs/, /^fs$/, /^@\/lib\/agents\/control\//, /^@\/lib\/agents\/runtime\//, /^@\/lib\/agents\/credentials\//, /^@anthropic-ai\//, /^@vercel\/sandbox/];
  for (const file of [...LIB, ...ROUTES, "src/lib/mcp/integration-tools.ts"]) {
    it(`${file} imports nothing that executes or reads a credential`, () => {
      const code = codeOf(read(file));
      for (const specifier of importsOf(code)) for (const pattern of FORBIDDEN) expect(pattern.test(specifier), `${file} imports ${specifier}`).toBe(false);
      expect(code, file).not.toContain("process.env");
      expect(code, file).not.toMatch(/\beval\(|new Function\(/);
    });
  }
});

describe("the browser bundle never pulls in server-only integration code", () => {
  // Found live: a settings pane value-import of ./activity.ts dragged
  // node:crypto into the client bundle (webpack dev refused it; Turbopack's
  // production build did not complain). Only these modules are browser-safe.
  const CLIENT_SAFE = new Set(["scopes", "platforms", "setup", "activity-labels", "records"]);
  const CLIENT = ["src/components/settings/sections/ai-integrations-section.tsx", "src/components/integrations/oauth-consent.tsx", "src/hooks/use-integrations.ts"];
  for (const file of CLIENT) {
    it(`${file} value-imports only browser-safe integration modules`, () => {
      // One statement per match: from a line-leading `import` to its first `from "…"`.
      const statements = [...read(file).matchAll(/^import\b[\s\S]*?\bfrom\s+"([^"]+)"/gm)];
      const valueImports = statements
        .filter((m) => !/^import\s+type\b/.test(m[0]))
        .map((m) => /^@\/lib\/integrations\/([a-z-]+)$/.exec(m[1])?.[1])
        .filter((m): m is string => m !== undefined);
      expect(statements.length, file).toBeGreaterThan(3);
      for (const name of valueImports) expect(CLIENT_SAFE.has(name), `${file} imports ${name}`).toBe(true);
    });
  }
  it("the browser-safe modules import no Node built-in and nothing server-side", () => {
    for (const name of CLIENT_SAFE) {
      const code = codeOf(read(`src/lib/integrations/${name}.ts`));
      expect(code, name).not.toMatch(/from "node:|server-only/);
      for (const specifier of importsOf(code).filter((s) => s.startsWith("./"))) {
        expect(CLIENT_SAFE.has(specifier.slice(2)) || /^import type/m.test(code), `${name} imports ${specifier}`).toBe(true);
      }
    }
  });
});

describe("secrets are stored only as hashes", () => {
  const schema = read("src/lib/integrations/schema.sql");
  it("every secret column must be a SHA-256 hex digest", () => {
    expect(schema).toContain("token_hash     TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(schema).toContain("code_hash       TEXT PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$')");
    expect(schema).toContain("secret_hash IS NULL OR secret_hash ~ '^[0-9a-f]{64}$'");
    expect(schema).not.toMatch(/^\s+(token|secret|code|access_token|refresh_token|client_secret)\s+TEXT/m);
  });

  it("a grant always includes read, never more than write, and never zero workspaces", () => {
    expect(schema).toContain("'hubble.read' = ANY (scopes)");
    expect(schema).toContain("scopes <@ ARRAY['hubble.read', 'hubble.write']::TEXT[]");
    expect(schema).toContain("CHECK (cardinality(workspace_ids) BETWEEN 1 AND 50)");
  });

  it("the audit log has no column for content, queries or conversations", () => {
    const activity = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS hubble_integration_activity"), schema.indexOf("CREATE INDEX IF NOT EXISTS hubble_integration_activity_user_idx"));
    expect(activity).not.toMatch(/\b(query|prompt|content|body|transcript|message|token)\b\s+TEXT/i);
    expect(activity).toContain("char_length(detail) <= 160");
  });
});

describe("only the person, in Hubble, approves", () => {
  it("no MCP module can decide a proposal", () => {
    for (const file of readdirSync(path.join(ROOT, "src/lib/mcp")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const code = codeOf(read(`src/lib/mcp/${file}`));
      expect(code, file).not.toContain("decideProposal");
      expect(code, file).not.toContain("decideProposalAsUser");
      expect(code, file).not.toMatch(/getSession|readSessionToken|cookie/i);
    }
  });

  it("the routes that approve, revoke or change access authenticate with the session cookie, same-origin", () => {
    const shared = codeOf(read("src/lib/integrations/routes.ts"));
    expect(shared).toContain("getSession(request)");
    expect(shared).toContain("isSameOrigin(request)");
    expect(shared).toContain("hasJsonContentType(request)");
    for (const file of ["src/app/api/integrations/proposals/route.ts", "src/app/api/integrations/connections/route.ts", "src/app/api/integrations/context/route.ts", "src/app/api/integrations/test/route.ts"]) {
      expect(codeOf(read(file)), file).toContain("integrationContext(request, { mutating: true })");
    }
    const consent = codeOf(read("src/app/api/oauth/authorize/route.ts"));
    expect(consent).toContain("getSession(request)");
    expect(consent).toContain("hasJsonContentType(request)");
  });

  it("the connection test never makes a network request (regression: SSRF via forwarded host)", () => {
    // Its target was built from Host / X-Forwarded-Host, so a signed-in caller
    // on a deployment without a header-rewriting proxy could aim the server,
    // and the test credential, at any host. It now runs through the handler in-process.
    const code = codeOf(read("src/app/api/integrations/test/route.ts"));
    expect(code).toContain("handleMcpHttpRequest(new Request(input, init), deps)");
    expect(code).not.toMatch(/(^|[^.\w])fetch\(/m);
  });

  it("the OAuth endpoints an AI client calls read no cookie at all", () => {
    for (const file of ["src/app/api/oauth/register/route.ts", "src/app/api/oauth/token/route.ts", "src/app/api/oauth/revoke/route.ts"]) {
      expect(codeOf(read(file)), file).not.toMatch(/getSession|cookie/i);
    }
  });
});

describe("the desktop static export gains nothing", () => {
  const config = read("next.config.ts");
  it("the desktop build still resolves only .tsx pages", () => {
    expect(config).toContain('pageExtensions: ["tsx"]');
  });

  it("every new server surface is a route.ts or a .ts page, so the desktop export drops it", () => {
    for (const file of ROUTES) expect(file.endsWith("/route.ts"), file).toBe(true);
    expect(existsSync(path.join(ROOT, "src/app/oauth/authorize/page.ts"))).toBe(true);
    expect(existsSync(path.join(ROOT, "src/app/oauth/authorize/page.tsx"))).toBe(false);
  });

  it("the consent page cannot be framed", () => {
    expect(config).toContain('source: "/oauth/:path*"');
    expect(config).toContain("frame-ancestors 'none'");
  });
});
