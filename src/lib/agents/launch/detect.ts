import { PROVIDER_LAUNCH_TABLE } from "./allowlist";
import { isOnPath, resolveExecutable } from "./resolve";
import type { ResolverFs } from "./resolve";
import type { ProviderDetection } from "@/lib/agents/runtime/protocol";

/**
 * What is installed on this machine, answered without running anything and
 * without returning a single path.
 *
 * The result says, per provider: is it installed, and can Hubble drive it.
 * It does not say *where* — the UI has no use for a path and a hosted
 * deployment must never be able to render one.
 *
 * It does not say whether the agent is signed in, either. That question is
 * the agent's to answer, and it is asked of the agent when the user connects
 * it (Phase J.2) — never inferred from a file in someone's home directory.
 */

export type DetectOptions = {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  fs: ResolverFs;
};

export function detectProviders(options: DetectOptions): ProviderDetection[] {
  return PROVIDER_LAUNCH_TABLE.map((entry) => {
    const installed = entry.detect.some((name) => isOnPath(name, options));
    const launchable = entry.acp
      ? entry.acp.executables.some((name) =>
          Boolean(
            resolveExecutable(name, {
              ...options,
              ...(entry.acp?.npmPackages ? { npmPackages: entry.acp.npmPackages } : {}),
            })
          )
        )
      : false;

    return {
      provider: entry.provider,
      installed,
      transport: entry.acp ? ("acp" as const) : ("sdk" as const),
      launchable,
    };
  });
}
