import { normalizeUploadPath } from "@/lib/agents/remote/upload";
import { REMOTE_LIMITS } from "@/lib/agents/remote/types";
import type { AgentVisualTone } from "@/lib/agents/visual/types";
import type { RuntimeProviderStatus, RuntimeStatus } from "@/lib/agents/runtime/protocol";

/**
 * What the command centre needs to know about remote projects.
 *
 * ## Why this is a module and not logic in the dialog
 *
 * Same rule the rest of the command centre follows: **the UI restates backend
 * state, it never computes it.** Every function here is a total function over
 * a closed set, so a state added to the remote plane is a type error rather
 * than a silently unlabelled row — and every one of them is testable without
 * rendering anything.
 *
 * ## What the browser is allowed to know about a remote project
 *
 * Its id, its name, its source, its status and its deadline. Not its sandbox
 * name, not a path, not an owner. The API route already refuses to serialize
 * those; this type is the second statement of the same rule, in the place a
 * component would otherwise be tempted to reach for one.
 */

/** A remote project, exactly as the API is willing to describe one. */
export type RemoteProjectSummary = {
  id: string;
  name: string;
  source: string;
  scopes: readonly string[];
  status: string;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
};

/* ------------------------------------------------------------------ *
 * Execution mode
 * ------------------------------------------------------------------ */

export type ExecutionMode = "local" | "remote";

export const EXECUTION_MODE_LABEL: Record<ExecutionMode, string> = {
  local: "Local",
  remote: "Remote",
};

export const EXECUTION_MODE_DETAIL: Record<ExecutionMode, string> = {
  local: "Runs on this machine, in a folder you authorize.",
  remote: "Runs in an isolated environment Hubble creates. It cannot reach this computer.",
};

/**
 * The modes this runtime can actually execute in.
 *
 * ## Why this derives from the runtime and not from a build flag
 *
 * Because the honest answer is a server-side one. `status.environment` is the
 * projection of a gate that was taken once, from a real environment, before
 * any request arrived — and it is the only thing here that knows whether a
 * sandbox platform and a database are actually configured.
 *
 * The consequence the brief asks for falls straight out: a hosted deployment
 * reports `remote` and therefore never offers `local`, because it genuinely
 * cannot execute locally and offering it would produce a failure the user
 * could not have predicted. A local Hubble reports `local` and offers that.
 *
 * Returns empty when nothing can execute, which is what makes the dialog say
 * so rather than presenting a mode picker with no working options.
 */
export function availableModes(status: RuntimeStatus | null): readonly ExecutionMode[] {
  if (!status || !status.executable) return [];
  if (status.environment === "remote") return ["remote"];
  if (status.environment === "local") return ["local"];
  return [];
}

/* ------------------------------------------------------------------ *
 * Why a session cannot be started
 * ------------------------------------------------------------------ */

/**
 * The distinct reasons, kept distinct.
 *
 * The brief forbids collapsing these into "Agent unavailable", and the reason
 * is that each one has a different next step: an operator configures a
 * runtime, a user signs in a provider, a user creates a project, a user waits.
 * A single sentence covering all four tells nobody what to do.
 *
 * `null` means the session can be started.
 */
export type StartBlocker =
  | "runtime-unavailable"
  | "provider-unavailable"
  | "authentication-required"
  | "provider-cannot-start"
  | "no-project"
  | "project-not-ready"
  | "project-expired"
  | "project-failed";

export const START_BLOCKER_MESSAGE: Record<StartBlocker, string> = {
  "runtime-unavailable": "Hubble cannot run agents here.",
  "provider-unavailable": "That agent is not available on this runtime.",
  // Accurate about what is actually missing. It used to say "needs to be
  // signed in", which described an authorization Hubble never asks for; what
  // the user has to do is connect their own provider credentials. The Command
  // Centre pairs this sentence with a Connect action — see
  // `new-session-dialog.tsx`.
  "authentication-required":
    "This agent isn't connected yet — add your own provider credentials to run it.",
  "provider-cannot-start": "That agent cannot start sessions yet.",
  "no-project": "Choose a project for the agent to work in.",
  "project-not-ready": "That environment is still being created.",
  "project-expired": "That environment timed out. Starting a session will bring it back.",
  "project-failed": "That environment could not be created. Create the project again.",
};

export type StartGateInput = {
  status: RuntimeStatus | null;
  provider: RuntimeProviderStatus | undefined;
  mode: ExecutionMode | null;
  /** The chosen project, for whichever plane the mode names. */
  project: { status: string } | null;
};

/**
 * Whether Start may be pressed, and if not, precisely why.
 *
 * Ordered from broadest to narrowest so the sentence a user reads is about the
 * thing they would have to fix first. Nothing here is a second opinion: every
 * fact consulted was decided by the host, and pressing Start anyway would only
 * produce the same refusal with a worse message.
 */
export function startBlocker(input: StartGateInput): StartBlocker | null {
  if (!input.status || !input.status.executable || !input.mode) return "runtime-unavailable";

  const provider = input.provider;
  if (!provider || !provider.available) return "provider-unavailable";
  // Reported by the provider itself, and the one state it can actually prove
  // before a run starts. Since per-user credentials, this is *this user's*
  // answer rather than the deployment's: the host resolves an adapter per
  // actor, and an actor with no usable provider connection gets an adapter
  // whose runtime reports `credential-required`. See
  // `RuntimeProviderStatus.authentication` and `credentials/service.ts`.
  if (provider.authentication === "required") return "authentication-required";
  if (!provider.capabilities.includes("create_session")) return "provider-cannot-start";

  // A local session may legitimately have no project — an agent with no
  // filesystem scope is limited but real. A remote one may not: the project
  // *is* the sandbox.
  if (input.mode === "remote") {
    if (!input.project) return "no-project";
    if (input.project.status === "creating") return "project-not-ready";
    if (input.project.status === "failed") return "project-failed";
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Creating a project
 * ------------------------------------------------------------------ */

/**
 * Why a create attempt was refused, in one vocabulary.
 *
 * Covers both halves: what the browser noticed before sending, and what the
 * server answered. They share a vocabulary because a user does not care which
 * side refused — but the *server* remains authoritative, and the browser's
 * copy exists only to save a doomed 4MB upload.
 */
export type RemoteCreateFailure =
  | "invalid-name"
  | "invalid-scopes"
  | "too-many-sandboxes"
  | "upload-rejected"
  | "sandbox-failed"
  | "remote-unavailable"
  | "upload-too-large"
  | "too-many-files"
  | "no-files"
  | "unsafe-path"
  | "network";

export const REMOTE_CREATE_MESSAGE: Record<RemoteCreateFailure, string> = {
  "invalid-name": "Give the project a name.",
  "invalid-scopes": "Hubble did not recognise those permissions.",
  "too-many-sandboxes": "You already have the maximum number of remote projects.",
  "upload-rejected": "Some of those files could not be uploaded safely.",
  "sandbox-failed": "Hubble could not create the remote environment. Try again.",
  "remote-unavailable": "Remote agents are not configured on this deployment.",
  "upload-too-large": `That folder is larger than ${Math.round(
    REMOTE_LIMITS.maxUploadBytes / (1024 * 1024)
  )} MB.`,
  "too-many-files": `That folder has more than ${REMOTE_LIMITS.maxUploadFiles} files.`,
  "no-files": "Choose a folder with files in it.",
  "unsafe-path": "One of those file names can't be used. Choose a different folder.",
  network: "Hubble could not reach the server. Try again.",
};

export type UploadCandidate = { path: string; size: number };

export type UploadPrecheck =
  | { ok: true; files: number; bytes: number; excluded: number }
  | { ok: false; reason: RemoteCreateFailure };

/**
 * The browser's look at a folder before it spends a request on it.
 *
 * ## Why this is not "client-side validation"
 *
 * It does not authorize anything and it is not trusted. The server re-runs
 * `validateUpload` over the actual bytes and its answer is the one that
 * decides. This exists because the alternative is uploading four megabytes in
 * order to be told the folder was too big — and because a user who picked the
 * wrong directory should learn it immediately.
 *
 * It calls the *same* `normalizeUploadPath` the server uses rather than
 * reimplementing the rules, which is what stops the two from drifting into
 * disagreeing about what is safe. It deliberately does not reimplement the
 * exclusion list's consequences: it counts them so the user can be told what
 * will be left out, and the server decides what actually is.
 */
export function precheckUpload(candidates: readonly UploadCandidate[]): UploadPrecheck {
  if (candidates.length === 0) return { ok: false, reason: "no-files" };
  if (candidates.length > REMOTE_LIMITS.maxUploadFiles) {
    return { ok: false, reason: "too-many-files" };
  }

  let bytes = 0;
  let excluded = 0;
  let usable = 0;

  for (const candidate of candidates) {
    const normalized = normalizeUploadPath(candidate.path);
    // A path the shared validator refuses is refused here too, with the one
    // message that covers every shape of it. The server will say the same.
    if (!normalized.ok) return { ok: false, reason: "unsafe-path" };

    if (isLikelyExcluded(normalized.path)) {
      excluded += 1;
      continue;
    }

    bytes += candidate.size;
    if (bytes > REMOTE_LIMITS.maxUploadBytes) return { ok: false, reason: "upload-too-large" };
    usable += 1;
  }

  if (usable === 0) return { ok: false, reason: "no-files" };
  return { ok: true, files: usable, bytes, excluded };
}

/**
 * Whether a path will almost certainly be dropped by the server.
 *
 * "Almost certainly" is deliberate and is why this is a separate, privately
 * named function rather than an import of the server's list: this is a *count
 * for the user's benefit*, not a decision. If the two lists ever diverge the
 * consequence is a slightly wrong number in a hint, not a file uploaded that
 * should not have been — because the server drops it either way.
 */
function isLikelyExcluded(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  return segments.some(
    (segment) =>
      segment === "node_modules" ||
      segment === ".git" ||
      segment === ".next" ||
      segment === ".vercel" ||
      segment.startsWith(".env") ||
      segment === ".ssh" ||
      segment === ".aws" ||
      segment === ".npmrc" ||
      segment === ".netrc"
  );
}

/* ------------------------------------------------------------------ *
 * The connector page's control half
 * ------------------------------------------------------------------ */

/**
 * Whether Hubble can *drive* this provider, and where.
 *
 * ## Why this is not "does Hubble know this provider's name"
 *
 * The brief is explicit that a connector must not read "Available" merely
 * because the UI has a label for it, and this is the function that would
 * otherwise be tempted. Every answer below comes from the runtime's own
 * `get_status` reply: whether the gate allows execution, which plane it
 * allows, whether an adapter is registered, whether the provider has told us
 * it needs configuring, and what it declares it can do.
 *
 * `capabilities` is passed straight through rather than being described,
 * because the capability model already forbids claiming one that is not
 * implemented — so the honest list is the one the adapter returned.
 */
export type ControlAvailability =
  | { kind: "unavailable"; reason: string }
  | { kind: "authentication-required"; reason: string }
  | {
      kind: "available";
      environment: ExecutionMode;
      capabilities: readonly string[];
    };

export function controlAvailability(
  status: RuntimeStatus | null,
  providerId: string
): ControlAvailability {
  if (!status || !status.executable) {
    return {
      kind: "unavailable",
      reason: status?.detail ?? "Hubble cannot run agents here.",
    };
  }

  const environment = status.environment === "remote" ? "remote" : "local";
  const provider = status.providers.find((candidate) => candidate.provider === providerId);

  if (!provider || !provider.available) {
    return { kind: "unavailable", reason: "No adapter for this agent is registered here." };
  }

  // The one authentication state a provider can actually prove before a run
  // starts. Everything else is `unknown`, and reporting a guess as a fact is
  // what this whole type exists to avoid.
  if (provider.authentication === "required") {
    return {
      kind: "authentication-required",
      reason: "This agent needs credentials before it can run here.",
    };
  }

  if (!provider.capabilities.includes("create_session")) {
    return { kind: "unavailable", reason: "This agent cannot start sessions yet." };
  }

  return { kind: "available", environment, capabilities: provider.capabilities };
}

/** What each capability is called when a person reads it. Only the ones control uses. */
export const CONTROL_CAPABILITY_LABEL: Record<string, string> = {
  create_session: "Sessions",
  message: "Messages",
  stream_events: "Events",
  read_files: "Read files",
  write_files: "Change files",
  run_commands: "Commands",
  approvals: "Approvals",
  cancel_run: "Cancel",
  resume_session: "Resume",
  working_directory: "Project scope",
  additional_directories: "Extra folders",
};

/* ------------------------------------------------------------------ *
 * Describing a project
 * ------------------------------------------------------------------ */

export const REMOTE_SOURCE_LABEL: Record<string, string> = {
  remote_upload: "Uploaded",
  remote_git: "Repository",
};

export function remoteSourceLabel(source: string): string {
  return REMOTE_SOURCE_LABEL[source] ?? source;
}

/** A project's line in the selector: what it is, and what it is doing. */
export type RemoteProjectPresentation = {
  name: string;
  source: string;
  status: string;
  tone: AgentVisualTone;
  /** Whether a session may be started against it. */
  startable: boolean;
};

/**
 * Formats the remaining life of a sandbox, when it has one.
 *
 * Coarse on purpose. A countdown to the second would invite a user to watch
 * it, and the number is approximate anyway — the platform's deadline moves
 * when a session extends it.
 */
export function expiresInLabel(expiresAt: number | undefined, now: number): string | null {
  if (!expiresAt) return null;
  const remaining = expiresAt - now;
  if (remaining <= 0) return "Expired";

  // Measured against the raw remaining time rather than against a rounded
  // minute count: `Math.round` sends 30 seconds to 1, which would leave the
  // sub-minute case reachable only below 30s and tell someone with half a
  // minute left that they have a whole one.
  if (remaining < 60_000) return "Expires in under a minute";

  const minutes = Math.round(remaining / 60_000);
  if (minutes === 1) return "Expires in 1 minute";
  if (minutes < 60) return `Expires in ${minutes} minutes`;

  const hours = Math.round(minutes / 60);
  return hours === 1 ? "Expires in about an hour" : `Expires in about ${hours} hours`;
}
