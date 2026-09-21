import {
  decideServerRuntime,
  denyNonServerRuntime,
  describeRuntimeDenial,
} from "@/lib/agents/control/runtime";
import { runtimeFailure } from "./protocol";
import type { RuntimeDecision, RuntimeEnvironment } from "@/lib/agents/control/runtime";
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
 */
export type ExecutionGateResult =
  | { allowed: true; kind: RuntimeEnvironmentKind; decision: RuntimeDecision }
  | { allowed: false; kind: RuntimeEnvironmentKind; decision: RuntimeDecision; detail: string };

/**
 * Projects a runtime decision into the four environments a UI reasons about.
 *
 * `local-desktop` and `local-server` both read as `local`: the difference is
 * about which transport reached the runtime, and a client asking "can I use
 * this" does not care. `unknown` stays distinct from `hosted` even though
 * they behave identically, because telling a developer who forgot the opt-in
 * that they are on a hosted platform would be false.
 */
export function environmentKindOf(decision: RuntimeDecision): RuntimeEnvironmentKind {
  if (decision.allowed) return "local";
  switch (decision.kind) {
    case "hosted":
      return "hosted";
    case "local-desktop":
    case "local-server":
      // Unreachable in practice - a local kind with `allowed: false` is not a
      // shape the decision produces - but the projection must be total, and
      // "unknown" is the fail-closed reading of a decision we cannot explain.
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
 */
export function assertLocalExecutionAllowed(env: RuntimeEnvironment): ExecutionGateResult {
  return describe(decideServerRuntime(env));
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
  if (decision.allowed) return { allowed: true, kind, decision };

  return {
    allowed: false,
    kind,
    decision,
    // From the fixed table in the decision module. Never interpolated, and in
    // particular never naming the environment variable that would enable it:
    // that sentence would then be renderable by a hosted deployment.
    detail: describeRuntimeDenial(decision) ?? "TabDump cannot run agents here.",
  };
}

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
