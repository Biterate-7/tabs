/**
 * How every script that connects to a database picks that database.
 *
 * The target is never implied. These scripts do not read .env.local or .env:
 * a `vercel env pull` writes a real database there (for this project it has
 * been the production one), so the file a developer happens to have would
 * silently become the target. The connection string must be in the real
 * environment (POSTGRES_URL, else DATABASE_URL) — supply it on purpose, e.g.
 * with `node --env-file=<file>` — and --expect-host must name the database
 * host it points at: the endpoint label (`ep-…`, with or without `-pooler`)
 * or the full host name. A mismatch stops before connecting.
 *
 * Prints the variable NAME, the host and the database name. Never the
 * connection string, the user or the password.
 */

const CONNECTION_ENV_VARS = ["POSTGRES_URL", "DATABASE_URL"];

function connectionString() {
  for (const name of CONNECTION_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

/** `--expect-host=x` or `--expect-host x`. */
function expectedHost(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--expect-host=")) return argv[i].slice("--expect-host=".length).trim();
    if (argv[i] === "--expect-host") return (argv[i + 1] ?? "").trim();
  }
  return "";
}

/**
 * The parts of the target that are safe to print and to match on, taken from
 * the client pg will actually connect with: a `?host=` parameter or PGHOST can
 * make the driver dial a host other than the one the URL shows, so the URL
 * alone proves nothing. Null when the two disagree.
 */
function describeTarget(value, client) {
  const url = new URL(value);
  const urlHost = url.hostname.toLowerCase();
  const host = String(client.host ?? "").toLowerCase();
  if (!host || host !== urlHost) return null;
  const endpoint = host.split(".")[0].replace(/-pooler$/, "");
  // From the URL, not client.database: with no database in the URL, pg falls
  // back to the user name, which must not be printed.
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "(default)";
  return { host, endpoint, database };
}

function matchesTarget(target, expected) {
  const want = expected.toLowerCase().replace(/-pooler$/, "");
  return want === target.host || want === target.endpoint;
}

/**
 * The unconnected pg Client for the database this run was told to use, or
 * undefined once the reason it may not run has been printed (exit code 1).
 * `script` is the path shown in the usage hint.
 */
export async function resolveDatabaseTarget(script, argv = process.argv.slice(2)) {
  const connection = connectionString();
  if (!connection) {
    console.error(
      `No database configured. Set ${CONNECTION_ENV_VARS.join(" or ")} in the environment of this command ` +
        `(for example \`node --env-file=<file> ${script} --expect-host=<host>\`). ` +
        `.env.local and .env are not read: name the target explicitly.`
    );
    process.exitCode = 1;
    return undefined;
  }

  const { Client } = await import("pg");
  let client;
  let target;
  try {
    client = new Client({ connectionString: connection.value });
    target = describeTarget(connection.value, client);
  } catch {
    console.error(`${connection.name} is not a valid connection URL.`);
    process.exitCode = 1;
    return undefined;
  }
  if (!target) {
    console.error(
      `Refusing to run: the driver would not connect to the host in ${connection.name} ` +
        `(a host= parameter or PGHOST overrides it). Nothing was changed.`
    );
    process.exitCode = 1;
    return undefined;
  }

  const expected = expectedHost(argv);
  console.log(`Target (via ${connection.name}): host ${target.host}, database ${target.database}.`);
  if (!expected) {
    console.error(`Refusing to run without --expect-host. Pass the host above (or its ${target.endpoint} label) once you have confirmed it is the database you mean.`);
    process.exitCode = 1;
    return undefined;
  }
  if (!matchesTarget(target, expected)) {
    console.error(`Refusing to run: --expect-host is ${expected}, but ${connection.name} points at ${target.host}. Nothing was changed.`);
    process.exitCode = 1;
    return undefined;
  }
  return { client, target, variable: connection.name };
}

/** A driver message can quote the connection string; never print one. */
export function redactConnectionStrings(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(ql)?:\/\/\S+/gi, "<connection string>");
}
