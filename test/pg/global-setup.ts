/**
 * Vitest globalSetup: boots one real PostgreSQL cluster for the whole run.
 *
 * `initdb` costs a few seconds, so it happens once here rather than per test
 * file, and every integration test clones its own database from the migrated
 * template (see cluster.ts).
 *
 * ## Failing soft is the point
 *
 * A machine without usable PostgreSQL binaries must still get a normal test
 * run. So a boot failure is NOT rethrown: it is recorded, provided to the
 * tests as a reason, and the integration suites skip themselves with that
 * reason printed. The alternative — letting globalSetup throw — would take
 * the entire 2700-test suite down on a platform that simply cannot host a
 * database, which is a far worse outcome than an honestly skipped suite.
 *
 * The corollary matters just as much: when the cluster DOES boot, the tests
 * run against real Postgres and a failure there is a real failure. Nothing
 * here silently substitutes a fake.
 */

import type { TestProject } from "vitest/node";
import { startCluster, type ClusterHandle } from "./cluster";

let cluster: ClusterHandle | null = null;

export default async function setup(project: TestProject) {
  try {
    // An explicit opt-out, for a machine or a CI job that does not want to
    // spend the seconds `initdb` costs. It takes the same path a boot
    // failure does, which is also how that path stays exercised rather than
    // being a branch nobody ever runs.
    if (process.env.TABDUMP_SKIP_PG_TESTS === "1") {
      throw new Error("skipped by TABDUMP_SKIP_PG_TESTS=1");
    }
    cluster = await startCluster();
    project.provide("pgAdminUrl", cluster.adminUrl);
    project.provide("pgUrlTemplate", cluster.urlFor("{db}"));
    project.provide("pgUnavailableReason", null);
  } catch (error) {
    cluster = null;
    const reason = error instanceof Error ? error.message : String(error);
    project.provide("pgAdminUrl", null);
    project.provide("pgUrlTemplate", null);
    project.provide("pgUnavailableReason", reason);
    console.warn(
      `\n[pg] Real PostgreSQL unavailable — database integration tests will SKIP.\n[pg] Reason: ${reason}\n`
    );
  }

  return async () => {
    await cluster?.stop().catch(() => {});
    cluster = null;
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string | null;
    /** A connection string with `{db}` where the database name goes. */
    pgUrlTemplate: string | null;
    pgUnavailableReason: string | null;
  }
}
