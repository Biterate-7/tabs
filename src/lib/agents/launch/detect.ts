import nodePath from "node:path";
import { PROVIDER_LAUNCH_TABLE } from "./allowlist";
import { isOnPath, resolveExecutable } from "./resolve";
import type { ResolverFs } from "./resolve";
import type { ProviderDetection } from "@/lib/agents/runtime/protocol";

/**
 * What is installed on this machine, answered without running anything and
 * without returning a single path.
 *
 * The result says, per provider: is it installed, can TabDump drive it, and
 * does a sign-in marker exist. It does not say *where* — the UI has no use
 * for a path and a hosted deployment must never be able to render one — and
 * it never opens a marker file, so nothing of a credential is read.
 */

export type DetectOptions = {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homeDirectory: string | undefined;
  fs: ResolverFs;
};

export function detectProviders(options: DetectOptions): ProviderDetection[] {
  const path = options.platform === "win32" ? nodePath.win32 : nodePath.posix;

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
    const signedIn =
      options.homeDirectory !== undefined &&
      entry.signInMarkers.some((marker) =>
        options.fs.isFile(path.join(options.homeDirectory!, ...marker.split("/")))
      );

    return {
      provider: entry.provider,
      installed,
      transport: entry.acp ? ("acp" as const) : ("sdk" as const),
      launchable,
      // Presence proves a sign-in happened. Absence proves nothing.
      signIn: signedIn ? ("signed_in" as const) : ("unknown" as const),
    };
  });
}
