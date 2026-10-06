import "server-only";
import { createProjectCheckRunner } from "./checks";
import { createProjectFileSystem } from "./files";
import type { ProjectHost } from "@/lib/agents/project/seam";

/**
 * This machine's access to its projects (Hubble 1.6), for a local runtime.
 * Built by the web's opted-in local server and by the desktop sidecar, and by
 * nothing else — `project-host/security.test.ts` pins the importers.
 */
export function createProjectHost(env: Readonly<Record<string, string | undefined>>): ProjectHost {
  return { files: createProjectFileSystem(), checks: createProjectCheckRunner({ env }) };
}
