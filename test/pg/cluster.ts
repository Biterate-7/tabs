/**
 * A real PostgreSQL cluster for integration tests.
 *
 * This boots genuine PostgreSQL binaries (the `embedded-postgres` package
 * ships the official server for the host platform) as an ordinary user
 * process. It is NOT a simulation, a recording or an in-memory stand-in:
 * `initdb` runs, `postgres` listens on a TCP port, and the tests speak to it
 * through the same `pg` driver the application uses. That distinction is the
 * whole point — everything verified against this cluster is verified against
 * real Postgres semantics (transactions, row locks, deferred constraints,
 * composite foreign keys, serialization failures), which no fake can claim.
 *
 * Everything is ephemeral and local:
 *
 *  - the data directory is a fresh temp directory, discarded on stop
 *    (`persistent: false`), so no state survives a run;
 *  - the port is chosen from a free one at boot, so parallel runs and any
 *    Postgres the developer already runs cannot collide;
 *  - the superuser password is generated per run rather than hard-coded, so
 *    there is no credential in this repository to leak or to reuse.
 *
 * It never reads POSTGRES_URL/DATABASE_URL and so can never touch a real or
 * production database, even when one is configured in the environment.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Where the two schemas this project applies in production live. */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const AUTH_SCHEMA = path.join(REPO_ROOT, "src", "lib", "auth", "store", "schema.sql");
const SYNC_SCHEMA = path.join(REPO_ROOT, "src", "lib", "sync", "schema.sql");

/**
 * The database every test database is cloned from. Migrations run against it
 * once; `CREATE DATABASE ... TEMPLATE` then gives each test its own isolated
 * copy for the cost of a file copy rather than a fresh migration.
 */
const TEMPLATE_DATABASE = "tabdump_template";

export type ClusterHandle = {
  /** Connection string for the `postgres` maintenance database. */
  readonly adminUrl: string;
  /** Builds a connection string for a named database on this cluster. */
  urlFor(database: string): string;
  stop(): Promise<void>;
};

/** An OS-assigned free port, so a run never fights an existing server. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export async function readSchemaSql(): Promise<{ auth: string; sync: string }> {
  const [auth, sync] = await Promise.all([
    readFile(AUTH_SCHEMA, "utf8"),
    readFile(SYNC_SCHEMA, "utf8"),
  ]);
  return { auth, sync };
}

/**
 * Boots the cluster and prepares the template database.
 *
 * Throws if the platform has no usable binaries; the caller decides whether
 * that is fatal (it is not — see global-setup.ts, which degrades to skipping
 * the integration suite rather than failing the whole run).
 */
export async function startCluster(): Promise<ClusterHandle> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");

  const port = await freePort();
  const user = "postgres";
  const password = randomBytes(18).toString("hex");
  const databaseDir = mkdtempSync(path.join(tmpdir(), "tabdump-pgtest-"));

  const postgres = new EmbeddedPostgres({
    databaseDir,
    user,
    password,
    port,
    persistent: false,
    // initdb/postgres write a lot of routine chatter to stderr; the tests
    // report what matters themselves.
    onLog: () => {},
    onError: () => {},
  });

  await postgres.initialise();
  await postgres.start();

  const urlFor = (database: string) =>
    `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;

  const handle: ClusterHandle = {
    adminUrl: urlFor("postgres"),
    urlFor,
    async stop() {
      await postgres.stop();
    },
  };

  await createTemplateDatabase(handle);
  return handle;
}

/**
 * Creates the template database and applies both schemas to it, in the order
 * production requires: sync's workspaces table REFERENCES tabdump_users, so
 * auth must exist first.
 */
async function createTemplateDatabase(cluster: ClusterHandle): Promise<void> {
  const { Client } = await import("pg");
  const { auth, sync } = await readSchemaSql();

  const admin = new Client({ connectionString: cluster.adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
  } finally {
    await admin.end();
  }

  const template = new Client({ connectionString: cluster.urlFor(TEMPLATE_DATABASE) });
  await template.connect();
  try {
    await template.query(auth);
    await template.query(sync);
  } finally {
    // Nothing may hold a connection to a database used as a TEMPLATE.
    await template.end();
  }
}

/**
 * An isolated database for one test, cloned from the migrated template.
 *
 * Each caller gets its very own database rather than a shared one with
 * cleanup between tests. That is deliberate: the concurrency tests need two
 * genuinely independent connections racing on the same rows, and a
 * truncate-between-tests scheme makes those tests order-dependent.
 */
export async function createDatabaseFromTemplate(adminUrl: string, urlFor: (db: string) => string) {
  return createDatabase(adminUrl, urlFor, TEMPLATE_DATABASE);
}

/** An empty database with NO schema applied — what a real migration faces. */
export async function createEmptyDatabase(adminUrl: string, urlFor: (db: string) => string) {
  return createDatabase(adminUrl, urlFor, null);
}

async function createDatabase(
  adminUrl: string,
  urlFor: (db: string) => string,
  template: string | null
): Promise<{ name: string; url: string }> {
  const { Client } = await import("pg");
  // A fresh identifier per database. Generated from a UUID rather than a
  // counter so nothing depends on test ordering.
  const name = `t_${randomUUID().replace(/-/g, "")}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // The identifier is generated here from a UUID, never from test input,
    // and Postgres does not parameterize DDL identifiers. Asserting the
    // shape keeps it that way if someone later threads a name through.
    if (!/^t_[0-9a-f]{32}$/.test(name)) throw new Error("refusing to interpolate an unexpected database name");
    await admin.query(template ? `CREATE DATABASE ${name} TEMPLATE ${template}` : `CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  return { name, url: urlFor(name) };
}
