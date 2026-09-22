import {
  allowRemoteRuntime,
  decideRemoteRuntime,
  decideServerRuntime,
  denyNonServerRuntime,
  denyRemoteRuntime,
  describeRemoteDenial,
  describeRuntimeDenial,
  executionEnvironmentOf,
} from "@/lib/agents/control/runtime";
import { runtimeFailure } from "./protocol";
import type {
  ExecutionEnvironment,
  RemoteDenialReason,
  RemoteRuntimeDecision,
  RuntimeDecision,
  RuntimeEnvironment,
} from "@/lib/agents/control/runtime";
import type { RuntimeEnvironmentKind, RuntimeResult } from "./protocol";

/**
 * The execution gate.
 *
 * ## One boundary, not one per provider
 *
 * The brief's requirement is that there be exactly *one* place that answers
 * "may a provider be executed here", and that no adapter reinvent it with an
 * `isVercel()` of its own. This module is that place, and it is deliberately
 * thin: the *decision* already lives in `lib/agents/control/runtime.ts`, which
 * was written for Phase B and needs no change. What was missing was a single
 * entry point that every execution path is obliged to cross, and a projection
 * of the answer that a UI can read.
 *
 * So: `decideServerRuntime` decides, `assertLocalExecutionAllowed` is the
 * gate, and `environmentKindOf` is the projection. Nothing else in the
 * codebase calls `decideServerRuntime`, and the guard suite asserts it.
 *
 * ## What this does not do
 *
 * It does not sniff. It reads an environment it is *handed*, exactly as the
 * decision below it does, so there is no global for a bundle to shim and no
 * header for a client to forge. A caller that cannot supply a real server
 * environment cannot obtain an allowing decision - which is the browser's
 * situation, permanently.
 *
 * It also does not consider the *request*. Whether this process may execute
 * agents is a property of the machine, settled before any request arrives;
 * whether a particular request may drive a particular session is ownership,
 * and belongs to ./host.ts. Folding the two together is how a
 * `Host: localhost` check ends up being load-bearing.
 */

/**
 * The gate's answer, in the runtime module's own vocabulary.
 *
 * Carries the underlying `RuntimeDecision` so a caller that needs the finer
 * distinction - `local-desktop` versus `local-server` - can have it without a
 * second call, and so nothing has to re-derive it from the projection.
 *
 * `environment` is present only on the allowing branch, and that is the type
 * doing a job: there is no such thing as "refused, remotely". A caller that
 * has an environment has been permitted, and a caller that has been permitted
 * knows which plane it was permitted on.
 */
export type ExecutionGateResult =
  | {
      allowed: true;
      environment: ExecutionEnvironment;
      kind: RuntimeEnvironmentKind;
      decision: RuntimeDecision;
    }
  | { allowed: false; kind: RuntimeEnvironmentKind; decision: RuntimeDecision; detail: string };

/**
 * Projects a runtime decision into the environments a UI reasons about.
 *
 * `local-desktop` and `local-server` both read as `local`: the difference is
 * about which transport reached the runtime, and a client asking "can I use
 * this" does not care. `remote-sandbox` reads as `remote` and never as
 * `local`, because that distinction is the one the user is actually owed.
 * `unknown` stays distinct from `hosted` even though they behave identically,
 * because telling a developer who forgot the opt-in that they are on a hosted
 * platform would be false.
 */
export function environmentKindOf(decision: RuntimeDecision): RuntimeEnvironmentKind {
  if (decision.allowed) return decision.kind === "remote-sandbox" ? "remote" : "local";
  switch (decision.kind) {
    case "hosted":
      return "hosted";
    case "local-desktop":
    case "local-server":
    case "remote-sandbox":
      // Unreachable in practice - an executing kind with `allowed: false` is
      // not a shape the decision produces - but the projection must be total,
      // and "unknown" is the fail-closed reading of a decision we cannot
      // explain.
      return "unknown";
    case "unknown":
      return decision.reason === "no-server-context" ? "browser" : "unknown";
  }
}

/**
 * The gate, for a context that has a real server environment.
 *
 * Every provider execution path in TabDump crosses this function. It takes
 * the environment rather than reading one, which is what makes it a pure
 * function the security suite can drive through every branch.
 *
 * Local only. Kept as its own export because it is what the *local* story
 * has always meant and what its tests drive; `assertExecutionAllowed` is the
 * entry point that considers both planes.
 */
export function assertLocalExecutionAllowed(env: RuntimeEnvironment): ExecutionGateResult {
  return describe(decideServerRuntime(env));
}

/**
 * The gate, considering both planes.
 *
 * ## Why local is asked first, and why that is not a preference
 *
 * If this process is genuinely somebody's own machine, the project they
 * authorized is on that machine and a remote sandbox could not reach it. So
 * the order is not "local is better" — it is that the two answer for
 * different projects, and a process that can execute locally is one where
 * the local answer is the only one that could be acted on.
 *
 * ## Why there is no fallback edge
 *
 * A *refused* local gate does not become a remote session for the same
 * request. The environment settles here, once, before any command is parsed;
 * a session created in one plane lives and dies in it. The brief's "never
 * silently fall back to local execution" is the same rule read the other way
 * round, and it holds in both directions because the gate is a constructor
 * argument rather than a per-command choice.
 *
 * A deployment that can do neither gets the *remote* refusal sentence when a
 * remote credential was the thing it was missing, and the local one
 * otherwise — so an operator is told which piece of configuration is absent
 * rather than a generic no.
 */
export function assertExecutionAllowed(
  env: RuntimeEnvironment,
  input: { durableStore: boolean }
): ExecutionGateResult {
  const local = decideServerRuntime(env);
  if (local.allowed) return describe(local);

  const remote = decideRemoteRuntime(env, input);
  if (remote.allowed) return describe(allowRemoteRuntime());

  // Neither plane. Which refusal to show is a judgement about what the
  // operator most likely meant, and the tiebreak is deliberate: a machine
  // showing hosted markers was never going to execute locally, so telling its
  // operator to "run TabDump on your own machine" would be advice they cannot
  // take. They are told what the remote plane is missing instead.
  return local.kind === "hosted" ? describeRemote(remote) : describe(local);
}

/**
 * A remote refusal, for a caller that has discovered one *after* the gate.
 *
 * The gate decides from the environment, which is all it can see. A caller
 * that then fails to build the infrastructure the decision assumed — a store
 * that would not construct, a platform client that will not load — has learned
 * something the gate could not, and needs a way to say so in the gate's own
 * vocabulary.
 *
 * Exported so that discovery cannot instead be expressed as "carry on with a
 * host that has no adapter", which is the shape that produces a runtime
 * reporting `executable: true` and refusing every command.
 */
export function denyRemoteExecution(reason: RemoteDenialReason): ExecutionGateResult {
  return describeRemote({ allowed: false, reason });
}

function describeRemote(decision: RemoteRuntimeDecision): ExecutionGateResult {
  const refused = denyRemoteRuntime(decision.allowed ? "no-sandbox-credentials" : decision.reason);
  return {
    allowed: false,
    kind: environmentKindOf(refused),
    decision: refused,
    detail:
      describeRemoteDenial(decision) ?? "TabDump cannot run agents here.",
  };
}

/**
 * The gate, for a context that is not a server at all.
 *
 * A browser bundle, a static export, a prerender. There is no environment to
 * consult, so the answer is a flat refusal with its own reason - which is why
 * a UI can say "this build cannot run agents" rather than "you have not
 * configured it".
 */
export function denyLocalExecution(): ExecutionGateResult {
  return describe(denyNonServerRuntime());
}

function describe(decision: RuntimeDecision): ExecutionGateResult {
  const kind = environmentKindOf(decision);
  if (decision.allowed) {
    // Non-null for every kind the allowing branch can carry. Falling back to
    // `local` rather than asserting would be the one wrong direction here —
    // it would describe a remote session as touching the user's machine — so
    // an unexplainable allow is refused instead.
    const environment = executionEnvironmentOf(decision.kind);
    if (!environment) return { allowed: false, kind: "unknown", decision, detail: FALLBACK_DETAIL };
    return { allowed: true, environment, kind, decision };
  }

  return {
    allowed: false,
    kind,
    decision,
    // From the fixed table in the decision module. Never interpolated, and in
    // particular never naming the environment variable that would enable it:
    // that sentence would then be renderable by a hosted deployment.
    detail: describeRuntimeDenial(decision) ?? FALLBACK_DETAIL,
  };
}

/** The sentence for a refusal nothing else explained. Fixed text, like every other. */
const FALLBACK_DETAIL = "TabDump cannot run agents here.";

/**
 * The failure a refused gate produces.
 *
 * One mapping, so a refusal cannot be reported as `provider_unavailable` in
 * one place and `runtime_unavailable` in another - the difference matters to
 * a user deciding whether to install something or to move machines. The
 * `detail` is deliberately *not* carried into it: the gate's sentence is for
 * the status object, where it appears once beside the environment that
 * produced it, not repeated onto every refused command.
 */
export function gateFailure<T = never>(): RuntimeResult<T> {
  return runtimeFailure<T>("runtime_unavailable");
}
