/**
 * Names Hubble recognises as entities in a conversation — languages,
 * frameworks, tools, products and organisations — with the spellings people
 * actually use, so "Next.js", "nextjs" and "NextJS" resolve to one entity and
 * "Go" the verb never becomes Go the language.
 *
 * This is deliberately a list, not a model: every entity it finds can be
 * explained ("you wrote 'postgres'"), it runs on the device, and it never
 * invents a name. Things not on the list are still found — as recurring
 * capitalised phrases (`concept`) — but with lower confidence.
 */

export type EntityKind = "language" | "framework" | "tool" | "product" | "organization" | "concept" | "project" | "resource";

export type LexiconEntry = {
  /** The canonical id: lowercase, stable across spellings. */
  id: string;
  name: string;
  kind: EntityKind;
  /** Spellings that name it, matched case-insensitively on word boundaries. */
  aliases: readonly string[];
  /**
   * Aliases that are also ordinary English words ("go", "rust", "swift") count
   * only when written as a name (capitalised, or in code) — never "go to".
   */
  ambiguous?: readonly string[];
};

const L = (id: string, name: string, kind: EntityKind, aliases: string[], ambiguous?: string[]): LexiconEntry => ({
  id,
  name,
  kind,
  aliases,
  ...(ambiguous ? { ambiguous } : {}),
});

export const LEXICON: readonly LexiconEntry[] = [
  // Languages
  L("typescript", "TypeScript", "language", ["typescript", "ts"], ["ts"]),
  L("javascript", "JavaScript", "language", ["javascript", "js", "ecmascript"], ["js"]),
  L("python", "Python", "language", ["python", "python3", "py"], ["py"]),
  L("rust", "Rust", "language", ["rust", "rustlang"], ["rust"]),
  L("go", "Go", "language", ["golang", "go"], ["go"]),
  L("java", "Java", "language", ["java"]),
  L("kotlin", "Kotlin", "language", ["kotlin"]),
  L("swift", "Swift", "language", ["swift", "swiftui"], ["swift"]),
  L("csharp", "C#", "language", ["c#", "csharp", ".net", "dotnet"]),
  L("cpp", "C++", "language", ["c++", "cpp"]),
  L("ruby", "Ruby", "language", ["ruby"], ["ruby"]),
  L("php", "PHP", "language", ["php"]),
  L("sql", "SQL", "language", ["sql"]),
  L("r-lang", "R", "language", ["rstats", "rlang"]),
  L("haskell", "Haskell", "language", ["haskell"]),
  L("elixir", "Elixir", "language", ["elixir"], ["elixir"]),
  L("bash", "Bash", "language", ["bash", "shell script", "zsh", "powershell"]),
  L("html", "HTML", "language", ["html"]),
  L("css", "CSS", "language", ["css", "tailwind", "tailwindcss"]),
  L("latex", "LaTeX", "language", ["latex", "tex", "katex"]),
  // Frameworks and libraries
  L("react", "React", "framework", ["react", "reactjs", "react.js"], ["react"]),
  L("nextjs", "Next.js", "framework", ["next.js", "nextjs", "next js"]),
  L("vue", "Vue", "framework", ["vue", "vuejs", "vue.js", "nuxt"]),
  L("svelte", "Svelte", "framework", ["svelte", "sveltekit"]),
  L("angular", "Angular", "framework", ["angular"]),
  L("django", "Django", "framework", ["django"]),
  L("flask", "Flask", "framework", ["flask"], ["flask"]),
  L("fastapi", "FastAPI", "framework", ["fastapi"]),
  L("rails", "Ruby on Rails", "framework", ["rails", "ruby on rails"], ["rails"]),
  L("express", "Express", "framework", ["express.js", "expressjs"]),
  L("nodejs", "Node.js", "framework", ["node.js", "nodejs", "node"], ["node"]),
  L("tauri", "Tauri", "framework", ["tauri"]),
  L("electron", "Electron", "framework", ["electron"], ["electron"]),
  L("pytorch", "PyTorch", "framework", ["pytorch", "torch"], ["torch"]),
  L("tensorflow", "TensorFlow", "framework", ["tensorflow", "keras"]),
  L("pandas", "pandas", "framework", ["pandas"], ["pandas"]),
  L("numpy", "NumPy", "framework", ["numpy"]),
  L("d3", "D3", "framework", ["d3", "d3.js", "d3-force"]),
  L("webgl", "WebGL", "framework", ["webgl", "three.js", "threejs"]),
  L("vitest", "Vitest", "tool", ["vitest", "jest"]),
  L("playwright", "Playwright", "tool", ["playwright", "puppeteer"]),
  // Data and infrastructure
  L("postgres", "PostgreSQL", "tool", ["postgres", "postgresql", "psql", "pg"], ["pg"]),
  L("mysql", "MySQL", "tool", ["mysql", "mariadb"]),
  L("sqlite", "SQLite", "tool", ["sqlite", "sqlite3"]),
  L("mongodb", "MongoDB", "tool", ["mongodb", "mongo"]),
  L("redis", "Redis", "tool", ["redis"]),
  L("indexeddb", "IndexedDB", "tool", ["indexeddb", "idb"]),
  L("supabase", "Supabase", "product", ["supabase"]),
  L("firebase", "Firebase", "product", ["firebase", "firestore"]),
  L("neon", "Neon", "product", ["neon postgres", "neon db", "neondb"]),
  L("prisma", "Prisma", "tool", ["prisma"]),
  L("drizzle", "Drizzle", "tool", ["drizzle", "drizzle-orm"]),
  L("graphql", "GraphQL", "tool", ["graphql"]),
  L("docker", "Docker", "tool", ["docker", "dockerfile", "docker compose"]),
  L("kubernetes", "Kubernetes", "tool", ["kubernetes", "k8s", "kubectl"]),
  L("git", "Git", "tool", ["git", "github", "gitlab"]),
  L("vercel", "Vercel", "product", ["vercel"]),
  L("aws", "AWS", "product", ["aws", "amazon web services", "lambda", "s3"], ["lambda"]),
  L("gcp", "Google Cloud", "product", ["gcp", "google cloud"]),
  L("azure", "Azure", "product", ["azure"]),
  L("stripe", "Stripe", "product", ["stripe"]),
  L("oauth", "OAuth", "concept", ["oauth", "oauth2", "pkce", "oidc"]),
  L("mcp", "MCP", "concept", ["mcp", "model context protocol"]),
  L("embeddings", "Embeddings", "concept", ["embedding", "embeddings", "vector search", "pgvector"]),
  L("chrome-extension", "Chrome extension", "concept", ["chrome extension", "manifest v3", "chrome.storage"]),
  // AI products and organisations
  L("chatgpt", "ChatGPT", "product", ["chatgpt", "gpt-4", "gpt-4o", "gpt-5", "openai api"]),
  L("claude", "Claude", "product", ["claude", "claude code", "sonnet", "opus"], ["sonnet", "opus"]),
  L("gemini", "Gemini", "product", ["gemini", "bard"], ["gemini"]),
  L("perplexity", "Perplexity", "product", ["perplexity"]),
  L("grok", "Grok", "product", ["grok"]),
  L("openai", "OpenAI", "organization", ["openai"]),
  L("anthropic", "Anthropic", "organization", ["anthropic"]),
  L("google", "Google", "organization", ["google"]),
  L("microsoft", "Microsoft", "organization", ["microsoft"]),
  L("apple", "Apple", "organization", ["apple"], ["apple"]),
  L("meta", "Meta", "organization", ["meta"], ["meta"]),
  L("xai", "xAI", "organization", ["xai", "x.ai"]),
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One alias, as a pattern: word boundaries that also hold around "c++", "c#" and ".net". */
function aliasPattern(alias: string): string {
  const head = /^[a-z0-9]/i.test(alias) ? "(?<![A-Za-z0-9_])" : "(?<![A-Za-z0-9_.])";
  const tail = /[a-z0-9]$/i.test(alias) ? "(?![A-Za-z0-9_])" : "(?![A-Za-z0-9_+#])";
  return `${head}${escape(alias).replace(/\\? /g, "[\\s-]?")}${tail}`;
}

export type CompiledEntry = { entry: LexiconEntry; pattern: RegExp; ambiguous: ReadonlySet<string> };

let compiled: CompiledEntry[] | undefined;

export function compiledLexicon(): readonly CompiledEntry[] {
  if (!compiled) {
    compiled = LEXICON.map((entry) => ({
      entry,
      pattern: new RegExp(entry.aliases.map(aliasPattern).join("|"), "gi"),
      ambiguous: new Set((entry.ambiguous ?? []).map((alias) => alias.toLowerCase())),
    }));
  }
  return compiled;
}

/** A free-text name, folded so two spellings of one thing compare equal: "Auth-Service", "auth service" → "auth service". */
export function foldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}
