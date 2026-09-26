import "server-only";
import { isAgentPermissionScope } from "@/lib/agents/control/permissions";
import { mintSandboxName } from "./sandbox";
import { checkSandboxLimit } from "./store";
import { validateUpload } from "./upload";
import { REMOTE_LIMITS } from "./types";
import type { AgentPermissionScope } from "@/lib/agents/control/permissions";
import type { RemoteSandboxService } from "./sandbox";
import type { RemoteStore } from "./store";
import type { UploadEntry, UploadRejection } from "./upload";
import type { RemoteProject } from "./types";

/**
 * Creating, listing and destroying remote projects.
 *
 * ## Why this is a module and not a route handler
 *
 * The route is transport: it reads a body, identifies an actor, and returns
 * JSON. Everything that decides *whether a project may exist* — the
 * concurrency limit, the scope validation, the sandbox mint, the order in
 * which a row and a microVM come into being — lives here, where it can be
 * driven by tests with a fake platform and no database.
 *
 * ## The ordering, which is the only subtle part
 *
 * A project is a row *and* a sandbox, and either can fail. The order is:
 *
 *   1. check the limit,
 *   2. mint a name and write the row as `creating`,
 *   3. create the sandbox,
 *   4. write the files,
 *   5. mark the row `ready`.
 *
 * Row first, deliberately. The opposite order — sandbox first, then row —
 * loses a microVM whenever the write fails: it is running, it is billing, and
 * nothing in the system knows its name. Writing first means the worst case is
 * a row in `creating` that never became anything, which the sweep reclaims and
 * which a user can delete. A leaked row costs nothing; a leaked sandbox costs
 * money and cannot be found.
 */

export type CreateRemoteProjectInput = {
  ownerId: string;
  name: string;
  /** What the user authorized. Validated against the known scope set; unknown values refuse. */
  scopes: readonly string[];
  files: readonly UploadEntry[];
};

export type CreateRemoteProjectFailure =
  | { reason: "invalid-name" }
  | { reason: "invalid-scopes" }
  | { reason: "too-many-sandboxes" }
  | { reason: "upload-rejected"; detail: UploadRejection }
  | { reason: "sandbox-failed" };

export type CreateRemoteProjectResult =
  | { ok: true; project: RemoteProject; excluded: readonly string[] }
  | ({ ok: false } & CreateRemoteProjectFailure);

export type RemoteProjectServices = {
  store: RemoteStore;
  sandbox: RemoteSandboxService;
  now?: () => number;
  createId?: () => string;
};

const MAX_NAME_LENGTH = 120;

/** Hosts a remote sandbox may reach. Mirrors the runtime's list; deny-by-default everywhere else. */
const ALLOWED_EGRESS: readonly string[] = ["api.anthropic.com", "registry.npmjs.org"] as const;

export async function createRemoteProject(
  services: RemoteProjectServices,
  input: CreateRemoteProjectInput
): Promise<CreateRemoteProjectResult> {
  const now = services.now ?? (() => Date.now());
  const createId = services.createId ?? (() => crypto.randomUUID());

  const name = input.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) return { ok: false, reason: "invalid-name" };

  // Every scope must be one this build knows how to enforce. An unrecognised
  // string is refused rather than dropped: dropping would silently narrow a
  // grant the user thought they had made, and the first they would learn of
  // it is an agent refusing to do what they authorized.
  if (!input.scopes.every(isAgentPermissionScope)) return { ok: false, reason: "invalid-scopes" };
  const scopes = input.scopes as readonly AgentPermissionScope[];

  const overLimit = await checkSandboxLimit(services.store, input.ownerId);
  if (overLimit) return { ok: false, reason: "too-many-sandboxes" };

  // Validated before anything is created, so a bad upload costs nothing.
  const upload = validateUpload(input.files);
  if (!upload.ok) return { ok: false, reason: "upload-rejected", detail: upload.reason };

  const at = now();
  const project: RemoteProject = {
    id: `rp-${createId()}`,
    ownerId: input.ownerId,
    name,
    source: "remote_upload",
    sandboxName: mintSandboxName(createId),
    scopes,
    status: "creating",
    createdAt: at,
    updatedAt: at,
  };

  await services.store.createProject(project);

  const ensured = await services.sandbox.ensure({
    sandboxName: project.sandboxName,
    timeoutMs: REMOTE_LIMITS.sandboxTimeoutMs,
    allowedHosts: ALLOWED_EGRESS,
    tags: { app: "tabdump", project: project.id },
  });

  if (!ensured.ok) {
    await services.store.updateProject(input.ownerId, project.id, { status: "failed" }, now());
    return { ok: false, reason: "sandbox-failed" };
  }

  const written = await services.sandbox.writeWorkspace(project.sandboxName, upload.files);
  if (!written.ok) {
    await services.store.updateProject(input.ownerId, project.id, { status: "failed" }, now());
    return { ok: false, reason: "sandbox-failed" };
  }

  const ready = await services.store.updateProject(
    input.ownerId,
    project.id,
    {
      status: "ready",
      ...(ensured.value.expiresAt ? { expiresAt: ensured.value.expiresAt } : {}),
    },
    now()
  );

  return {
    ok: true,
    // The row as it now stands. Falling back to the pre-update value would
    // report `creating` for a project that is ready, and the UI would show a
    // spinner that never resolves.
    project: ready ?? project,
    excluded: upload.excluded,
  };
}

/**
 * Deletes a project and the sandbox behind it.
 *
 * Sandbox first here, which is the opposite of creation and for the same
 * reason: the thing that costs money should stop existing before the thing
 * that remembers it. A destroy that fails leaves the row, and the row is what
 * lets the sweep — or the user — try again.
 */
export async function deleteRemoteProject(
  services: RemoteProjectServices,
  ownerId: string,
  projectId: string
): Promise<boolean> {
  const project = await services.store.findProject(ownerId, projectId);
  if (!project) return false;

  await services.sandbox.destroy(project.sandboxName);
  return services.store.deleteProject(ownerId, projectId);
}

/* ------------------------------------------------------------------ *
 * Reclamation
 * ------------------------------------------------------------------ */

/** How many expired projects one sweep will reclaim. Bounded so a sweep cannot run long. */
const SWEEP_LIMIT = 20;

/**
 * Stops sandboxes whose deadline has passed.
 *
 * ## Why this exists even though the platform expires them anyway
 *
 * The platform reclaims the microVM; it does not update our rows. Without
 * this, a project whose sandbox died an hour ago still reads as `running`, the
 * per-owner concurrency limit still counts it, and a user who has hit the
 * limit cannot create a project because of three sandboxes that no longer
 * exist. The brief's "do not leave abandoned sandboxes running indefinitely"
 * has this second half to it: do not leave abandoned *records* either.
 *
 * Stops rather than destroys. A stopped sandbox snapshots its filesystem, so
 * the project's files survive and the next session resumes into them — which
 * is what makes a remote project a project rather than a single sitting.
 */
export async function sweepExpiredSandboxes(
  services: RemoteProjectServices,
  at: number = Date.now()
): Promise<number> {
  const expired = await services.store.findExpired(at, SWEEP_LIMIT);

  let reclaimed = 0;
  for (const entry of expired) {
    const stopped = await services.sandbox.stop(entry.sandboxName);
    // Marked `expired` rather than `stopped`, because the user did not ask.
    // The distinction changes what the UI says and whether resuming is a
    // surprise. A stop that failed leaves the row alone for the next sweep.
    if (!stopped.ok) continue;

    await services.store.updateProject(entry.ownerId, entry.projectId, { status: "expired" }, at);
    reclaimed += 1;
  }

  return reclaimed;
}
