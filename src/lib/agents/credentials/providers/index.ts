import { registerCredentialAdapter, resetCredentialAdapters } from "../registry";
import { createClaudeCredentialAdapter } from "./claude";

/**
 * Which providers TabDump can hold credentials for, and how to build each one.
 *
 * **The only provider-aware module in the credential layer.** The registry,
 * the store, the service, the resolver, the route and the settings UI all work
 * against whatever they are given; this file is the one place that names a
 * provider. Adding one is an adapter file and a line here.
 *
 * ## On the four that are absent
 *
 * Codex, Gemini, Grok and Custom have no registration, and that is the honest
 * state rather than an oversight. §20 asks that the registry be *capable* of
 * carrying them — it is, and `credentialSupportFor` answers `unsupported` for
 * each without a stub having to claim anything — and that TabDump not
 * implement fake credentials for providers that are not actually supported.
 *
 * Writing an adapter for one means knowing its real authentication mechanism
 * and having validated a real credential against it. None of those three has
 * been. A registration whose `validate` always succeeded would be exactly the
 * confident nonsense the connector layer's own catalog refuses to ship, with
 * the added property that it would hand a user a "Connected" badge for a
 * credential nothing ever checked.
 *
 * ## Idempotent
 *
 * `ensureCredentialAdapters` is called from the places that need a populated
 * registry rather than at module load, because a module-load side effect fires
 * in the browser bundle too, and this layer is server-only.
 */

let registered = false;

export function ensureCredentialAdapters(): void {
  if (registered) return;
  registerCredentialAdapter(createClaudeCredentialAdapter());
  registered = true;
}

/** Re-registers from scratch. For tests, so one suite's registry cannot leak into the next. */
export function resetCredentialRegistry(): void {
  resetCredentialAdapters();
  registered = false;
}

export { createClaudeCredentialAdapter };
export { ANTHROPIC_KEY_ENV_VAR } from "./claude";
