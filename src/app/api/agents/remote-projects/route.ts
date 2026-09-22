import "server-only";
import { getSession } from "@/lib/auth/session";
import { hasJsonContentType, isSameOrigin } from "@/lib/auth/origin";
import { LOCAL_ACTOR } from "@/lib/agents/runtime/host";
import { createRemoteProject, deleteRemoteProject } from "@/lib/agents/remote/projects";
import { getRemoteServices } from "@/lib/agents/remote/services";
import { REMOTE_LIMITS } from "@/lib/agents/remote/types";
import { UPLOAD_REJECTION_MESSAGES } from "@/lib/agents/remote/upload";
import type { UploadEntry } from "@/lib/agents/remote/upload";
import type { RuntimeActor } from "@/lib/agents/runtime/host";

export const runtime = "nodejs";

/**
 * Remote projects.
 *
 * ## Why this is a separate route from the control plane
 *
 * `/api/agents/control` carries one closed union of fourteen verbs, none of
 * which can name a path, a command or a file. Creating a remote project is the
 * one operation that genuinely has to accept *file contents* — so it lives
 * here, on its own resource, rather than as a fifteenth command that would
 * have widened that union's vocabulary to include bytes.
 *
 * Keeping them apart means the control protocol's guard tests continue to
 * assert what they always did, and the upload's own rules are tested against
 * the one endpoint that has them.
 *
 * ## What the browser may say
 *
 * A name, a set of permission scopes, and files. That is all.
 *
 * It may **not** name a sandbox, a path inside one, a project id, an owner, a
 * command, an image, a region, a timeout or an egress host. Every one of those
 * is either a constant in this codebase or minted server-side, and there is no
 * field here that would carry one. Relative file paths are the single
 * caller-supplied path-like value, and `upload.ts` rebuilds each from
 * validated segments before it can reach a filesystem.
 *
 * ## Ownership
 *
 * Resolved from the request, exactly as the control route does, and never read
 * from the body. Every store call below is scoped to it in its signature.
 */

/** The form fields this endpoint reads. Anything else in the body is ignored, not forwarded. */
const FIELD_NAME = "name";
const FIELD_SCOPES = "scopes";
const FIELD_FILES = "files";

/**
 * Multipart rather than JSON.
 *
 * Base64 in a JSON body would inflate an upload by a third, and a serverless
 * request body is capped at roughly 4.5MB — so a quarter of the budget would
 * be spent on encoding. See `REMOTE_LIMITS.maxUploadBytes`.
 */
const MULTIPART = "multipart/form-data";

export async function POST(request: Request): Promise<Response> {
  // Same-origin only. The cross-site case is the real browser-borne threat:
  // a page the user visits could otherwise `fetch` here and create a project
  // — and a sandbox — on their account. A multipart post *is* reachable from
  // a cross-site form, so the origin check is doing the whole job here rather
  // than being backed up by a content type a form cannot set.
  if (!isSameOrigin(request)) return refuse("invalid-request", 403);

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith(MULTIPART)) {
    return refuse("invalid-request", 400);
  }

  const services = await getRemoteServices();
  if (!services) return refuse("remote-unavailable", 503);

  const actor = await resolveActor(request);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse("invalid-request", 400);
  }

  const name = form.get(FIELD_NAME);
  if (typeof name !== "string") return refuse("invalid-name", 400);

  const rawScopes = form.get(FIELD_SCOPES);
  // A comma-separated list rather than repeated fields, so the shape is the
  // same whether one scope was chosen or five. Validated in `projects.ts`
  // against the known set; an unrecognised value refuses rather than being
  // dropped.
  const scopes =
    typeof rawScopes === "string" && rawScopes.trim()
      ? rawScopes.split(",").map((scope) => scope.trim()).filter(Boolean)
      : [];

  const entries: UploadEntry[] = [];
  let total = 0;

  for (const value of form.getAll(FIELD_FILES)) {
    if (typeof value === "string") return refuse("invalid-request", 400);

    // Counted as we go, so an oversized upload is refused before the whole of
    // it is held in memory.
    total += value.size;
    if (total > REMOTE_LIMITS.maxUploadBytes) return refuse("upload-too-large", 413);
    if (entries.length >= REMOTE_LIMITS.maxUploadFiles) return refuse("too-many-files", 413);

    entries.push({
      // `webkitRelativePath` is what a directory picker supplies and is the
      // only reason a file has a path at all. It is a caller-supplied string
      // and is treated as one — `validateUpload` rebuilds it from validated
      // segments and refuses anything it cannot.
      path: relativePathOf(value),
      content: new Uint8Array(await value.arrayBuffer()),
    });
  }

  const created = await createRemoteProject(services, {
    ownerId: actor.id,
    name,
    scopes,
    files: entries,
  });

  if (!created.ok) {
    const status = created.reason === "too-many-sandboxes" ? 429 : 400;
    const detail =
      created.reason === "upload-rejected"
        ? UPLOAD_REJECTION_MESSAGES[created.detail]
        : FAILURE_MESSAGES[created.reason];
    return Response.json({ ok: false, error: { code: created.reason, message: detail } }, { status });
  }

  // Note what is absent from this reply: the sandbox name. It is the handle
  // that addresses a running microVM, it is minted server-side, and there is
  // no field on this response that could carry one.
  return Response.json({
    ok: true,
    value: {
      id: created.project.id,
      name: created.project.name,
      source: created.project.source,
      scopes: created.project.scopes,
      status: created.project.status,
      ...(created.project.expiresAt ? { expiresAt: created.project.expiresAt } : {}),
      createdAt: created.project.createdAt,
      excluded: created.excluded,
    },
  });
}

/** The caller's remote projects. Never anybody else's — the store query is owner-scoped. */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return refuse("invalid-request", 403);

  const services = await getRemoteServices();
  if (!services) return refuse("remote-unavailable", 503);

  const actor = await resolveActor(request);
  const projects = await services.store.listProjects(actor.id);

  return Response.json({
    ok: true,
    value: {
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        source: project.source,
        scopes: project.scopes,
        status: project.status,
        ...(project.expiresAt ? { expiresAt: project.expiresAt } : {}),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })),
    },
  });
}

export async function DELETE(request: Request): Promise<Response> {
  if (!isSameOrigin(request) || !hasJsonContentType(request)) {
    return refuse("invalid-request", 403);
  }

  const services = await getRemoteServices();
  if (!services) return refuse("remote-unavailable", 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse("invalid-request", 400);
  }

  const projectId = (body as { projectId?: unknown } | null)?.projectId;
  if (typeof projectId !== "string" || !projectId) return refuse("invalid-request", 400);

  const actor = await resolveActor(request);
  // Owner-scoped in the store. Another account's project id is
  // indistinguishable from one that does not exist, which is the answer a
  // probe should get.
  const deleted = await deleteRemoteProject(services, actor.id, projectId);

  return deleted ? Response.json({ ok: true, value: { projectId } }) : refuse("not-found", 404);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * The path a browser gave a file.
 *
 * A directory picker sets `webkitRelativePath`; a plain file picker does not,
 * and then the name is the path. Both are caller-supplied and neither is
 * trusted here — this only chooses which string to hand to the validator.
 */
function relativePathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return typeof relative === "string" && relative ? relative : file.name;
}

const FAILURE_MESSAGES: Record<string, string> = {
  "invalid-name": "Give the project a name.",
  "invalid-scopes": "TabDump did not recognise those permissions.",
  "too-many-sandboxes": "You already have the maximum number of remote projects running.",
  "sandbox-failed": "TabDump could not create the remote environment.",
  "remote-unavailable": "Remote agents are not available on this deployment.",
  "upload-too-large": "That upload is too big.",
  "too-many-files": "That's more files than a project upload can carry.",
  "invalid-request": "TabDump could not read that request.",
  "not-found": "That project no longer exists.",
};

/** One fixed sentence per code. Nothing is interpolated from a request or a platform. */
function refuse(code: string, status: number): Response {
  return Response.json(
    { ok: false, error: { code, message: FAILURE_MESSAGES[code] ?? "TabDump could not do that." } },
    { status }
  );
}

/**
 * Who this request is from.
 *
 * The signed-in account on a deployment with accounts; the anonymous local
 * actor otherwise. Never read from the body — a request cannot name its own
 * owner, which is why there is no field for one.
 */
async function resolveActor(request: Request): Promise<RuntimeActor> {
  const session = await getSession(request);
  return session.ok ? { id: `account:${session.auth.user.id}` } : LOCAL_ACTOR;
}
